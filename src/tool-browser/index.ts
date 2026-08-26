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

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { BrowserSessionId } from '../browser/types.ts'

/** Plugin name used by loader diagnostics. */
export const name = 'tool-browser'
/** The tool registry, browser seam, and system-prompt registry this tool layer consumes. */
export const inject = ['tools', 'browser', 'systemPrompt']

/** Plugin config: tool timeouts and session defaults. */
export interface Config {
  /** Cooperative tool-call budget in ms. Default 60000. */
  readonly timeoutMs?: number
  /** Whether to offer tab-management tools. Default true. */
  readonly tabTools?: boolean
  /** Optional initial allow-list of browser tool names; other tools are refused. */
  readonly allowedActions?: readonly string[]
}

/** Per-task browser sessions, keyed by the calling DSH session id. */
const sessionsByTask = new Map<string, BrowserSessionId>()
/** In-flight first-open per task key, so concurrent first calls share one session. */
const pendingOpens = new Map<string, Promise<BrowserSessionId>>()
/** Tail promise for state-changing operations in one browser task. */
const operationTails = new Map<string, Promise<void>>()
/** In-flight identical read requests, keyed by task and canonical request shape. */
const pendingReads = new Map<string, Promise<unknown>>()

type ToolExecution = { agent?: { id?: string }; signal?: AbortSignal } | undefined

/** Queue one state-changing operation after prior work for the same task. */
function queueTaskOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const prior = operationTails.get(key) ?? Promise.resolve()
  const result = prior.catch(() => undefined).then(operation)
  operationTails.set(key, result.then(() => undefined, () => undefined))
  return result
}

/** Keep one identical read in flight per task instead of repeating CDP work. */
function coalesceTaskRead<T>(key: string, readKey: string, operation: () => Promise<T>): Promise<T> {
  const cacheKey = key + '\u0000' + readKey
  const existing = pendingReads.get(cacheKey)
  if (existing !== undefined) return existing as Promise<T>
  const result = operation().finally(() => pendingReads.delete(cacheKey))
  pendingReads.set(cacheKey, result)
  return result
}

/** Run a page-changing action with visible task status and FIFO ordering. */
async function withTaskAction<T>(
  browser: NonNullable<Context['browser']>,
  key: string,
  action: string,
  exec: ToolExecution,
  operation: (session: BrowserSessionId) => Promise<T>,
  label?: string,
): Promise<T> {
  const session = await ensureSession(browser, key, label)
  return queueTaskOperation(key, async () => {
    const task = await browser.getTask(session)
    if (task.control === 'human') {
      await browser.updateTask(session, { status: 'waiting-user', latestAction: 'waiting for user' })
      throw new Error('browser action is paused while the human controls this task')
    }
    await browser.updateTask(session, { status: 'running', latestAction: action })
    try {
      const result = await operation(session)
      const current = await browser.getTask(session).catch(() => undefined)
      await browser.updateTask(session, current?.control === 'human'
        ? { status: 'waiting-user', latestAction: 'waiting for user' }
        : { status: 'idle', latestAction: action })
      return result
    } catch (error) {
      const message = String(error)
      const current = await browser.getTask(session).catch(() => undefined)
      await browser.updateTask(session, current?.control === 'human'
        ? { status: 'waiting-user', latestAction: 'waiting for user' }
        : { status: 'failed', latestAction: action, error: message })
      throw error
    }
  })
}

/** Run and coalesce a read-only operation for the current task. */
async function withTaskRead<T>(
  browser: NonNullable<Context['browser']>,
  key: string,
  readKey: string,
  operation: (session: BrowserSessionId) => Promise<T>,
): Promise<T> {
  const session = await ensureSession(browser, key)
  return coalesceTaskRead(key, readKey, () => operation(session))
}

/**
 * Action restriction state: an allow-list of browser tool names, or undefined
 * for unrestricted. When set, any browser_* tool not in the list is refused
 * (browser_restrict itself is always allowed so the guard can be lifted).
 */
let restrictedTo: readonly string[] | undefined

/**
 * Guard one browser tool call against the active restriction. Refuses calls
 * not on the allow-list when a restriction is in effect.
 * @param toolName - the browser tool about to run.
 */
function assertAllowed(toolName: string): void {
  if (restrictedTo === undefined) return
  if (restrictedTo.includes(toolName)) return
  throw new Error(`browser action "${toolName}" is restricted (allow-list: ${restrictedTo.join(', ')})`)
}

