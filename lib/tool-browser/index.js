/**
 * Model-facing browser tools over `ctx.browser`: `browser_open`,
 * `browser_snapshot`, `browser_execute`, `browser_content`,
 * `browser_screenshot`, and tab management (`browser_list_tabs`,
 * `browser_switch_tab`, `browser_close_tab`, `browser_reset`).
 *
 * The tool layer owns only the model-facing schema, argument validation, and
 * result formatting — never provider selection or page driving, which belong
 * to the seam. Session lifecycle is owned here at the plugin level: each
 * calling task (a DSH session) gets its own browser session — the first
 * `browser_open` (or any tool when no session exists) opens it, and later
 * tools in the same task reuse it. Concurrent tasks therefore never fight
 * over tabs, history, or navigation state.
 * @module dsh-browser-plus/tool-browser
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
/** Plugin name used by loader diagnostics. */
export const name = 'tool-browser';
/** The tool registry, browser seam, and system-prompt registry this tool layer consumes. */
export const inject = ['tools', 'browser', 'systemPrompt'];
/** Per-task browser sessions, keyed by the calling DSH session id. */
const sessionsByTask = new Map();
/** In-flight first-open per task key, so concurrent first calls share one session. */
const pendingOpens = new Map();
/**
 * Tail promise for queued operations in one browser task. Entries are dropped
 * as soon as a queue drains (see {@link queueTaskOperation}), so this stays
 * bounded by the number of tasks with work in flight instead of growing one
 * permanent entry per task key.
 */
const operationTails = new Map();
/** In-flight identical read requests, keyed by task and canonical request shape. */
const pendingReads = new Map();
/**
 * Queue one operation after prior work for the same task (per-task FIFO).
 *
 * Both page-changing actions and read-only operations go through here, so a
 * read issued while a navigation is in flight resolves against the post-write
 * page instead of racing it. The entry is removed once its queue is idle: the
 * identity check means a newer operation that already chained onto this tail
 * keeps its ordering, because the map no longer points at this tail.
 */
function queueTaskOperation(key, operation) {
    const prior = operationTails.get(key) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    operationTails.set(key, tail);
    void tail.then(() => {
        if (operationTails.get(key) === tail)
            operationTails.delete(key);
    });
    return result;
}
/** Keep one identical read in flight per task instead of repeating CDP work. */
function coalesceTaskRead(key, readKey, operation) {
    const cacheKey = key + '\u0000' + readKey;
    const existing = pendingReads.get(cacheKey);
    if (existing !== undefined)
        return existing;
    const result = operation().finally(() => pendingReads.delete(cacheKey));
    pendingReads.set(cacheKey, result);
    return result;
}
/** True when the provider no longer knows the cached session id. */
function isUnknownSession(error) {
    return error instanceof Error && error.code === 'BROWSER_SESSION_UNKNOWN';
}
/**
 * Run one operation against the task's session, reopening it once when the
 * provider has forgotten the cached id — for example when the browser row
 * reloaded and the tool layer still holds a session from the previous provider.
 * Without this the task fails on every later call until someone happens to run
 * browser_reset_session.
 */
async function withRecoveredSession(browser, key, run) {
    try {
        return await run(await ensureSession(browser, key));
    }
    catch (error) {
        if (!isUnknownSession(error))
            throw error;
        sessionsByTask.delete(key);
        return run(await ensureSession(browser, key));
    }
}
/** Run a page-changing action with visible task status and FIFO ordering. */
async function withTaskAction(browser, key, action, exec, operation, label) {
    await ensureSession(browser, key, label);
    return queueTaskOperation(key, () => withRecoveredSession(browser, key, async (session) => {
        const task = await browser.getTask(session);
        if (task.control === 'human') {
            await browser.updateTask(session, { status: 'waiting-user', latestAction: 'waiting for user' });
            throw new Error('browser action is paused while the human controls this task');
        }
        await browser.updateTask(session, { status: 'running', latestAction: action });
        try {
            const result = await operation(session);
            const current = await browser.getTask(session).catch(() => undefined);
            await browser.updateTask(session, current?.control === 'human'
                ? { status: 'waiting-user', latestAction: 'waiting for user' }
                : { status: 'idle', latestAction: action });
            return result;
        }
        catch (error) {
            const message = String(error);
            const current = await browser.getTask(session).catch(() => undefined);
            await browser.updateTask(session, current?.control === 'human'
                ? { status: 'waiting-user', latestAction: 'waiting for user' }
                : { status: 'failed', latestAction: action, error: message });
            throw error;
        }
    }));
}
/**
 * Run and coalesce a read-only operation for the current task.
 *
 * The read joins the task's FIFO queue, so a read issued while a write is in
 * flight (e.g. browser_open + browser_snapshot, both marked concurrency-safe)
 * resolves against the post-write page instead of racing the navigation.
 *
 * Dedup deliberately wraps the queue: if the queue wrapped the dedup, a second
 * identical read would start only after the first settled, miss the in-flight
 * entry, and issue a second CDP call. The queued closure never re-enters the
 * queue, so this cannot deadlock.
 */
async function withTaskRead(browser, key, readKey, operation) {
    await ensureSession(browser, key);
    return coalesceTaskRead(key, readKey, () => queueTaskOperation(key, () => withRecoveredSession(browser, key, operation)));
}
/**
 * Per-task action restriction. `browser_restrict` writes an entry keyed by the
 * calling task, so one task's allow-list never restricts another task's tools.
 * An entry holding an empty array means that task explicitly lifted the
 * restriction — distinct from having no entry at all, which inherits the
 * plugin-level default.
 */
const restrictedToByTask = new Map();
/** Plugin-level default from config; applies to tasks that set no rule of their own. */
let defaultRestriction;
/** The allow-list in force for one task, or undefined when unrestricted. */
function restrictionFor(key) {
    const explicit = restrictedToByTask.get(key);
    if (explicit === undefined)
        return defaultRestriction;
    return explicit.length === 0 ? undefined : explicit;
}
/**
 * Guard one browser tool call against the calling task's restriction. Refuses
 * calls that are not on that task's allow-list when a restriction is in effect.
 * @param toolName - the browser tool about to run.
 * @param exec - the tool-execution context; only its agent id (task key) is read.
 */
function assertAllowed(toolName, exec) {
    const restrictedTo = restrictionFor(taskKey(exec));
    if (restrictedTo === undefined)
        return;
    if (restrictedTo.includes(toolName))
        return;
    throw new Error(`browser action "${toolName}" is restricted for this task (allow-list: ${restrictedTo.join(', ')})`);
}
/**
 * The task key for a tool call: the calling DSH session id, or the shared
 * default key when the call carries no agent context (CLI probes, tests).
 * @param exec - the tool-execution context; only its optional agent id is read.
 */
function taskKey(exec) {
    return exec?.agent?.id ?? 'default';
}
/**
 * Resolve the calling task's browser session, opening one on first use.
 * The Provider also recovers a keyed session if this tool-layer cache was lost.
 * Concurrent first calls for the same key share a single open.
 * @param browser - the seam service.
 * @param key - the task key (see {@link taskKey}).
 * @param label - optional space name applied when the session is first opened.
 * @returns the task's session id.
 */
async function ensureSession(browser, key, label) {
    const existing = sessionsByTask.get(key);
    if (existing !== undefined)
        return existing;
    const pending = pendingOpens.get(key);
    if (pending !== undefined)
        return pending;
    const opening = browser.open({
        key,
        ...label !== undefined && label !== '' ? { label } : {},
    }).then(session => { sessionsByTask.set(key, session); pendingOpens.delete(key); return session; }, error => { pendingOpens.delete(key); throw error; });
    pendingOpens.set(key, opening);
    return opening;
}
/** Coerce a tool-provided string value back to boolean/number only when lossless. */
function parseFillValue(v) {
    if (v === 'true')
        return true;
    if (v === 'false')
        return false;
    if (v !== undefined && /^-?\d+(\.\d+)?$/.test(v) && String(Number(v)) === v)
        return Number(v);
    return v ?? '';
}
/** Longest string kept in one history row handed to the model. */
const HISTORY_OUTPUT_MAX_CHARS = 500;
/**
 * A shallow, bounded copy of one entry's params. The previous deep clone
 * (JSON.parse(JSON.stringify(...))) copied every stored script and typed text in
 * full on every browser_history call, and the row is only ever rendered.
 */
