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
 * @module dsh-browser/tool-browser
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
 * @returns the task's session id.
 */
async function ensureSession(browser: NonNullable<Context['browser']>, key: string): Promise<BrowserSessionId> {
  const existing = sessionsByTask.get(key)
  if (existing !== undefined) return existing
  const pending = pendingOpens.get(key)
  if (pending !== undefined) return pending
  const opening = browser.open().then(
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
  url: string
  title?: string
  elements: readonly { ref: number; kind: string; label: string; x: number; y: number }[]
  truncated?: boolean
  challenge?: { blocked: boolean; kind?: string; reason?: string }
  userControlling?: boolean
}): string {
  const lines = snapshot.elements.map(el => `[${el.ref}] ${el.kind}: ${el.label} (${el.x},${el.y})`)
  const header = `URL: ${snapshot.url}${snapshot.title !== undefined ? `\nTitle: ${snapshot.title}` : ''}`
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
    text: 'Use the browser_* tools to operate a real shared browser the human can see and take over. Locate elements by snapshot reference numbers (browser_snapshot) and drive them with browser_execute (DOM-referenced JS, native setters for framework inputs). For form filling prefer browser_fill, which handles controlled inputs, selects, checkboxes and radio groups in one batch. browser_screenshot is for visual confirmation, not primary targeting. Keep the human informed of what you are doing on the page. Each task gets its own browser session: your tabs and history are isolated from other tasks, so do not assume another task\'s navigation state is visible to you. If a snapshot or browser_challenge reports a human-verification challenge (CAPTCHA), stop retrying and ask the human to complete it in the shared browser window, then re-check.',
  })

  ctx.tools.register(defineTool({
    name: 'browser_open',
    description: 'Open a URL in the shared browser window. Opens this task\'s browser session on first use; optionally opens in a new tab. Returns the resulting page snapshot.',
    parameters: {
      url: { type: 'string', required: true, description: 'The URL to open (HTTP/HTTPS).' },
      newTab: { type: 'boolean', description: 'Open in a new tab instead of the active one.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
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
      const session = await ensureSession(browser, taskKey(exec))
      await browser.openUrl(session, {
        url: args.url,
        ...args.newTab === true ? { newTab: true } : {},
      }, exec.signal)
      const snapshot = await browser.snapshot(session, exec.signal)
      return {
        url: snapshot.url,
        ...snapshot.title !== undefined ? { title: snapshot.title } : {},
        elements: snapshot.elements.map(el => ({ ref: el.ref, kind: el.kind, label: el.label, x: el.x, y: el.y })),
        truncated: snapshot.truncated,
        ...snapshot.challenge !== undefined ? { challenge: snapshot.challenge } : {},
        ...snapshot.userControlling !== undefined ? { userControlling: snapshot.userControlling } : {},
      }
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
      const session = await ensureSession(browser, taskKey(exec))
      const snapshot = await browser.snapshot(session, exec.signal)
      return {
        url: snapshot.url,
        ...snapshot.title !== undefined ? { title: snapshot.title } : {},
        elements: snapshot.elements.map(el => ({ ref: el.ref, kind: el.kind, label: el.label, x: el.x, y: el.y })),
        truncated: snapshot.truncated,
        ...snapshot.challenge !== undefined ? { challenge: snapshot.challenge } : {},
        ...snapshot.userControlling !== undefined ? { userControlling: snapshot.userControlling } : {},
      }
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
      const session = await ensureSession(browser, taskKey(exec))
      const challenge = await browser.detectChallenge(session, exec.signal)
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
      const session = await ensureSession(browser, taskKey(exec))
      const result = await browser.execute(session, {
        script: args.script,
        args: args.args ?? [],
      }, exec.signal)
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
      const session = await ensureSession(browser, taskKey(exec))
      const result = await browser.content(session, {
        format: args.format,
        ...args.selector !== undefined ? { selector: args.selector } : {},
        ...args.maxChars !== undefined ? { maxChars: args.maxChars } : {},
        ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
      }, exec.signal)
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
      const session = await ensureSession(browser, taskKey(exec))
      await browser.click(session, { x: args.x, y: args.y }, exec.signal)
      return { clicked: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Type text into the focused element of the shared browser. Use after browser_execute focuses an input (e.g. el.focus()), or after a click lands in a field. Text is inserted at the current focus via CDP Input.insertText.',
    parameters: { text: { type: 'string', required: true, description: 'The text to insert.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { typed: { type: 'boolean', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.typed ? `Typed ${String(_args.text).length} chars.` : 'Type failed.' }] },
    timeoutMs, isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed('browser_type')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, taskKey(exec))
      await browser.type(session, { text: args.text }, exec.signal)
      return { typed: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_press_key',
    description: 'Press a key into the focused element of the shared browser (keyDown + keyUp, physical input).',
    parameters: { key: { type: 'string', required: true }, modifiers: { type: 'array', items: { type: 'string', enum: ['alt', 'ctrl', 'meta', 'shift'] } } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { pressed: { type: 'boolean', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.pressed ? `Pressed ${String(_args.key)}.` : 'Press failed.' }] },
    timeoutMs, isConcurrencySafe: () => false,
    async execute(args, exec) {
      assertAllowed('browser_press_key')
      const browser = ctx.get('browser')
      if (browser === undefined) throw new Error('tool-browser: browser service unavailable')
      const session = await ensureSession(browser, taskKey(exec))
      await browser.pressKey(session, { key: args.key, ...(args.modifiers !== undefined ? { modifiers: args.modifiers } : {}) }, exec.signal)
      return { pressed: true }
    },
  }))
}