/**
 * The task key for a tool call: the calling DSH session id, or the shared
 * default key when the call carries no agent context (CLI probes, tests).
 * @param exec - the tool-execution context; only its optional agent id is read.
 */
function taskKey(exec: { agent?: { id?: string } } | undefined): string {
  return exec?.agent?.id ?? 'default'
}

/**
 * Resolve the calling task's browser session, opening one on first use.
 * Concurrent first calls for the same key share a single open.
 * @param browser - the seam service.
 * @param key - the task key (see {@link taskKey}).
 * @param label - optional space name applied when the session is first opened.
 * @returns the task's session id.
 */
async function ensureSession(browser: NonNullable<Context['browser']>, key: string, label?: string): Promise<BrowserSessionId> {
  const existing = sessionsByTask.get(key)
  if (existing !== undefined) return existing
  const pending = pendingOpens.get(key)
  if (pending !== undefined) return pending
  const opening = browser.open({
    key,
    ...label !== undefined && label !== '' ? { label } : {},
  }).then(
    session => { sessionsByTask.set(key, session); pendingOpens.delete(key); return session },
    error => { pendingOpens.delete(key); throw error },
  )
  pendingOpens.set(key, opening)
  return opening
}

/** Coerce a tool-provided string value back to boolean/number only when lossless. */
function parseFillValue(v: string | undefined): string | number | boolean {
  if (v === 'true') return true
  if (v === 'false') return false
  if (v !== undefined && /^-?\d+(\.\d+)?$/.test(v) && String(Number(v)) === v) return Number(v)
  return v ?? ''
}

/** Format a snapshot element list for the model. */
function formatSnapshot(snapshot: {
  snapshotId?: string
  url: string
  title?: string
  elements: readonly { ref: number; kind: string; label: string; x: number; y: number; loc: string }[]
  truncated?: boolean
  challenge?: { blocked: boolean; kind?: string; reason?: string }
  userControlling?: boolean
}): string {
  const lines = snapshot.elements.map(el => `[${el.ref}] ${el.kind}: ${el.label} (${el.x},${el.y}) loc=${el.loc}`)
  const header = `URL: ${snapshot.url}${snapshot.title !== undefined ? `\nTitle: ${snapshot.title}` : ''}${snapshot.snapshotId !== undefined ? `\nSnapshot: ${snapshot.snapshotId}` : ''}`
  const body = lines.length > 0 ? lines.join('\n') : '(no interactive elements found)'
  const tail = snapshot.truncated === true ? '\n(snapshot truncated)' : ''
  const banner = snapshot.challenge?.blocked === true
    ? `\n\nCHALLENGE: ${snapshot.challenge.reason ?? 'human-verification'}. Do NOT keep retrying — ask the human to complete it in the shared browser window, then re-snapshot.`
    : ''
  const user = snapshot.userControlling === true
    ? '\n\nUSER CONTROL: the human is using this page. Do not operate the browser until they hand it back.'
    : ''
  return `${header}\n\n${body}${tail}${banner}${user}`
}