function summarizeHistoryParams(params) {
    const out = {};
    for (const [key, value] of Object.entries(params)) {
        // Dropping undefined keeps the row lossless-JSON, which the deep clone used
        // to guarantee.
        if (value === undefined)
            continue;
        out[key] = typeof value === 'string' && value.length > HISTORY_OUTPUT_MAX_CHARS
            ? `${value.slice(0, HISTORY_OUTPUT_MAX_CHARS)}…(${value.length - HISTORY_OUTPUT_MAX_CHARS} more)`
            : value;
    }
    return out;
}
/** Format a snapshot element list for the model. */
function formatSnapshot(snapshot) {
    const lines = snapshot.elements.map(el => `[${el.ref}] ${el.kind}: ${el.label} (${el.x},${el.y}) loc=${el.loc}`);
    const header = `URL: ${snapshot.url}${snapshot.title !== undefined ? `\nTitle: ${snapshot.title}` : ''}${snapshot.snapshotId !== undefined ? `\nSnapshot: ${snapshot.snapshotId}` : ''}`;
    const body = lines.length > 0 ? lines.join('\n') : '(no interactive elements found)';
    const tail = snapshot.truncated === true ? '\n(snapshot truncated)' : '';
    const banner = snapshot.challenge?.blocked === true
        ? `\n\nCHALLENGE: ${snapshot.challenge.reason ?? 'human-verification'}. Do NOT keep retrying — ask the human to complete it in the shared browser window, then re-snapshot.`
        : '';
    const user = snapshot.userControlling === true
        ? '\n\nUSER CONTROL: the human is using this page. Do not operate the browser until they hand it back.'
        : '';
    return `${header}\n\n${body}${tail}${banner}${user}`;
}
/** Register all browser tools with `ctx.tools`. */
export function apply(ctx, config = {}) {
    const timeoutMs = config.timeoutMs ?? 60_000;
    /**
     * A caller-supplied budget is capped below the tool's own deadline, so the
     * provider reports a clean timeout instead of the runtime aborting the call.
     */
    const withinToolBudget = (requested, fallback) => Math.min(requested ?? fallback, Math.max(timeoutMs - 5_000, 1_000));
    // Re-apply clears task-scoped rules and re-seeds the plugin-level default;
    // an omitted allowedActions lifts the default.
    restrictedToByTask.clear();
    defaultRestriction = config.allowedActions !== undefined ? [...config.allowedActions] : undefined;
    ctx.systemPrompt.section({
        name: 'tool:browser',
        // Tool guidance band is 100-199; 150 keeps clear of the common 110/120
        // tool sections so ordering does not depend on plugin load sequence.
        order: 150,
        text: 'Use the browser_* tools to operate a real shared browser the human can see and take over. Start with browser_snapshot, then use browser_click_ref or browser_scroll_into_view with its snapshotId and reference number whenever possible; re-snapshot if a reference is stale. Use browser_fill for forms and browser_back/browser_forward/browser_reload/browser_stop/browser_scroll for normal browser controls before resorting to browser_execute. browser_screenshot is for visual confirmation, not primary targeting. Keep the human informed of what you are doing on the page. Each task gets its own browser session: tabs and history are isolated from other tasks. browser_handoff state="waiting-user" marks a task for human action; do not operate page-changing tools while the user owns the task. If a snapshot or browser_challenge reports a CAPTCHA, stop retrying, hand off to the human, then re-check.',
    });
    ctx.tools.register(defineTool({
        name: 'browser_open',
        description: 'Open a URL in the shared browser window. Opens this task\'s browser session on first use; optionally opens in a new tab. Returns the resulting page snapshot.',
        parameters: {
            url: { type: 'string', required: true, description: 'The URL to open (HTTP/HTTPS).' },
            newTab: { type: 'boolean', description: 'Open in a new tab instead of the active one.' },
            space: { type: 'string', description: 'Optional browser-task label shown in the task manager and active window title.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    snapshotId: { type: 'string', required: true },
                    url: { type: 'string', required: true },
                    title: { type: 'string' },
                    truncated: { type: 'boolean' },
                    elements: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                ref: { type: 'number', required: true },
                                kind: { type: 'string', required: true },
                                label: { type: 'string', required: true },
                                x: { type: 'number', required: true },
                                y: { type: 'number', required: true },
                                loc: { type: 'string', required: true },
                            },
                        },
                    },
                    challenge: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            blocked: { type: 'boolean', required: true },
                            kind: { type: 'string' },
                            reason: { type: 'string' },
                        },
                    },
                    userControlling: { type: 'boolean' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            assertAllowed('browser_open', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const key = taskKey(exec);
            return withTaskAction(browser, key, 'open page', exec, async (session) => {
                await browser.openUrl(session, {
                    url: args.url,
                    ...args.newTab === true ? { newTab: true } : {},
                }, exec.signal);
                const snapshot = await browser.snapshot(session, {}, exec.signal);
                return {
                    snapshotId: snapshot.snapshotId,
                    url: snapshot.url,
                    ...snapshot.title !== undefined ? { title: snapshot.title } : {},
                    elements: snapshot.elements.map(el => ({ ref: el.ref, kind: el.kind, label: el.label, x: el.x, y: el.y, loc: el.loc })),
                    truncated: snapshot.truncated,
                    ...snapshot.challenge !== undefined ? { challenge: snapshot.challenge } : {},
                    ...snapshot.userControlling !== undefined ? { userControlling: snapshot.userControlling } : {},
                };
            }, args.space);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_back',
        description: 'Navigate the active tab to the previous history entry when one exists.',
        parameters: {},
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { navigated: { type: 'boolean', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.navigated ? 'Navigated back.' : 'No previous page in this tab.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(_args, exec) {
            assertAllowed('browser_back', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const navigated = await withTaskAction(browser, taskKey(exec), 'go back', exec, session => browser.back(session, exec.signal));
            return { navigated };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_forward',
        description: 'Navigate the active tab to the next history entry when one exists.',
        parameters: {},
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { navigated: { type: 'boolean', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.navigated ? 'Navigated forward.' : 'No next page in this tab.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(_args, exec) {
            assertAllowed('browser_forward', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const navigated = await withTaskAction(browser, taskKey(exec), 'go forward', exec, session => browser.forward(session, exec.signal));
            return { navigated };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_reload',
        description: 'Reload the active page in the shared browser.',
        parameters: {},
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { reloaded: { type: 'boolean', required: true } } },
            render: () => [{ type: 'text', text: 'Reloaded the active page.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(_args, exec) {
            assertAllowed('browser_reload', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            await withTaskAction(browser, taskKey(exec), 'reload page', exec, session => browser.reload(session, exec.signal));
            return { reloaded: true };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_stop',
        description: 'Stop the active page from loading.',
        parameters: {},
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { stopped: { type: 'boolean', required: true } } },
            render: () => [{ type: 'text', text: 'Stopped page loading.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(_args, exec) {
            assertAllowed('browser_stop', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            await withTaskAction(browser, taskKey(exec), 'stop loading', exec, session => browser.stopLoading(session, exec.signal));
            return { stopped: true };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_space',
        description: 'Name this browser task or list browser tasks. The task manager controls which isolated task view is visible in the shared window.',
        parameters: {
            label: { type: 'string', description: 'New display name for this browser task. Omit to list tasks.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    label: { type: 'string' },
                    spaces: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                key: { type: 'string', required: true },
                                label: { type: 'string', required: true },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => {
                if (value.label !== undefined)
                    return [{ type: 'text', text: `Browser task named "${value.label}".` }];
                const spaces = value.spaces;
                const lines = spaces.length === 0 ? '(no browser tasks open)' : spaces.map(s => `${s.key}${s.label !== '' ? ` — ${s.label}` : ''}`).join('\n');
                return [{ type: 'text', text: `Browser tasks:\n${lines}` }];
            },
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            assertAllowed('browser_space', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const key = taskKey(exec);
            const label = args.label;
            if (label === undefined && sessionsByTask.get(key) === undefined) {
                // LIST mode must not force-open a visible window just to enumerate
                // spaces: consult this task's session map before opening anything.
                // This reads the task registry rather than page state, so it stays
                // outside the page FIFO.
                const spaces = await browser.listSpaces();
                return { spaces: spaces.map(s => ({ key: s.key, label: s.label ?? '' })) };
            }
            const session = await ensureSession(browser, key);
            if (label !== undefined) {
                // Naming a task mutates shared task-manager state: keep FIFO order.
                await queueTaskOperation(key, () => browser.setSpace(session, label));
                return { label };
            }
            const spaces = await withTaskRead(browser, key, 'spaces', () => browser.listSpaces());
            return { spaces: spaces.map(s => ({ key: s.key, label: s.label ?? '' })) };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_tasks',
        description: 'List browser tasks with their visible activity, collaboration owner, tab count, and latest action.',
        parameters: {},
        output: {
            schema: {
                type: 'object', additionalProperties: false, properties: {
                    tasks: {
                        type: 'array', required: true, items: {
                            type: 'object', additionalProperties: false, properties: {
                                key: { type: 'string', required: true },
                                label: { type: 'string', required: true },
                                active: { type: 'boolean', required: true },
                                tabs: { type: 'number', required: true },
                                status: { type: 'string', required: true },
                                control: { type: 'string', required: true },
                                latestAction: { type: 'string' },
                                updatedAt: { type: 'number', required: true },
                                error: { type: 'string' },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.tasks.map(task => `${task.active ? '*' : ' '} ${task.label || task.key} — ${task.status}, ${task.control}, ${task.tabs} tabs${task.latestAction !== undefined ? ` — ${task.latestAction}` : ''}`).join('\n') || '(no browser tasks open)' }],
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute() {
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const tasks = await browser.listTasks();
            return { tasks: tasks.map(task => ({
                    key: task.key,
                    label: task.label,
                    active: task.active,
                    tabs: task.tabs,
                    status: task.status,
                    control: task.control,
                    ...task.latestAction !== undefined ? { latestAction: task.latestAction } : {},
                    updatedAt: task.updatedAt,
                    ...task.error !== undefined ? { error: task.error } : {},
                })) };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_handoff',
        description: 'Mark this browser task as waiting for the human, or return it to Agent control after a handoff.',
        parameters: {
            state: { type: 'string', required: true, enum: ['waiting-user', 'agent'], description: 'waiting-user pauses Agent page changes; agent returns control to the Agent.' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false, properties: {
                    key: { type: 'string', required: true },
                    label: { type: 'string', required: true },
                    status: { type: 'string', required: true },
                    control: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.status === 'waiting-user' ? 'Waiting for the human in the shared browser.' : 'Agent browser control resumed.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            // Handoff is not read-only: it changes the task's control state.
            assertAllowed('browser_handoff', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const key = taskKey(exec);
            const session = await ensureSession(browser, key);
            const task = await queueTaskOperation(key, () => browser.setHandoff(session, args.state));
            return { key: task.key, label: task.label, status: task.status, control: task.control };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_snapshot',
        description: 'Return an AI-friendly snapshot of the current shared-browser page (optionally filtered): numbered interactive elements (inputs, buttons, links) the model can cite. Use this to understand an interactive page before driving it.',
        parameters: {
            query: { type: 'string', description: 'Case-insensitive substring matched against each element\'s kind and label (e.g. "sign in", "email", "submit"). Filtering happens before the cap, so it can reach elements past the default limit.' },
            limit: { type: 'number', description: 'Maximum number of elements to return (1-1000; default 60).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    snapshotId: { type: 'string', required: true },
                    url: { type: 'string', required: true },
                    title: { type: 'string' },
                    truncated: { type: 'boolean' },
                    elements: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                ref: { type: 'number', required: true },
                                kind: { type: 'string', required: true },
                                label: { type: 'string', required: true },
                                x: { type: 'number', required: true },
                                y: { type: 'number', required: true },
                                loc: { type: 'string', required: true },
                            },
                        },
                    },
                    challenge: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            blocked: { type: 'boolean', required: true },
                            kind: { type: 'string' },
                            reason: { type: 'string' },
                        },
                    },
                    userControlling: { type: 'boolean' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const key = taskKey(exec);
            const snapshot = await withTaskRead(browser, key, 'snapshot', session => browser.snapshot(session, {
                ...args.query !== undefined ? { query: args.query } : {},
                ...args.limit !== undefined ? { limit: args.limit } : {},
            }, exec.signal));
            return {
                snapshotId: snapshot.snapshotId,
                url: snapshot.url,
                ...snapshot.title !== undefined ? { title: snapshot.title } : {},
                elements: snapshot.elements.map(el => ({ ref: el.ref, kind: el.kind, label: el.label, x: el.x, y: el.y, loc: el.loc })),
                truncated: snapshot.truncated,
                ...snapshot.challenge !== undefined ? { challenge: snapshot.challenge } : {},
                ...snapshot.userControlling !== undefined ? { userControlling: snapshot.userControlling } : {},
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_click_ref',
        description: 'Click an element from a specific browser_snapshot by its snapshotId and ref. Re-snapshot if the page has changed.',
        parameters: {
            snapshotId: { type: 'string', required: true, description: 'Opaque snapshot id returned by browser_open or browser_snapshot.' },
            ref: { type: 'number', required: true, description: 'Element reference number from that snapshot.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { clicked: { type: 'boolean', required: true } } },
            render: () => [{ type: 'text', text: 'Clicked the referenced element.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed('browser_click_ref', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            await withTaskAction(browser, taskKey(exec), 'click referenced element', exec, session => browser.clickRef(session, { snapshotId: args.snapshotId, ref: args.ref }, exec.signal));
            return { clicked: true };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_scroll_into_view',
        description: 'Scroll an element from a specific browser_snapshot into view. Re-snapshot if the page has changed.',
        parameters: {
            snapshotId: { type: 'string', required: true, description: 'Opaque snapshot id returned by browser_open or browser_snapshot.' },
            ref: { type: 'number', required: true, description: 'Element reference number from that snapshot.' },
            block: { type: 'string', enum: ['start', 'center', 'end', 'nearest'], description: 'Vertical alignment after scrolling. Default center.' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false, properties: {
                    scrolled: { type: 'boolean', required: true },
                    x: { type: 'number', required: true }, y: { type: 'number', required: true },
                    maxX: { type: 'number', required: true }, maxY: { type: 'number', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `Scrolled to (${value.x}, ${value.y}).` }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed('browser_scroll_into_view', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const result = await withTaskAction(browser, taskKey(exec), 'scroll referenced element into view', exec, session => browser.scrollIntoView(session, {
                snapshotId: args.snapshotId,
                ref: args.ref,
                ...args.block !== undefined ? { block: args.block } : {},
            }, exec.signal));
            return { scrolled: true, x: result.x, y: result.y, maxX: result.maxX, maxY: result.maxY };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_challenge',
        description: 'Check whether a human-verification challenge (CAPTCHA / bot detection: Cloudflare "Just a moment", reCAPTCHA, hCaptcha, Turnstile) is blocking the current page. When blocked, do NOT keep retrying automated steps — ask the human to complete the verification in the shared browser window, then re-check with browser_snapshot.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    blocked: { type: 'boolean', required: true },
                    kind: { type: 'string' },
                    reason: { type: 'string' },
                    hint: { type: 'string' },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.blocked
                        ? `Challenge detected: ${value.reason ?? value.kind ?? 'human-verification'}. ${value.hint ?? ''}`
                        : 'No human-verification challenge detected.',
                }],
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(_args, exec) {
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const key = taskKey(exec);
            const challenge = await withTaskRead(browser, key, 'challenge', session => browser.detectChallenge(session, exec.signal));
            return {
                blocked: challenge.blocked,
                ...challenge.kind !== undefined ? { kind: challenge.kind } : {},
                ...challenge.reason !== undefined ? { reason: challenge.reason } : {},
                hint: challenge.blocked
                    ? 'Ask the human to complete the verification in the shared browser window (the page is visible to them), then re-check with browser_snapshot.'
                    : '',
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_dialog',
        description: 'Inspect or steer the next JavaScript dialog (alert / confirm / prompt). A dialog freezes the page until it is answered, so the host accepts it immediately by default and keeps a record of what the page asked; `action: "inspect"` reports that record. To drive a page that confirms a destructive action, set the answer FIRST with `action: "dismiss"` (or "accept", plus `promptText` for a prompt()) and then trigger it - the policy applies to the next dialog on this tab. Use browser_handoff when a dialog needs a human decision.',
        parameters: {
            action: { type: 'string', enum: ['inspect', 'accept', 'dismiss'], required: true, description: 'inspect reports the last dialog and the current policy; accept/dismiss set how the NEXT dialog is answered.' },
            promptText: { type: 'string', description: 'With action=accept: the text to type into a prompt(). Ignored by alert/confirm.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    dialog: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            type: { type: 'string', required: true },
                            message: { type: 'string', required: true },
                            prompt: { type: 'string' },
                            answered: { type: 'string' },
                            promptText: { type: 'string' },
                        },
                    },
                    policy: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            behavior: { type: 'string', required: true },
                            promptText: { type: 'string' },
                        },
                    },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.dialog === undefined
                        ? 'No dialog has been raised on this tab; the next one will be ' + String(value.policy?.behavior ?? 'accept') + 'ed.'
                        : 'Last dialog (' + String((value.dialog).answered ?? 'answered') + 'ed): ' + String((value.dialog).type) + ' - ' + String((value.dialog).message).slice(0, 120) }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed('browser_dialog', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const key = taskKey(exec);
            const state = args.action === 'inspect'
                ? await withTaskRead(browser, key, 'dialog', async (session) => browser.inspectDialog(session))
                : await withTaskAction(browser, key, 'dialog ' + args.action, exec, session => browser.setDialogPolicy(session, {
                    behavior: args.action === 'dismiss' ? 'dismiss' : 'accept',
                    ...args.promptText === undefined ? {} : { promptText: args.promptText },
                }));
            const dialog = state.dialog;
            return {
                ...dialog === null || dialog === undefined ? {} : { dialog },
                policy: { ...state.policy },
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_console',
        description: 'Read the console messages and uncaught exceptions the browser captured for the active tab (a bounded ring, newest last). Use it to find out WHY a page misbehaved: a failed script, a rejected promise, a 404 the page logged. Reading does not clear - pass clear: true when you want a fresh window (e.g. before triggering the action you are debugging).',
        parameters: {
            level: { type: 'string', description: 'Only this level: log, info, warning, error, debug.' },
            limit: { type: 'number', description: 'Maximum messages to return (1-200; default 50, newest last).' },
            clear: { type: 'boolean', description: 'Drop what has been captured so far (default false).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    messages: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                level: { type: 'string', required: true },
                                text: { type: 'string', required: true },
                                at: { type: 'string', required: true },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.messages.length === 0
                        ? 'No console messages captured for this tab.'
                        : value.messages.length + ' message(s), newest last:\n' + value.messages.map(m => '[' + m.level + '] ' + String(m.text).slice(0, 300)).join('\n') }],
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            assertAllowed('browser_console', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const key = taskKey(exec);
            return withTaskRead(browser, key, 'console', async (session) => browser.consoleMessages(session, {
                ...args.level === undefined ? {} : { level: args.level },
                ...args.limit === undefined ? {} : { limit: args.limit },
                ...args.clear === true ? { clear: true } : {},
            }));
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_network',
        description: 'Read the network requests the browser captured for the active tab (a bounded ring, newest last): method, url, status, mime type, duration, and the failure text when one did not complete. Use it to check whether an API call actually happened and what it returned. Reading does not clear - pass clear: true for a fresh window.',
        parameters: {
            urlContains: { type: 'string', description: 'Only requests whose url contains this text (case-insensitive).' },
            failedOnly: { type: 'boolean', description: 'Only requests that failed to complete.' },
            limit: { type: 'number', description: 'Maximum requests to return (1-200; default 50, newest last).' },
            clear: { type: 'boolean', description: 'Drop what has been captured so far (default false).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    requests: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                method: { type: 'string', required: true },
                                url: { type: 'string', required: true },
                                status: { type: 'number' },
                                mime: { type: 'string' },
                                kind: { type: 'string' },
                                failed: { type: 'string' },
                                ms: { type: 'number' },
                                at: { type: 'string', required: true },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.requests.length === 0
                        ? 'No network requests captured for this tab.'
                        : value.requests.length + ' request(s), newest last:\n' + value.requests.map(r => [r.method, r.status ?? (r.failed !== undefined ? 'FAILED' : '?'), String(r.url).slice(0, 160)].join(' ')).join('\n') }],
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            assertAllowed('browser_network', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const key = taskKey(exec);
            return withTaskRead(browser, key, 'network', async (session) => browser.networkRequests(session, {
                ...args.urlContains === undefined ? {} : { urlContains: args.urlContains },
                ...args.failedOnly === true ? { failedOnly: true } : {},
                ...args.limit === undefined ? {} : { limit: args.limit },
                ...args.clear === true ? { clear: true } : {},
            }));
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_emulate',
        description: 'Emulate a device on the active tab: viewport size (with optional mobile mode and device pixel ratio), a custom user agent, or prefers-color-scheme. Use it to check a responsive layout, to take a screenshot at a fixed size, or to see the dark theme. Pass clear: true to undo all three and go back to the real window. Note the emulated viewport is a rendering override - the window itself does not resize.',
        parameters: {
            width: { type: 'number', description: 'Viewport width in CSS px (give with height).' },
            height: { type: 'number', description: 'Viewport height in CSS px (give with width).' },
            deviceScaleFactor: { type: 'number', description: 'Device pixel ratio, e.g. 2 for a retina phone. Default keeps the real one.' },
            mobile: { type: 'boolean', description: 'Emulate a mobile device (touch + mobile viewport behaviour).' },
            userAgent: { type: 'string', description: 'User agent string to send instead of the real one.' },
            colorScheme: { type: 'string', enum: ['light', 'dark', 'no-preference'], description: 'Value for prefers-color-scheme.' },
            clear: { type: 'boolean', description: 'Undo viewport, user agent and color-scheme emulation on this tab.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    applied: { type: 'array', required: true, items: { type: 'string' } },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.applied.length === 0
                        ? 'Nothing to emulate: give width+height, userAgent, colorScheme, or clear.'
                        : 'Applied: ' + value.applied.join(', ') }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed('browser_emulate', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const key = taskKey(exec);
            return withTaskAction(browser, key, 'emulate', exec, session => browser.emulate(session, {
                ...args.width === undefined ? {} : { width: args.width },
                ...args.height === undefined ? {} : { height: args.height },
                ...args.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: args.deviceScaleFactor },
                ...args.mobile === true ? { mobile: true } : {},
                ...args.userAgent === undefined ? {} : { userAgent: args.userAgent },
                ...args.colorScheme === undefined ? {} : { colorScheme: args.colorScheme },
                ...args.clear === true ? { clear: true } : {},
            }));
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_execute',
        description: 'Execute JavaScript in the shared-browser page context. This is the primary way to interact with page elements: focus, fill inputs (use the native value setter for framework-controlled inputs, then dispatch an input event), click buttons (element.click() or a constructed MouseEvent). The script may be a single expression (its value is returned) or statements with an explicit `return` - `const el = document.querySelector("#x"); return el.textContent` works. Promises are awaited. Returns the evaluation result by value, or the exception text.',
        parameters: {
            script: { type: 'string', required: true, description: 'The JavaScript to evaluate: an expression, or statements with a `return`.' },
            args: { type: 'array', items: { type: 'string' }, description: 'Optional arguments injected into the script scope as arguments[0..n].' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean', required: true },
                    value: { type: 'string' },
                    exception: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.ok ? `Result: ${String(value.value)}` : `Exception: ${value.exception}` }],
        },
        timeoutMs,
        isConcurrencySafe: () => false, // page JS can be stateful
        async execute(args, exec) {
            assertAllowed('browser_execute', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const result = await withTaskAction(browser, taskKey(exec), 'execute page script', exec, session => browser.execute(session, {
                script: args.script,
                args: args.args ?? [],
            }, exec.signal));
            if (result.ok) {
                const raw = result.value;
                const value = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
                return { ok: true, value };
            }
            return { ok: false, exception: result.exception };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_content',
        description: 'Fetch the current shared-browser page content in a chosen format: html (raw DOM), markdown (structured reading), txt (plain text), or json. Optionally scope to a CSS selector and cap the length. Use this to read page content, not to interact.',
        parameters: {
            format: { type: 'string', required: true, enum: ['html', 'markdown', 'txt', 'json'], description: 'Output format.' },
            selector: { type: 'string', description: 'CSS selector limiting the fetch to one region (e.g. #main).' },
            maxChars: { type: 'number', description: 'Maximum characters of returned content.' },
            timeoutMs: { type: 'number', description: `Evaluation timeout in ms (default 30000), capped below this tool's ${String(timeoutMs)}ms budget.` },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    content: { type: 'string', required: true },
                    truncated: { type: 'boolean', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.content + (value.truncated ? '\n(truncated)' : '') }],
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const key = taskKey(exec);
            const budgetMs = withinToolBudget(args.timeoutMs, 30_000);
            const readKey = 'content:' + JSON.stringify({ format: args.format, selector: args.selector, maxChars: args.maxChars, timeoutMs: budgetMs });
            const result = await withTaskRead(browser, key, readKey, session => browser.content(session, {
                format: args.format,
                ...args.selector !== undefined ? { selector: args.selector } : {},
                ...args.maxChars !== undefined ? { maxChars: args.maxChars } : {},
                timeoutMs: budgetMs,
            }, exec.signal));
            return { content: result.content, truncated: result.truncated };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_click',
        description: 'Click an element in the shared browser. Address it three ways: x and y (use with browser_screenshot when a vision model located it — this covers icons, image buttons and canvas that DOM snapshots cannot target), a CSS selector, or visible text. Selector and text are resolved in the page and scrolled into view first, so you can click "the sign-in button" without spending a browser_snapshot round-trip on its ref; the reply names the element it actually hit. Coordinates are relative to the visible viewport, same as a screenshot.',
        parameters: {
            x: { type: 'number', description: 'Viewport x coordinate (CSS px), inside the visible viewport. Give with y, or give selector/text instead - a coordinate target is NOT scrolled into view (selector/text are), so an off-screen point is refused.' },
            y: { type: 'number', description: 'Viewport y coordinate (CSS px), inside the visible viewport.' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button, default left. A right-click reaches the page own context-menu handler: Electron installs no native menu, so whatever the page shows is what you interact with next.' },
            modifiers: { type: 'array', items: { type: 'string', enum: ['alt', 'ctrl', 'meta', 'shift'] }, description: 'Modifiers held during the action. ctrl/meta-click opens a link in a new tab (check browser_list_tabs afterwards); shift-click extends a selection.' },
            selector: { type: 'string', description: 'CSS selector to click instead of coordinates; the first visible match is used and scrolled into view.' },
            text: { type: 'string', description: 'Visible text (or aria-label/value, case-insensitive) to click instead of coordinates; the innermost visible match wins. Saves a browser_snapshot round-trip when you know the label.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    clicked: { type: 'boolean', required: true },
                    x: { type: 'number' },
                    y: { type: 'number' },
                    target: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.clicked === true
                        ? (value.target !== undefined ? `Clicked "${value.target}" at ${value.x},${value.y}.` : `Clicked at ${value.x},${value.y}.`)
                        : 'Clicked failed.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed('browser_click', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const target = {
                ...args.x !== undefined ? { x: args.x } : {},
                ...args.y !== undefined ? { y: args.y } : {},
                ...args.selector !== undefined ? { selector: args.selector } : {},
                ...args.text !== undefined ? { text: args.text } : {},
                ...args.button !== undefined ? { button: args.button } : {},
                ...args.modifiers !== undefined ? { modifiers: args.modifiers } : {},
            };
            const point = await withTaskAction(browser, taskKey(exec), 'click page', exec, session => browser.click(session, target, exec.signal));
            return { clicked: true, ...point };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_double_click',
        description: 'Double-click an element in the shared browser. Address it with x and y, a CSS selector, or visible text (resolved and scrolled into view first). Use for opening links, selecting text, or expanding UI that ignores single clicks.',
        parameters: {
            x: { type: 'number', description: 'Viewport x coordinate (CSS px), inside the visible viewport. Give with y, or give selector/text instead - a coordinate target is NOT scrolled into view (selector/text are), so an off-screen point is refused.' },
            y: { type: 'number', description: 'Viewport y coordinate (CSS px), inside the visible viewport.' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button, default left. A right-click reaches the page own context-menu handler: Electron installs no native menu, so whatever the page shows is what you interact with next.' },
            modifiers: { type: 'array', items: { type: 'string', enum: ['alt', 'ctrl', 'meta', 'shift'] }, description: 'Modifiers held during the action. ctrl/meta-click opens a link in a new tab (check browser_list_tabs afterwards); shift-click extends a selection.' },
            selector: { type: 'string', description: 'CSS selector to double-click instead of coordinates; the first visible match is used and scrolled into view.' },
            text: { type: 'string', description: 'Visible text (or aria-label/value, case-insensitive) to double-click instead of coordinates; the innermost visible match wins. Saves a browser_snapshot round-trip when you know the label.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    clicked: { type: 'boolean', required: true },
                    x: { type: 'number' },
                    y: { type: 'number' },
                    target: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.clicked === true
                        ? (value.target !== undefined ? `Double-clicked "${value.target}" at ${value.x},${value.y}.` : `Double-clicked at ${value.x},${value.y}.`)
                        : 'Double-clicked failed.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed('browser_double_click', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const target = {
                ...args.x !== undefined ? { x: args.x } : {},
                ...args.y !== undefined ? { y: args.y } : {},
                ...args.selector !== undefined ? { selector: args.selector } : {},
                ...args.text !== undefined ? { text: args.text } : {},
                ...args.button !== undefined ? { button: args.button } : {},
                ...args.modifiers !== undefined ? { modifiers: args.modifiers } : {},
            };
            const point = await withTaskAction(browser, taskKey(exec), 'double-click page', exec, session => browser.doubleClick(session, target, exec.signal));
            return { clicked: true, ...point };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_hover',
        description: 'Move the pointer over an element without clicking. Address it with x and y, a CSS selector, or visible text (resolved and scrolled into view first). Triggers hover states, tooltips, and dropdown menus.',
        parameters: {
            x: { type: 'number', description: 'Viewport x coordinate (CSS px), inside the visible viewport. Give with y, or give selector/text instead - a coordinate target is NOT scrolled into view (selector/text are), so an off-screen point is refused.' },
            y: { type: 'number', description: 'Viewport y coordinate (CSS px), inside the visible viewport.' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button, default left. A right-click reaches the page own context-menu handler: Electron installs no native menu, so whatever the page shows is what you interact with next.' },
            modifiers: { type: 'array', items: { type: 'string', enum: ['alt', 'ctrl', 'meta', 'shift'] }, description: 'Modifiers held during the action. ctrl/meta-click opens a link in a new tab (check browser_list_tabs afterwards); shift-click extends a selection.' },
            selector: { type: 'string', description: 'CSS selector to hover over instead of coordinates; the first visible match is used and scrolled into view.' },
            text: { type: 'string', description: 'Visible text (or aria-label/value, case-insensitive) to hover over instead of coordinates; the innermost visible match wins. Saves a browser_snapshot round-trip when you know the label.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    hovered: { type: 'boolean', required: true },
                    x: { type: 'number' },
                    y: { type: 'number' },
                    target: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.hovered === true
                        ? (value.target !== undefined ? `Hovered "${value.target}" at ${value.x},${value.y}.` : `Hovered at ${value.x},${value.y}.`)
                        : 'Hovered failed.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed('browser_hover', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const target = {
                ...args.x !== undefined ? { x: args.x } : {},
                ...args.y !== undefined ? { y: args.y } : {},
                ...args.selector !== undefined ? { selector: args.selector } : {},
                ...args.text !== undefined ? { text: args.text } : {},
                ...args.button !== undefined ? { button: args.button } : {},
                ...args.modifiers !== undefined ? { modifiers: args.modifiers } : {},
            };
            const point = await withTaskAction(browser, taskKey(exec), 'hover page', exec, session => browser.hover(session, target, exec.signal));
            return { hovered: true, ...point };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_scroll',
        description: 'Scroll the active page by CSS-pixel deltas. With no deltas it scrolls downward by about one viewport (80% of the viewport height, at least 480px).',
        parameters: {
            deltaX: { type: 'number', description: 'Horizontal CSS-pixel delta. Default 0.' },
            deltaY: { type: 'number', description: 'Vertical CSS-pixel delta. Default one viewport downward.' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false, properties: {
                    x: { type: 'number', required: true }, y: { type: 'number', required: true },
                    maxX: { type: 'number', required: true }, maxY: { type: 'number', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `Scrolled to (${value.x}, ${value.y}).` }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed('browser_scroll', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const result = await withTaskAction(browser, taskKey(exec), 'scroll page', exec, session => browser.scroll(session, {
                ...args.deltaX !== undefined ? { deltaX: args.deltaX } : {},
                ...args.deltaY !== undefined ? { deltaY: args.deltaY } : {},
            }, exec.signal));
            return { x: result.x, y: result.y, maxX: result.maxX, maxY: result.maxY };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_upload_file',
        description: 'Attach a local file to a file input in the shared browser (CDP DOM.setFileInputFiles, so the page sees a real file selection). Use for avatar uploads, attachments, and import dialogs.',
        parameters: {
            filePath: { type: 'string', required: true, description: 'Absolute path of the file to attach.' },
            selector: { type: 'string', description: 'CSS selector of the file input; defaults to the first input[type="file"] on the page.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true } } },
            render: (_args, value) => [{ type: 'text', text: `Attached ${value.path}.` }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed('browser_upload_file', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const result = await withTaskAction(browser, taskKey(exec), 'attach file', exec, session => browser.uploadFile(session, {
                filePath: args.filePath,
                ...args.selector !== undefined ? { selector: args.selector } : {},
            }, exec.signal));
            return { path: result.path };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_wait_for',
        description: 'Wait until an element matching a CSS selector appears (and is visible), polling every 250ms. Use before interacting with dynamically-loaded content (SPA views, toasts, menus).',
        parameters: {
            selector: { type: 'string', required: true, description: 'CSS selector to wait for.' },
            timeoutMs: { type: 'number', description: `Total budget in ms (default 15000), capped below this tool's ${String(timeoutMs)}ms budget.` },
            visible: { type: 'boolean', description: 'Require visibility (>4x4 px, not display:none). Default true.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    found: { type: 'boolean', required: true },
                    selector: { type: 'string', required: true },
                    tag: { type: 'string', required: true },
                    text: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `Found <${value.tag}> ${value.selector}${value.text !== undefined ? ` — "${value.text.slice(0, 80)}"` : ''}.` }],
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            assertAllowed('browser_wait_for', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const result = await withTaskAction(browser, taskKey(exec), 'wait for element', exec, session => browser.waitForElement(session, {
                selector: args.selector,
                timeoutMs: withinToolBudget(args.timeoutMs, 15_000),
                ...args.visible !== undefined ? { visible: args.visible } : {},
            }, exec.signal));
            return { found: true, selector: result.selector, tag: result.tag, text: result.text };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_type',
        description: 'Type text into the focused element of the shared browser. Use after browser_execute focuses an input (e.g. el.focus()), or after a click lands in a field. Text is inserted at the current focus via CDP Input.insertText.',
        parameters: {
            text: { type: 'string', required: true, description: 'The text to insert.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { typed: { type: 'boolean', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.typed ? `Typed ${String(_args.text).length} chars.` : 'Type failed.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed('browser_type', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            await withTaskAction(browser, taskKey(exec), 'type text', exec, session => browser.type(session, { text: args.text }, exec.signal));
            return { typed: true };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_press_key',
        description: 'Press a key into the focused element of the shared browser (keyDown + keyUp, physical input). Supports single characters, Enter/Tab/Escape/Backspace/Delete, arrow keys, Home/End/PageUp/PageDown, F1-F12, and modifier combos (e.g. key="a" modifiers=["ctrl"] for Ctrl+A). Use after focusing an input or for keyboard navigation.',
        parameters: {
            key: { type: 'string', required: true, description: 'The key to press: a character, Enter, Tab, Escape, ArrowDown, Home, F5, etc.' },
            modifiers: { type: 'array', items: { type: 'string', enum: ['alt', 'ctrl', 'meta', 'shift'] }, description: 'Modifier keys held during the press.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { pressed: { type: 'boolean', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.pressed ? `Pressed ${String(_args.key)}.` : 'Press failed.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed('browser_press_key', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            await withTaskAction(browser, taskKey(exec), 'press key', exec, session => browser.pressKey(session, {
                key: args.key,
                ...args.modifiers !== undefined ? { modifiers: args.modifiers } : {},
            }, exec.signal));
            return { pressed: true };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_fill',
        description: 'Fill a form in one batch: pass fields with a CSS selector or name/label/placeholder text and the value to set (string, number, or boolean for checkbox/radio; for selects or radio groups pass the option value or visible text). Values are applied with the native setter plus input/change events, so React/Vue controlled inputs update correctly. Optionally submit the containing form. Prefer this over hand-written browser_execute for form filling; per-field failures are reported instead of throwing.',
        parameters: {
            fields: {
                type: 'array',
                required: true,
                items: {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                        selector: { type: 'string', description: 'CSS selector; when present, candidates are scoped to it.' },
                        name: { type: 'string', description: 'Match by the field\'s name attribute.' },
                        label: { type: 'string', description: 'Match by associated <label> text or aria-label.' },
                        placeholder: { type: 'string', description: 'Match by placeholder text.' },
                        kind: { type: 'string', enum: ['text', 'textarea', 'checkbox', 'radio', 'select'], description: 'Field kind; defaults to text.' },
                        value: { type: 'string', description: 'Value to set (string form; booleans/numbers accepted as strings).' },
                    },
                },
            },
            submit: { type: 'boolean', description: 'Submit the containing form after filling (default false).' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    fields: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                ok: { type: 'boolean', required: true },
                                target: { type: 'string', required: true },
                                method: { type: 'string' },
                                error: { type: 'string' },
                            },
                        },
                    },
                    submitted: { type: 'boolean', required: true },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: (() => {
                        const fields = value.fields;
                        const failed = fields.filter(f => !f.ok);
                        const lines = fields.map(f => `${f.ok ? 'OK' : 'FAIL'} ${f.target}${f.ok ? ` (${f.method ?? 'input'})` : `: ${f.error ?? 'unknown error'}`}`);
                        const head = failed.length === 0
                            ? `Filled ${fields.length}/${fields.length} fields${value.submitted ? ' and submitted the form' : ''}.`
                            : `Filled ${fields.length - failed.length}/${fields.length} fields; ${failed.length} failed:`;
                        return head + '\n' + lines.join('\n');
                    })(),
                }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed('browser_fill', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const fields = (args.fields ?? []).map((f) => ({
                ...f.selector !== undefined ? { selector: f.selector } : {},
                ...f.name !== undefined ? { name: f.name } : {},
                ...f.label !== undefined ? { label: f.label } : {},
                ...f.placeholder !== undefined ? { placeholder: f.placeholder } : {},
                ...f.kind !== undefined ? { kind: f.kind } : {},
                value: parseFillValue(f.value),
            }));
            const result = await withTaskAction(browser, taskKey(exec), 'fill form', exec, session => browser.fillForm(session, {
                fields,
                ...args.submit === true ? { submit: true } : {},
            }, exec.signal));
            return {
                fields: result.fields.map(f => ({ ok: f.ok, target: f.target, ...f.method !== undefined ? { method: f.method } : {}, ...f.error !== undefined ? { error: f.error } : {} })),
                submitted: result.submitted,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_drag',
        description: 'Press on one element, move to another, and release: a drag. Both ends are addressed like browser_click (x and y, a CSS selector, or visible text) and scrolled into view first. Use it for sliders, sortable lists and canvas editors. It drives pointer-based drags; a page that relies on HTML5 drag-and-drop (dragstart/drop) will not respond to it, so use that page own controls instead.',
        parameters: {
            from: {
                type: 'object',
                required: true,
                additionalProperties: false,
                description: 'Where the drag starts.',
                properties: {
                    x: { type: 'number', description: 'Viewport x coordinate (CSS px).' },
                    y: { type: 'number', description: 'Viewport y coordinate (CSS px), inside the visible viewport.' },
                    selector: { type: 'string', description: 'CSS selector; the first visible match is used and scrolled into view.' },
                    text: { type: 'string', description: 'Visible text (or aria-label/value, case-insensitive); the innermost visible match wins.' },
                },
            },
            to: {
                type: 'object',
                required: true,
                additionalProperties: false,
                description: 'Where it ends.',
                properties: {
                    x: { type: 'number', description: 'Viewport x coordinate (CSS px).' },
                    y: { type: 'number', description: 'Viewport y coordinate (CSS px), inside the visible viewport.' },
                    selector: { type: 'string', description: 'CSS selector; the first visible match is used and scrolled into view.' },
                    text: { type: 'string', description: 'Visible text (or aria-label/value, case-insensitive); the innermost visible match wins.' },
                },
            },
            steps: { type: 'number', description: 'Intermediate move events (default 12, max 60). A hand does not teleport, and a listener that reads positions per frame needs more than one.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    dragged: { type: 'boolean', required: true },
                    from: { type: 'string' },
                    to: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: value.dragged
                        ? `Dragged ${value.from ?? '(point)'} to ${value.to ?? '(point)'}.`
                        : 'Drag failed.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed('browser_drag', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const target = (point) => ({
                ...point.x !== undefined ? { x: point.x } : {},
                ...point.y !== undefined ? { y: point.y } : {},
                ...point.selector !== undefined ? { selector: point.selector } : {},
                ...point.text !== undefined ? { text: point.text } : {},
            });
            const result = await withTaskAction(browser, taskKey(exec), 'drag page', exec, session => browser.drag(session, {
                from: target(args.from),
                to: target(args.to),
                ...args.steps !== undefined ? { steps: args.steps } : {},
            }, exec.signal));
            return { dragged: true, ...result.from.target === undefined ? {} : { from: result.from.target }, ...result.to.target === undefined ? {} : { to: result.to.target } };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_screenshot',
        description: 'Capture the current shared-browser page as a PNG screenshot. Use for visual confirmation of layout, charts, designs, or CAPTCHAs, or to feed a vision tool (read_image) that locates elements visually. Supports optional full-page capture and optional save-to-file (the saved path can be passed to read_image for vision-based element location).',
        parameters: {
            fullPage: { type: 'boolean', description: 'Capture the full scrollable page instead of the viewport (default false).' },
            savePath: { type: 'string', description: 'Absolute file path to also save the PNG to (e.g. for read_image vision location). It must be inside the browser-electron write roots; anything else is refused with "outside the allowed roots".' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    dataUrl: { type: 'string', required: true, description: 'Base64 PNG data URL of the screenshot.' },
                    path: { type: 'string', description: 'The file path the screenshot was saved to, when savePath was given.' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `Screenshot captured (${Math.round(value.dataUrl.length * 3 / 4 / 1024)} KiB)${value.path !== undefined ? ` saved to ${value.path}` : ''}.` }],
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            // An unsaved capture is read-only and stays outside the allow-list; the
            // variant that writes a file is guarded like the other writing tools.
            if (args.savePath !== undefined)
                assertAllowed('browser_screenshot', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const key = taskKey(exec);
            const capture = (session) => browser.screenshot(session, {
                ...args.fullPage === true ? { fullPage: true } : {},
                ...args.savePath !== undefined ? { savePath: args.savePath } : {},
            }, exec.signal);
            // A saved capture must not share a dedup key with an unsaved one, and
            // two different save paths must not either; both variants join the FIFO.
            const readKey = 'screenshot:' + JSON.stringify({ fullPage: args.fullPage === true, savePath: args.savePath });
            const shot = await withTaskRead(browser, key, readKey, capture);
            return {
                dataUrl: shot.dataUrl,
                ...shot.path !== undefined ? { path: shot.path } : {},
            };
        },
    }));
    if (config.tabTools !== false) {
        ctx.tools.register(defineTool({
            name: 'browser_list_tabs',
            description: 'List the shared-browser session\'s tabs with their URLs and which is active.',
            parameters: {},
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        tabs: {
                            type: 'array',
                            required: true,
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    id: { type: 'string', required: true },
                                    url: { type: 'string', required: true },
                                    active: { type: 'boolean', required: true },
                                },
                            },
                        },
                    },
                },
                render: (_args, value) => [{
                        type: 'text',
                        text: value.tabs
                            .map(t => `${t.active ? '*' : ' '} ${t.id} ${t.url}`).join('\n'),
                    }],
            },
            timeoutMs,
            isConcurrencySafe: () => true,
            async execute(_args, exec) {
                const browser = ctx.get('browser');
                if (browser === undefined)
                    throw new Error('tool-browser: browser service unavailable');
                const key = taskKey(exec);
                const tabs = await withTaskRead(browser, key, 'list_tabs', session => browser.listTabs(session));
                return { tabs: tabs.map(t => ({ id: t.id, url: t.url, active: t.active })) };
            },
        }));
        ctx.tools.register(defineTool({
            name: 'browser_switch_tab',
            description: 'Switch the shared browser to a tab by id (from browser_list_tabs).',
            parameters: {
                tabId: { type: 'string', required: true, description: 'The tab id to switch to.' },
            },
            output: {
                schema: { type: 'object', additionalProperties: false, properties: { switched: { type: 'boolean', required: true } } },
                render: (_args, value) => [{ type: 'text', text: value.switched ? 'Switched.' : 'Tab not found.' }],
            },
            timeoutMs,
            isConcurrencySafe: () => true,
            async execute(args, exec) {
                assertAllowed('browser_switch_tab', exec);
                const browser = ctx.get('browser');
                if (browser === undefined)
                    throw new Error('tool-browser: browser service unavailable');
                await withTaskAction(browser, taskKey(exec), 'switch tab', exec, session => browser.switchTab(session, args.tabId));
                return { switched: true };
            },
        }));
        ctx.tools.register(defineTool({
            name: 'browser_close_tab',
            description: 'Close a tab in the shared browser by id. Closing the active tab activates the next.',
            parameters: {
                tabId: { type: 'string', required: true, description: 'The tab id to close.' },
            },
            output: {
                schema: { type: 'object', additionalProperties: false, properties: { closed: { type: 'boolean', required: true } } },
                render: (_args, value) => [{ type: 'text', text: value.closed ? 'Closed.' : 'Tab not found.' }],
            },
            timeoutMs,
            isConcurrencySafe: () => true,
            async execute(args, exec) {
                assertAllowed('browser_close_tab', exec);
                const browser = ctx.get('browser');
                if (browser === undefined)
                    throw new Error('tool-browser: browser service unavailable');
                const closed = await withTaskAction(browser, taskKey(exec), 'close tab', exec, session => browser.closeTab(session, args.tabId));
                return { closed };
            },
        }));
        ctx.tools.register(defineTool({
            name: 'browser_reset',
            description: 'Close every tab in the shared browser and start fresh with one blank tab.',
            parameters: {},
            output: {
                schema: { type: 'object', additionalProperties: false, properties: { reset: { type: 'boolean', required: true } } },
                render: (_args, value) => [{ type: 'text', text: value.reset ? 'Browser reset.' : 'Failed.' }],
            },
            timeoutMs,
            isConcurrencySafe: () => true,
            async execute(_args, exec) {
                assertAllowed('browser_reset', exec);
                const browser = ctx.get('browser');
                if (browser === undefined)
                    throw new Error('tool-browser: browser service unavailable');
                await withTaskAction(browser, taskKey(exec), 'reset tabs', exec, session => browser.reset(session));
                return { reset: true };
            },
        }));
    }
    ctx.tools.register(defineTool({
        name: 'browser_history',
        description: 'List the shared browser session\'s recorded operation history (navigate/execute/click/type/pressKey), newest last, with per-step success/error. Use to understand what the agent did and to pick a step to replay.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    entries: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                seq: { type: 'number', required: true },
                                action: { type: 'string', required: true },
                                ok: { type: 'boolean', required: true },
                                params: { type: 'object', additionalProperties: true, required: true },
                                result: { type: 'string' },
                                error: { type: 'string' },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => {
                const entries = value.entries;
                if (entries.length === 0)
                    return [{ type: 'text', text: '(no recorded operations yet)' }];
                return [{
                        type: 'text',
                        text: entries.map(e => {
                            const rawParams = JSON.stringify(e.params);
                            const shownParams = rawParams.length > 300 ? rawParams.slice(0, 300) + '…' : rawParams;
                            return `#${e.seq} ${e.action} ${e.ok ? 'ok' : 'FAIL'} ${shownParams}${e.result !== undefined ? ` -> ${e.result}` : ''}${e.error !== undefined ? ` !! ${e.error}` : ''}`;
                        }).join('\n'),
                    }];
            },
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(_args, exec) {
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const key = taskKey(exec);
            const entries = await withTaskRead(browser, key, 'history', session => browser.history(session));
            const rendered = entries.map(e => {
                const row = {
                    seq: e.seq,
                    action: e.action,
                    ok: e.ok,
                    params: summarizeHistoryParams(e.params),
                };
                if (e.result !== undefined)
                    row.result = e.result;
                if (e.error !== undefined)
                    row.error = e.error;
                return row;
            });
            return { entries: rendered };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_replay',
        description: 'Replay one recorded browser operation by its history sequence number (from browser_history). Navigate/click/type/pressKey are re-issued against the current page; execute re-runs its script. The replayed step is appended to history as a new entry.',
        parameters: {
            seq: { type: 'number', required: true, description: 'The history entry sequence number to replay.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { replayed: { type: 'boolean', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.replayed ? 'Replayed.' : 'Replay failed.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed('browser_replay', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            await withTaskAction(browser, taskKey(exec), 'replay browser action', exec, session => browser.replay(session, args.seq));
            return { replayed: true };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_download',
        description: 'Download a URL to a local file, keeping the browser session\'s cookies and login state. Use for fetching files behind authentication or from the current page context. Available on the self-hosted browser; the desktop shell delegates downloads to the real browser UI.',
        parameters: {
            url: { type: 'string', required: true, description: 'The URL to download.' },
            savePath: { type: 'string', required: true, description: 'Absolute path of the file to write.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true } } },
            render: (_args, value) => [{ type: 'text', text: `Downloaded to ${value.path}.` }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed('browser_download', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const result = await withTaskAction(browser, taskKey(exec), 'download file', exec, session => browser.download(session, { url: args.url, savePath: args.savePath }, exec.signal));
            return { path: result.path };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_session',
        description: 'Show THIS task\'s browser session: its id and open tabs. Each task (DSH session) has its own browser session, so this reflects what your task drives. The window is shared with the human and other tasks, but tab sets and history are isolated per task.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    session: { type: 'string', required: true },
                    tabs: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                id: { type: 'string', required: true },
                                url: { type: 'string', required: true },
                                active: { type: 'boolean', required: true },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `Session ${value.session}\n${value.tabs.map(t => `${t.active ? '*' : ' '} ${t.id} ${t.url}`).join('\n')}`,
                }],
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(_args, exec) {
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const key = taskKey(exec);
            const session = await ensureSession(browser, key);
            const tabs = await withTaskRead(browser, key, 'session', () => browser.listTabs(session));
            return { session, tabs: tabs.map(t => ({ id: t.id, url: t.url, active: t.active })) };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_reset_session',
        description: 'Reset THIS task\'s browser session: close it entirely so the next browser_* call starts a fresh session with one blank tab. Other tasks\' sessions are untouched. Use when a session is in a bad state or you want a clean slate.',
        parameters: {},
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { reset: { type: 'boolean', required: true } } },
            render: (_args, value) => [{ type: 'text', text: value.reset ? 'This task\'s browser session was closed; the next call starts fresh.' : 'Failed.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => true,
        async execute(_args, exec) {
            assertAllowed('browser_reset_session', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const key = taskKey(exec);
            // Join the task's FIFO: closing the session while a queued operation is
            // still using it would tear the view out from under that call.
            await queueTaskOperation(key, async () => {
                const session = sessionsByTask.get(key);
                if (session === undefined)
                    return;
                try {
                    await browser.close(session);
                }
                finally {
                    // Always forget the mapping so the next call opens a fresh session,
                    // even if the provider close threw (the session is half-closed).
                    sessionsByTask.delete(key);
                }
            });
            return { reset: true };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_restrict',
        description: 'Restrict which browser actions are allowed for THIS task, to prevent stray clicks/navigation. Pass a list of browser tool names (e.g. ["browser_snapshot","browser_content","browser_click"]) — any other browser_* call from this task is refused. The rule is scoped to the calling task; other tasks keep their own rules. Pass an empty list or omit to lift this task\'s restriction. Read-only tools (snapshot/content/screenshot/session/history/list_tabs/challenge) are never blocked.',
        parameters: {
            allowed: {
                type: 'array',
                items: { type: 'string' },
                description: 'Allow-list of browser tool names; empty clears the restriction.',
            },
        },
        output: {
            schema: { type: 'object', additionalProperties: false, properties: { restrictedTo: { type: 'array', required: true, items: { type: 'string' } } } },
            render: (_args, value) => [{ type: 'text', text: value.restrictedTo.length > 0 ? `Restricted to: ${value.restrictedTo.join(', ')}` : 'Restriction lifted.' }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            // Always allowed so the guard can be lifted.
            const allowed = args.allowed ?? [];
            const unknown = allowed.filter((t) => !t.startsWith('browser_'));
            if (unknown.length > 0) {
                throw new Error(`browser_restrict: unknown tool name(s) ${unknown.map(t => `"${t}"`).join(', ')} (must start with "browser_")`);
            }
            // A misspelled name would otherwise be accepted and silently refuse every
            // guarded action for this task, so check it against the real registry.
            const schemas = ctx.tools.schemas;
            const registered = typeof schemas === 'function' ? schemas.call(ctx.tools).map(schema => schema.name) : [];
            const misspelled = registered.length === 0 ? [] : allowed.filter((t) => !registered.includes(t));
            if (misspelled.length > 0) {
                throw new Error(`browser_restrict: no such browser tool ${misspelled.map(t => `"${t}"`).join(', ')}`);
            }
            // Empty list (or omitted) lifts THIS task's restriction; a non-empty list
            // becomes this task's allow-list. Either way the rule is task-scoped.
            const key = taskKey(exec);
            restrictedToByTask.set(key, allowed.length === 0 ? [] : [...allowed]);
            const restrictedTo = restrictionFor(key);
            return { restrictedTo: restrictedTo === undefined ? [] : [...restrictedTo] };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_auth',
        description: 'Export or restore the browser session\'s cookies (login state). Use "flush" to get a JSON cookie list, "restore" with that list (or with file: a JSON export on disk) to put logins back, or "clear" with a domain and/or name filter to drop the cookies of that site (e.g. stale WAF challenge generations). Logging in once in this browser is usually easier than importing: the profile is persistent, so a human can use browser_handoff and log in by hand. A browser\'s own cookie store cannot be read automatically — Chrome and Edge 127+ encrypt cookie values with App-Bound Encryption — so importing means a JSON export the user produced. Available on the self-hosted browser.',
        parameters: {
            action: { type: 'string', required: true, enum: ['flush', 'restore', 'clear'], description: 'flush = export cookies; restore = import cookies; clear = remove cookies for a domain/name scope.' },
            cookies: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Cookie list to restore (action=restore).' },
            file: { type: 'string', description: 'restore only: read the cookie list from this JSON file (an array, or {"cookies": [...]}) instead of passing it inline. Takes precedence over cookies. The path must be inside browser-electron.readRoots.' },
            domain: { type: 'string', description: 'clear only: remove cookies for this domain and its subdomains (e.g. "example.com").' },
            name: { type: 'string', description: 'clear only: remove only this exact cookie name within the scope.' },
            all: { type: 'boolean', description: 'clear only: remove every cookie in the profile. Required when neither domain nor name is given; destructive.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    cookies: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    restored: { type: 'number' },
                    failed: { type: 'number' },
                    removed: { type: 'number' },
                    names: { type: 'array', items: { type: 'string' } },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.removed !== undefined
                        ? `Removed ${value.removed} cookie(s)` + (value.names.length > 0 ? ': ' + value.names.join(', ') : '.')
                        : value.cookies !== undefined
                            ? `Exported ${value.cookies.length} cookies.`
                            : `Restored ${value.restored} cookies` + (typeof value.failed === 'number' && value.failed > 0 ? ` (${value.failed} skipped)` : '') + '.',
                }],
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed('browser_auth', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const session = await ensureSession(browser, taskKey(exec));
            if (args.action === 'flush') {
                const cookies = await browser.flushAuth(session);
                return { cookies: cookies.map(c => ({ ...c })) };
            }
            if (args.action === 'clear') {
                const domain = typeof args.domain === 'string' && args.domain.trim() !== '' ? args.domain : undefined;
                const name = typeof args.name === 'string' && args.name !== '' ? args.name : undefined;
                if (domain === undefined && name === undefined && args.all !== true) {
                    throw new Error('browser_auth clear requires a domain or name filter; pass all: true to remove every cookie in the profile');
                }
                const cleared = await browser.clearAuth(session, {
                    ...domain !== undefined ? { domain } : {},
                    ...name !== undefined ? { name } : {},
                    ...args.all === true ? { all: true } : {},
                });
                return { removed: cleared.removed, names: [...cleared.names] };
            }
            // A file source exists because a real cookie export runs to hundreds of
            // entries, which is impractical to pass through the model inline.
            const file = typeof args.file === 'string' && args.file.trim() !== '' ? args.file : undefined;
            if (file !== undefined) {
                const imported = await browser.importAuth(session, file);
                return { restored: imported.restored, failed: imported.failed };
            }
            const list = (args.cookies ?? []);
            const restored = await browser.restoreAuth(session, list);
            return { restored };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_scrape',
        description: 'Visit many URLs in the background and append one JSON line per page to a file, so the results never travel back through the model: a batch of a thousand costs the same number of tokens as a batch of one. Start with action=start, then poll action=status. Each row is { seq, url, ok, data } or { seq, url, ok, error }, where seq is the index of that URL in the input. Rows are appended the moment they are produced, so a stopped batch keeps everything it managed. Raise concurrency to load several pages at once; rows then arrive in completion order. The batch drives the task\'s active tab, so the visible page changes while it runs.',
        parameters: {
            action: { type: 'string', enum: ['start', 'status', 'stop', 'list'], description: 'start (default) begins a batch; status and stop need id; list shows every batch this process knows.' },
            urls: { type: 'array', items: { type: 'string' }, description: 'start: URLs to visit, in order.' },
            script: { type: 'string', description: 'start: expression evaluated on each page once it is ready; its JSON value becomes the row\'s data. An async IIFE is fine (promises are awaited).' },
            outPath: { type: 'string', description: 'start: JSONL destination, inside browser-electron.writeRoots. Truncated when the batch starts.' },
            waitFor: { type: 'string', description: 'start: optional CSS selector awaited on each page before the script runs.' },
            timeoutMs: { type: 'number', description: 'start: per-URL budget in ms for the wait and the extraction (default 30000).' },
            concurrency: { type: 'number', description: 'start: how many pages to load at once (default 1, max 8). Each worker costs a tab of its own. Rows then land in completion order; every row carries its URL index as seq, so sort by seq to restore order.' },
            id: { type: 'string', description: 'status/stop: the batch id returned by start.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    id: { type: 'string' },
                    state: { type: 'string' },
                    total: { type: 'number' },
                    done: { type: 'number' },
                    failed: { type: 'number' },
                    path: { type: 'string' },
                    error: { type: 'string' },
                    jobs: { type: 'array', items: { type: 'object', additionalProperties: true } },
                },
            },
            render: (_args, value) => {
                if (Array.isArray(value.jobs)) {
                    return [{ type: 'text', text: value.jobs.length === 0 ? 'No scrape batches.' : `${value.jobs.length} scrape batch(es).` }];
                }
                const parts = [`Scrape ${value.state}: ${value.done}/${value.total} rows`];
                if (typeof value.failed === 'number' && value.failed > 0)
                    parts.push(`${value.failed} failed`);
                if (typeof value.path === 'string')
                    parts.push(value.path);
                if (typeof value.error === 'string')
                    parts.push(`error: ${value.error}`);
                return [{ type: 'text', text: parts.join(' — ') + '.' }];
            },
        },
        timeoutMs,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            assertAllowed('browser_scrape', exec);
            const browser = ctx.get('browser');
            if (browser === undefined)
                throw new Error('tool-browser: browser service unavailable');
            const action = typeof args.action === 'string' ? args.action : 'start';
            if (action === 'list') {
                return { jobs: (await browser.listScrapes()).map(job => ({ ...job })) };
            }
            if (action === 'status' || action === 'stop') {
                const id = typeof args.id === 'string' && args.id !== '' ? args.id : undefined;
                if (id === undefined)
                    throw new Error(`browser_scrape ${action} requires id`);
                const status = action === 'stop' ? await browser.stopScrape(id) : await browser.scrapeStatus(id);
                return { ...status };
            }
            const outPath = typeof args.outPath === 'string' && args.outPath !== '' ? args.outPath : undefined;
            if (outPath === undefined)
                throw new Error('browser_scrape start requires outPath');
            const session = await ensureSession(browser, taskKey(exec));
            const status = await browser.startScrape(session, {
                urls: (args.urls ?? []),
                script: typeof args.script === 'string' ? args.script : '',
                outPath,
                ...args.waitFor !== undefined ? { waitFor: args.waitFor } : {},
                ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
                ...args.concurrency !== undefined ? { concurrency: args.concurrency } : {},
            });
            return { ...status };
        },
    }));
}
/**
 * Test hook: inspect and reset plugin-level state (used by tests).
 *
 * @internal This is a test seam, not part of the supported tool API. It stays
 * exported because `test/tool-browser-session.test.mjs` imports
 * `internals.clearSession` by name to simulate a lost tool-layer cache; treat
 * everything reachable here as unstable and internal to this package.
 */
export const internals = {
    /** A copy of the per-task session map (task key -> provider session id). */
    get sessions() { return new Map(sessionsByTask); },
    /** Drop one task's mapping without closing the provider session. */
    clearSession(key = 'default') { sessionsByTask.delete(key); },
    /** Number of task queues still holding a tail; drains back to 0 when idle. */
    get operationTailCount() { return operationTails.size; },
};