/** Register all browser tools with `ctx.tools`. */
export function apply(ctx: Context, config: Config = {}): void {
  const timeoutMs = config.timeoutMs ?? 60_000
  // Re-apply resets the restriction: an omitted allowedActions lifts it.
  restrictedTo = config.allowedActions !== undefined ? [...config.allowedActions] : undefined

  ctx.systemPrompt.section({
    name: 'tool:browser',
    // Tool guidance band is 100-199; 150 keeps clear of the common 110/120
    // tool sections so ordering does not depend on plugin load sequence.
    order: 150,
    text: 'Use the browser_* tools to operate a real shared browser the human can see and take over. Start with browser_snapshot, then use browser_click_ref or browser_scroll_into_view with its snapshotId and reference number whenever possible; re-snapshot if a reference is stale. Use browser_fill for forms and browser_back/browser_forward/browser_reload/browser_stop/browser_scroll for normal browser controls before resorting to browser_execute. browser_screenshot is for visual confirmation, not primary targeting. Keep the human informed of what you are doing on the page. Each task gets its own browser session: tabs and history are isolated from other tasks. browser_handoff state="waiting-user" marks a task for human action; do not operate page-changing tools while the user owns the task. If a snapshot or browser_challenge reports a CAPTCHA, stop retrying, hand off to the human, then re-check.',
  })

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
      assertAllowed('browser_open')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const key = taskKey(exec)
      return withTaskAction(browser, key, 'open page', exec, async session => {
        await browser.openUrl(session, {
          url: args.url,
          ...args.newTab === true ? { newTab: true } : {},
        }, exec.signal)
        const snapshot = await browser.snapshot(session, exec.signal)
        return {
          snapshotId: snapshot.snapshotId,
          url: snapshot.url,
          ...snapshot.title !== undefined ? { title: snapshot.title } : {},
          elements: snapshot.elements.map(el => ({ ref: el.ref, kind: el.kind, label: el.label, x: el.x, y: el.y, loc: el.loc })),
          truncated: snapshot.truncated,
          ...snapshot.challenge !== undefined ? { challenge: snapshot.challenge } : {},
          ...snapshot.userControlling !== undefined ? { userControlling: snapshot.userControlling } : {},
        }
      }, args.space)
    },
  }))


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
      assertAllowed('browser_back')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const navigated = await withTaskAction(browser, taskKey(exec), 'go back', exec, session => browser.back(session, exec.signal))
      return { navigated }
    },
  }))

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
      assertAllowed('browser_forward')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const navigated = await withTaskAction(browser, taskKey(exec), 'go forward', exec, session => browser.forward(session, exec.signal))
      return { navigated }
    },
  }))

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
      assertAllowed('browser_reload')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      await withTaskAction(browser, taskKey(exec), 'reload page', exec, session => browser.reload(session, exec.signal))
      return { reloaded: true }
    },
  }))

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
      assertAllowed('browser_stop')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      await withTaskAction(browser, taskKey(exec), 'stop loading', exec, session => browser.stopLoading(session, exec.signal))
      return { stopped: true }
    },
  }))

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
        if (value.label !== undefined) return [{ type: 'text', text: `Browser task named "${value.label}".` }]
        const spaces = value.spaces as Array<{ key: string; label: string }>
        const lines = spaces.length === 0 ? '(no browser tasks open)' : spaces.map(s => `${s.key}${s.label !== '' ? ` — ${s.label}` : ''}`).join('\n')
        return [{ type: 'text', text: `Browser tasks:\n${lines}` }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertAllowed('browser_space')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      if (args.label === undefined) {
        // LIST mode must not force-open a visible window just to enumerate
        // spaces: consult this task's session map before opening anything.
        const existing = sessionsByTask.get(taskKey(exec))
        if (existing === undefined) {
          const spaces = await browser.listSpaces()
          return { spaces: spaces.map(s => ({ key: s.key, label: s.label ?? '' })) }
        }
      }
      const session = await ensureSession(browser, taskKey(exec))
      if (args.label !== undefined) {
        await browser.setSpace(session, args.label)
        return { label: args.label }
      }
      const spaces = await browser.listSpaces()
      return { spaces: spaces.map(s => ({ key: s.key, label: s.label ?? '' })) }
    },
  }))


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
      render: (_args, value) => [{ type: 'text', text: (value.tasks as Array<{ key: string; label: string; active: boolean; tabs: number; status: string; control: string; latestAction?: string }>).map(task => `${task.active ? '*' : ' '} ${task.label || task.key} — ${task.status}, ${task.control}, ${task.tabs} tabs${task.latestAction !== undefined ? ` — ${task.latestAction}` : ''}`).join('\n') || '(no browser tasks open)' }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute() {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const tasks = await browser.listTasks()
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
      })) }
    },
  }))

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
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const key = taskKey(exec)
      const session = await ensureSession(browser, key)
      const task = await queueTaskOperation(key, () => browser.setHandoff(session, args.state as 'waiting-user' | 'agent'))
      return { key: task.key, label: task.label, status: task.status, control: task.control }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: 'Return an AI-friendly snapshot of the current shared-browser page: numbered interactive elements (inputs, buttons, links) the model can cite. Use this to understand an interactive page before driving it.',
    parameters: {},
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
    async execute(_args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const key = taskKey(exec)
      const snapshot = await withTaskRead(browser, key, 'snapshot', session => browser.snapshot(session, exec.signal))
      return {
        snapshotId: snapshot.snapshotId,
        url: snapshot.url,
        ...snapshot.title !== undefined ? { title: snapshot.title } : {},
        elements: snapshot.elements.map(el => ({ ref: el.ref, kind: el.kind, label: el.label, x: el.x, y: el.y, loc: el.loc })),
        truncated: snapshot.truncated,
        ...snapshot.challenge !== undefined ? { challenge: snapshot.challenge } : {},
        ...snapshot.userControlling !== undefined ? { userControlling: snapshot.userControlling } : {},
      }
    },
  }))


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
      assertAllowed('browser_click_ref')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      await withTaskAction(browser, taskKey(exec), 'click referenced element', exec, session => browser.clickRef(session, { snapshotId: args.snapshotId, ref: args.ref }, exec.signal))
      return { clicked: true }
    },
  }))

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
      assertAllowed('browser_scroll_into_view')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const result = await withTaskAction(browser, taskKey(exec), 'scroll referenced element into view', exec, session => browser.scrollIntoView(session, {
        snapshotId: args.snapshotId,
        ref: args.ref,
        ...args.block !== undefined ? { block: args.block as 'start' | 'center' | 'end' | 'nearest' } : {},
      }, exec.signal))
      return { scrolled: true, x: result.x, y: result.y, maxX: result.maxX, maxY: result.maxY }
    },
  }))

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
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const key = taskKey(exec)
      const challenge = await withTaskRead(browser, key, 'challenge', session => browser.detectChallenge(session, exec.signal))
      return {
        blocked: challenge.blocked,
        ...challenge.kind !== undefined ? { kind: challenge.kind } : {},
        ...challenge.reason !== undefined ? { reason: challenge.reason } : {},
        hint: challenge.blocked
          ? 'Ask the human to complete the verification in the shared browser window (the page is visible to them), then re-check with browser_snapshot.'
          : '',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_execute',
    description: 'Execute JavaScript in the shared-browser page context. This is the primary way to interact with page elements: focus, fill inputs (use the native value setter for framework-controlled inputs, then dispatch an input event), click buttons (element.click() or a constructed MouseEvent). Returns the evaluation result by value, or the exception text.',
    parameters: {
      script: { type: 'string', required: true, description: 'The JavaScript expression to evaluate in the page context.' },
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
      assertAllowed('browser_execute')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const result = await withTaskAction(browser, taskKey(exec), 'execute page script', exec, session => browser.execute(session, {
        script: args.script,
        args: args.args ?? [],
      }, exec.signal))
      if (result.ok) {
        const raw = result.value
        const value = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null)
        return { ok: true, value }
      }
      return { ok: false, exception: result.exception }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_content',
    description: 'Fetch the current shared-browser page content in a chosen format: html (raw DOM), markdown (structured reading), txt (plain text), or json. Optionally scope to a CSS selector and cap the length. Use this to read page content, not to interact.',
    parameters: {
      format: { type: 'string', required: true, enum: ['html', 'markdown', 'txt', 'json'], description: 'Output format.' },
      selector: { type: 'string', description: 'CSS selector limiting the fetch to one region (e.g. #main).' },
      maxChars: { type: 'number', description: 'Maximum characters of returned content.' },
      timeoutMs: { type: 'number', description: 'Evaluation timeout in ms (default 30000).' },
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
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const key = taskKey(exec)
      const readKey = 'content:' + JSON.stringify({ format: args.format, selector: args.selector, maxChars: args.maxChars, timeoutMs: args.timeoutMs })
      const result = await withTaskRead(browser, key, readKey, session => browser.content(session, {
        format: args.format,
        ...args.selector !== undefined ? { selector: args.selector } : {},
        ...args.maxChars !== undefined ? { maxChars: args.maxChars } : {},
        ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
      }, exec.signal))
      return { content: result.content, truncated: result.truncated }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click at viewport coordinates (CSS pixels) in the shared browser. Use with browser_screenshot: have a vision model locate an element on the screenshot, then click its coordinates — this covers icons, image buttons, and canvas elements that DOM snapshots cannot target. Coordinates are relative to the visible viewport, same as the screenshot.',
    parameters: {
      x: { type: 'number', required: true, description: 'Viewport x coordinate (CSS px), e.g. from a vision model reading the screenshot.' },
      y: { type: 'number', required: true, description: 'Viewport y coordinate (CSS px).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { clicked: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.clicked ? 'Clicked.' : 'Click failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed('browser_click')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      await withTaskAction(browser, taskKey(exec), 'click page', exec, session => browser.click(session, { x: args.x, y: args.y }, exec.signal))
      return { clicked: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_double_click',
    description: 'Double-click at viewport coordinates (CSS pixels) in the shared browser. Use for opening links, selecting text, or expanding UI that ignores single clicks.',
    parameters: {
      x: { type: 'number', required: true, description: 'Viewport x coordinate (CSS px).' },
      y: { type: 'number', required: true, description: 'Viewport y coordinate (CSS px).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { clicked: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.clicked ? 'Double-clicked.' : 'Double-click failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed('browser_double_click')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      await withTaskAction(browser, taskKey(exec), 'double-click page', exec, session => browser.doubleClick(session, { x: args.x, y: args.y }, exec.signal))
      return { clicked: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_hover',
    description: 'Move the pointer to viewport coordinates (CSS pixels) without clicking. Triggers hover states, tooltips, and dropdown menus',
    parameters: {
      x: { type: 'number', required: true, description: 'Viewport x coordinate (CSS px).' },
      y: { type: 'number', required: true, description: 'Viewport y coordinate (CSS px).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { hovered: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.hovered ? 'Hovered.' : 'Hover failed.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed('browser_hover')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      await withTaskAction(browser, taskKey(exec), 'hover page', exec, session => browser.hover(session, { x: args.x, y: args.y }, exec.signal))
      return { hovered: true }
    },
  }))


  ctx.tools.register(defineTool({
    name: 'browser_scroll',
    description: 'Scroll the active page by CSS-pixel deltas. With no deltas it scrolls downward by one viewport.',
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
      assertAllowed('browser_scroll')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const result = await withTaskAction(browser, taskKey(exec), 'scroll page', exec, session => browser.scroll(session, {
        ...args.deltaX !== undefined ? { deltaX: args.deltaX } : {},
        ...args.deltaY !== undefined ? { deltaY: args.deltaY } : {},
      }, exec.signal))
      return { x: result.x, y: result.y, maxX: result.maxX, maxY: result.maxY }
    },
  }))

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
      assertAllowed('browser_upload_file')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const result = await withTaskAction(browser, taskKey(exec), 'attach file', exec, session => browser.uploadFile(session, {
        filePath: args.filePath,
        ...args.selector !== undefined ? { selector: args.selector } : {},
      }, exec.signal))
      return { path: result.path }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_wait_for',
    description: 'Wait until an element matching a CSS selector appears (and is visible), polling every 250ms. Use before interacting with dynamically-loaded content (SPA views, toasts, menus).',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector to wait for.' },
      timeoutMs: { type: 'number', description: 'Total budget in ms (default 15000).' },
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
      assertAllowed('browser_wait_for')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const result = await withTaskAction(browser, taskKey(exec), 'wait for element', exec, session => browser.waitForElement(session, {
        selector: args.selector,
        ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
        ...args.visible !== undefined ? { visible: args.visible } : {},
      }, exec.signal))
      return { found: true, selector: result.selector, tag: result.tag, text: result.text }
    },
  }))

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
      assertAllowed('browser_type')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      await withTaskAction(browser, taskKey(exec), 'type text', exec, session => browser.type(session, { text: args.text }, exec.signal))
      return { typed: true }
    },
  }))

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
      assertAllowed('browser_press_key')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      await withTaskAction(browser, taskKey(exec), 'press key', exec, session => browser.pressKey(session, {
        key: args.key,
        ...args.modifiers !== undefined ? { modifiers: args.modifiers } : {},
      }, exec.signal))
      return { pressed: true }
    },
  }))

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
          const fields = value.fields as { ok: boolean; target: string; method?: string; error?: string }[]
          const failed = fields.filter(f => !f.ok)
          const lines = fields.map(f => `${f.ok ? 'OK' : 'FAIL'} ${f.target}${f.ok ? ` (${f.method ?? 'input'})` : `: ${f.error ?? 'unknown error'}`}`)
          const head = failed.length === 0
            ? `Filled ${fields.length}/${fields.length} fields${value.submitted ? ' and submitted the form' : ''}.`
            : `Filled ${fields.length - failed.length}/${fields.length} fields; ${failed.length} failed:`
          return head + '\n' + lines.join('\n')
        })(),
      }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed('browser_fill')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const fields = (args.fields ?? []).map((f: { selector?: string; name?: string; label?: string; placeholder?: string; kind?: string; value?: string }) => ({
        ...f.selector !== undefined ? { selector: f.selector } : {},
        ...f.name !== undefined ? { name: f.name } : {},
        ...f.label !== undefined ? { label: f.label } : {},
        ...f.placeholder !== undefined ? { placeholder: f.placeholder } : {},
        ...f.kind !== undefined ? { kind: f.kind as 'text' | 'textarea' | 'checkbox' | 'radio' | 'select' } : {},
        value: parseFillValue(f.value),
      }))
      const result = await withTaskAction(browser, taskKey(exec), 'fill form', exec, session => browser.fillForm(session, {
        fields,
        ...args.submit === true ? { submit: true } : {},
      }, exec.signal))
      return {
        fields: result.fields.map(f => ({ ok: f.ok, target: f.target, ...f.method !== undefined ? { method: f.method } : {}, ...f.error !== undefined ? { error: f.error } : {} })),
        submitted: result.submitted,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: 'Capture the current shared-browser page as a PNG screenshot. Use for visual confirmation of layout, charts, designs, or CAPTCHAs, or to feed a vision tool (read_image) that locates elements visually. Supports optional full-page capture and optional save-to-file (the saved path can be passed to read_image for vision-based element location).',
    parameters: {
      fullPage: { type: 'boolean', description: 'Capture the full scrollable page instead of the viewport (default false).' },
      savePath: { type: 'string', description: 'Absolute file path to also save the PNG to (e.g. for read_image vision location).' },
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
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const key = taskKey(exec)
      const capture = (session: BrowserSessionId) => browser.screenshot(session, {
        ...args.fullPage === true ? { fullPage: true } : {},
        ...args.savePath !== undefined ? { savePath: args.savePath } : {},
      }, exec.signal)
      const shot = args.savePath === undefined
        ? await withTaskRead(browser, key, 'screenshot:' + String(args.fullPage === true), capture)
        : await capture(await ensureSession(browser, key))
      return {
        dataUrl: shot.dataUrl,
        ...shot.path !== undefined ? { path: shot.path } : {},
      }
    },
  }))

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
          text: (value.tabs as { id: string; url: string; active: boolean }[])
            .map(t => `${t.active ? '*' : ' '} ${t.id} ${t.url}`).join('\n'),
        }],
      },
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const browser = ctx.get('browser')
        if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
        const session = await ensureSession(browser, taskKey(exec))
        const tabs = await browser.listTabs(session)
        return { tabs: tabs.map(t => ({ id: t.id, url: t.url, active: t.active })) }
      },
    }))

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
        assertAllowed('browser_switch_tab')
        const browser = ctx.get('browser')
        if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
        await withTaskAction(browser, taskKey(exec), 'switch tab', exec, session => browser.switchTab(session, args.tabId))
        return { switched: true }
      },
    }))

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
        assertAllowed('browser_close_tab')
        const browser = ctx.get('browser')
        if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
        await withTaskAction(browser, taskKey(exec), 'close tab', exec, session => browser.closeTab(session, args.tabId))
        return { closed: true }
      },
    }))

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
        assertAllowed('browser_reset')
        const browser = ctx.get('browser')
        if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
        await withTaskAction(browser, taskKey(exec), 'reset tabs', exec, session => browser.reset(session))
        return { reset: true }
      },
    }))
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
        const entries = value.entries as Array<{ seq: number; action: string; ok: boolean; params: Record<string, unknown>; result?: string; error?: string }>
        if (entries.length === 0) return [{ type: 'text', text: '(no recorded operations yet)' }]
        return [{
          type: 'text',
          text: entries.map(e => {
            const rawParams = JSON.stringify(e.params)
            const shownParams = rawParams.length > 300 ? rawParams.slice(0, 300) + '…' : rawParams
            return `#${e.seq} ${e.action} ${e.ok ? 'ok' : 'FAIL'} ${shownParams}${e.result !== undefined ? ` -> ${e.result}` : ''}${e.error !== undefined ? ` !! ${e.error}` : ''}`
          }).join('\n'),
        }]
      },
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, taskKey(exec))
      const entries = await browser.history(session)
      const rendered = entries.map(e => {
        const row: { seq: number; action: string; ok: boolean; params: unknown; result?: string; error?: string } = {
          seq: e.seq,
          action: e.action,
          ok: e.ok,
          params: JSON.parse(JSON.stringify(e.params)),
        }
        if (e.result !== undefined) row.result = e.result
        if (e.error !== undefined) row.error = e.error
        return row
      })
      return { entries: rendered as never }
    },
  }))

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
      assertAllowed('browser_replay')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      await withTaskAction(browser, taskKey(exec), 'replay browser action', exec, session => browser.replay(session, args.seq))
      return { replayed: true }
    },
  }))

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
      assertAllowed('browser_download')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const result = await withTaskAction(browser, taskKey(exec), 'download file', exec, session => browser.download(session, { url: args.url, savePath: args.savePath }, exec.signal))
      return { path: result.path }
    },
  }))

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
        text: `Session ${value.session}\n${(value.tabs as { id: string; url: string; active: boolean }[]).map(t => `${t.active ? '*' : ' '} ${t.id} ${t.url}`).join('\n')}`,
      }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, taskKey(exec))
      const tabs = await browser.listTabs(session)
      return { session, tabs: tabs.map(t => ({ id: t.id, url: t.url, active: t.active })) }
    },
  }))

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
      assertAllowed('browser_reset_session')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const key = taskKey(exec)
      const session = sessionsByTask.get(key)
      if (session !== undefined) {
        try {
          await browser.close(session)
        } finally {
          // Always forget the mapping so the next call opens a fresh session,
          // even if the provider close threw (the session is half-closed).
          sessionsByTask.delete(key)
        }
      }
      return { reset: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_restrict',
    description: 'Restrict which browser actions are allowed, to prevent stray clicks/navigation. Pass a list of browser tool names (e.g. ["browser_snapshot","browser_content","browser_click"]) — any other browser_* call is refused. Pass an empty list or omit to lift the restriction. Read-only tools (snapshot/content/screenshot/session/history/list_tabs/challenge) are never blocked.',
    parameters: {
      allowed: {
        type: 'array',
        items: { type: 'string' },
        description: 'Allow-list of browser tool names; empty clears the restriction.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { restrictedTo: { type: 'array', required: true, items: { type: 'string' } } } },
      render: (_args, value) => [{ type: 'text', text: (value.restrictedTo as string[]).length > 0 ? `Restricted to: ${(value.restrictedTo as string[]).join(', ')}` : 'Restriction lifted.' }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      // Always allowed so the guard can be lifted.
      const allowed = args.allowed ?? []
      const unknown = allowed.filter((t: string) => !t.startsWith('browser_'))
      if (unknown.length > 0) {
        throw new Error(`browser_restrict: unknown tool name(s) ${unknown.map(t => `"${t}"`).join(', ')} (must start with "browser_")`)
      }
      // Empty list (or omitted) lifts the restriction; a non-empty list is the
      // new allow-list.
      restrictedTo = allowed.length === 0 ? undefined : [...allowed]
      return { restrictedTo: restrictedTo === undefined ? [] : [...restrictedTo] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_auth',
    description: 'Export or restore the browser session\'s cookies (login state). Use "flush" to get a JSON cookie list (save it to a file to persist logins), or "restore" with that list to put logins back (e.g. after the browser host restarted). Available on the self-hosted browser.',
    parameters: {
      action: { type: 'string', required: true, enum: ['flush', 'restore'], description: 'flush = export cookies; restore = import cookies.' },
      cookies: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Cookie list to restore (required when action=restore).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cookies: { type: 'array', items: { type: 'object', additionalProperties: true } },
          restored: { type: 'number' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.cookies !== undefined ? `Exported ${(value.cookies as unknown[]).length} cookies.` : `Restored ${value.restored} cookies.` }],
    },
    timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed('browser_auth')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, taskKey(exec))
      if (args.action === 'flush') {
        const cookies = await browser.flushAuth(session)
        return { cookies: cookies.map(c => ({ ...c })) as never }
      }
      const list = (args.cookies ?? []) as unknown[]
      const restored = await browser.restoreAuth(session, list as never)
      return { restored }
    },
  }))
}

/** Test hook: inspect and reset the plugin-level session map (used by tests). */
export const internals = {
  /** A copy of the per-task session map (task key -> provider session id). */
  get sessions(): ReadonlyMap<string, BrowserSessionId> { return new Map(sessionsByTask) },
  /** Drop one task's mapping without closing the provider session. */
  clearSession(key = 'default'): void { sessionsByTask.delete(key) },
}

