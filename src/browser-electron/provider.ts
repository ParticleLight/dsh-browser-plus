/**
 * Electron-backed browser provider: `WebContentsView` sessions driven over
 * `webContents.debugger` (CDP). The provider itself does not import Electron — it operates through the {@link ElectronBrowserViewHost} seam, which the
 * desktop shell implements with real Electron objects. That keeps this
 * package testable under plain Node and leaves the Electron dependency to the
 * shell that owns the `BrowserWindow`.
 * @module dsh-browser-plus/browser-electron
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import type {
  BrowserChallenge,
  BrowserContentRequest,
  BrowserContentResult,
  BrowserControlOwner,
  BrowserDoubleClickRequest,
  BrowserExecuteRequest,
  BrowserExecuteResult,
  BrowserFillRequest,
  BrowserFillResult,
  BrowserHandoffState,
  BrowserHistoryEntry,
  BrowserHoverRequest,
  BrowserOpenOptions,
  BrowserOpenRequest,
  BrowserPressKeyRequest,
  BrowserProvider,
  BrowserRefRequest,
  BrowserScrollIntoViewRequest,
  BrowserScrollRequest,
  BrowserScrollResult,
  BrowserSessionId,
  BrowserSnapshotElement,
  BrowserSnapshotResult,
  BrowserSpaceInfo,
  BrowserTab,
  BrowserTaskInfo,
  BrowserTaskStatus,
  BrowserTaskUpdate,
  BrowserUploadFileRequest,
  BrowserUploadFileResult,
  BrowserWaitForRequest,
  BrowserWaitForResult,
  ExportedCookie,
} from '../browser/types.ts'
import { BrowserError } from '../browser/types.ts'
import { PAGE_CHROME_HOST_ID, PAGE_CHROME_SCRIPT } from './page-chrome.ts'

/**
 * Page-context human-verification (CAPTCHA / bot-detection) detection. Runs
 * inside the page; returns `{ blocked, kind?, reason? }`. Marker-based and
 * best-effort: checks for Cloudflare's interstitial, hCaptcha, reCAPTCHA,
 * Turnstile, and generic challenge wording.
 */
const CHALLENGE_DETECT_EXPRESSION = `(() => {
  const title = (document.title || '').trim()
  const bodyText = (document.body && document.body.innerText || '').slice(0, 4000)
  const lower = (title + '\\n' + bodyText).toLowerCase()
  const frameSrcs = [...document.querySelectorAll('iframe')].map(f => f.src || '').join(' ')
  const framesLower = frameSrcs.toLowerCase()
  const hasCfInterstitial = /just a moment|checking your browser|attention required|cf_chl/i.test(lower)
    || !!document.querySelector('#challenge-running, #challenge-stage, #cf-chl-container')
  const hasHCaptcha = !!window.hcaptcha || !!document.querySelector('.h-captcha') || /hcaptcha\\.com/i.test(framesLower)
  const hasRecaptcha = !!window.grecaptcha || !!document.querySelector('.g-recaptcha') || /recaptcha\\/api|google\\.com\\/recaptcha/i.test(framesLower)
  const hasTurnstile = !!window.turnstile || /challenges\\.cloudflare\\.com/i.test(framesLower) || /turnstile|challenge-platform/i.test(lower)
  const verifyWording = /verify you are human|verify you are not a robot|\\u4eba\\u673a\\u9a8c\\u8bc1|\\u5b89\\u5168\\u9a8c\\u8bc1|enable javascript and cookies|\\u8bf7.*\\u9a8c\\u8bc1/i.test(lower)
  if (hasCfInterstitial) return { blocked: true, kind: 'cloudflare', reason: 'Cloudflare "Just a moment" interstitial' }
  if (hasHCaptcha) return { blocked: true, kind: 'hcaptcha', reason: 'hCaptcha verification' }
  if (hasRecaptcha) return { blocked: true, kind: 'recaptcha', reason: 'Google reCAPTCHA verification' }
  if (hasTurnstile) return { blocked: true, kind: 'turnstile', reason: 'Cloudflare Turnstile verification' }
  if (verifyWording && /challenge|captcha|verification|security check|access denied|blocked|\\u9a8c\\u8bc1/i.test(lower)) {
    return { blocked: true, kind: 'generic', reason: 'Human-verification challenge' }
  }
  return { blocked: false }
})()`

/** Short suppression window so CDP input is not misclassified as physical user input. */
const AGENT_INPUT_SUPPRESSION_MS = 900

/** Stable provider id registered with `ctx.browser`. */
export const ELECTRON_BROWSER_PROVIDER_ID = 'electron'

/**
 * The minimal Electron surface this provider needs. Implemented by the
 * desktop shell with a real `WebContentsView`; a fake implements it in tests.
 */
export interface ElectronBrowserViewHost {
  /**
   * Create a new browser view and return a handle to its webContents-like
   * surface. `key` (default 'default') identifies an isolated browser task in
   * the shared BrowserWindow; `label` names that task. The host owns view
   * attachment, sizing, task visibility, and removal; the provider owns
   * CDP-driven behavior.
   */
  createView(key?: string, label?: string): ElectronViewHandle
  /**
   * Destroy a view created by this host. Called on session close; idempotent
   * for an already-destroyed view.
   * @param handle - the handle returned by {@link createView}.
   */
  destroyView(handle: ElectronViewHandle): void
  /**
   * Notify the host that this session selected a tab. In the shared-window
   * host, a background task updates its active view without changing the
   * human-selected visible task. Optional for headless/probe hosts.
   * @param handle - the handle selected by its session.
   */
  showView?(handle: ElectronViewHandle): void
  /**
   * Append one operation to the human-facing trail for a view. Optional.
   * @param viewId - the view to attribute the operation to.
   * @param entry - the trail entry ({ action, params, ok, at }).
   */
  trace?(viewId: string, entry: unknown): void
  /** List browser tasks with their labels. Legacy method name retained for compatibility. */
  listWindows?(): Promise<Array<{ key: string; label: string }>>
  /** List task summaries when the host exposes a visible workspace. */
  listTasks?(): Promise<readonly BrowserTaskInfo[]>
  /** Read one task summary from the visible workspace. */
  getTask?(key: string): Promise<BrowserTaskInfo | undefined>
  /** Apply a task status/control update to the visible workspace. */
  updateTask?(key: string, update: BrowserTaskUpdate): Promise<BrowserTaskInfo | undefined>
}

/**
 * A CDP-capable view handle. This is the subset of Electron's
 * `WebContents`/`WebContentsView` the provider drives; the shell's real
 * implementation adapts `webContents.debugger` to it.
 */
export interface ElectronViewHandle {
  /** Unique id of the backing view, used for diagnostics. */
  readonly id: string
  /**
   * Send one CDP command and resolve with its result. Rejects when the
   * debugger is not attached or the command fails.
   * @param method - CDP method, e.g. `Page.navigate`.
   * @param params - CDP command parameters.
   * @returns the CDP `result` object.
   */
  sendCommand(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  /**
   * Read the most recent auto-accepted JS dialog for this view (and clear it).
   * Optional: hosts without JS-dialog supervision omit it.
   * @returns the dialog detail ({ type, message, prompt? }) or null.
   */
  clearDialog?(): Promise<unknown>
  /** Set this view's browser task label; it titles the shared window only when selected. Optional. */
  label?(label: string): Promise<void>
}

/** Internal selector and fingerprint captured for one snapshot element. */
interface SnapshotTarget {
  readonly path: string
  readonly fingerprint: string
}

/** One snapshot retained for exact reference operations. */
interface SnapshotRecord {
  readonly tabId: string
  readonly url: string
  readonly epoch: number
  readonly targets: ReadonlyMap<number, SnapshotTarget>
}

/** One tab inside a session: its view plus a stable id and short-lived refs. */
interface Tab {
  readonly id: string
  readonly handle: ElectronViewHandle
  navigationEpoch: number
  readonly snapshots: Map<string, SnapshotRecord>
}

/** Provider-local fallback state when a host has no visible workspace methods. */
interface LocalTaskState {
  status: BrowserTaskStatus
  control: BrowserControlOwner
  latestAction?: string
  error?: string
  updatedAt: number
}

/** One live browser session: an ordered list of tabs, one active. */
interface Session {
  readonly id: BrowserSessionId
  readonly taskKey: string
  taskLabel: string
  readonly tabs: Tab[]
  activeIndex: number
  /** Chronological operation log (navigate/execute/click/type/fill/download/auth). */
  readonly history: BrowserHistoryEntry[]
  /** Monotonic sequence counter for history entries (survives truncation). */
  nextSeq: number
}

/** Provider config: navigation admission defaults and snapshot caps. */
export interface ElectronBrowserProviderConfig {
  /** Allow navigation only to HTTP(S) URLs; reject anything else. Default true. */
  readonly httpOnly?: boolean
  /** Maximum snapshot elements before truncation. Default 60. */
  readonly snapshotMaxElements?: number
  /** Maximum content characters before truncation when no maxChars is given. Default 100_000. */
  readonly contentMaxChars?: number
}

/**
 * CDP method/params for `Page.navigate`, as sent to {@link ElectronViewHandle.sendCommand}.
 */
export interface CdpNavigateParams {
  readonly url: string
}

/**
 * CDP method/params for `Input.dispatchMouseEvent` (a click press+release pair).
 */
export interface CdpMouseParams {
  readonly type: 'mousePressed' | 'mouseReleased'
  readonly x: number
  readonly y: number
  readonly button: 'left'
  readonly clickCount: number
}

/** CDP method/params for `Input.insertText`. */
export interface CdpInsertTextParams {
  readonly text: string
}

/** CDP method/params for `Runtime.evaluate`. */
export interface CdpEvaluateParams {
  readonly expression: string
  readonly returnByValue: boolean
  readonly awaitPromise?: boolean
}

/** CDP method for a full-page screenshot capture. */
export const CDP_PAGE_CAPTURE_SCREENSHOT = 'Page.captureScreenshot'
/** CDP method for runtime evaluation (the execute path). */
export const CDP_RUNTIME_EVALUATE = 'Runtime.evaluate'
/** CDP method for keyboard input. */
export const CDP_INPUT_DISPATCH_KEY_EVENT = 'Input.dispatchKeyEvent'

const KEY_VK: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  CapsLock: 20,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  F1: 112,
  F2: 113,
  F3: 114,
  F4: 115,
  F5: 116,
  F6: 117,
  F7: 118,
  F8: 119,
  F9: 120,
  F10: 121,
  F11: 122,
  F12: 123,
}

function keyText(key: string): string | null {
  switch (key) {
    case 'Enter': return '\r'
    case 'Tab': return '\t'
    case 'Space': return ' '
    default: return /^[a-z0-9]$/i.test(key) ? key : null
  }
}

function keyDescriptor(key: string): { key: string; code: string; vk: number } {
  const upper = key.toUpperCase()
  // A physical Space produces e.key === ' ' with code 'Space'.
  if (key === 'Space') {
    return { key: ' ', code: 'Space', vk: KEY_VK.Space }
  }
  if (KEY_VK[key] !== undefined) {
    return { key, code: key, vk: KEY_VK[key] }
  }
  if (/^[a-z]$/i.test(key)) {
    // Unshifted letters deliver e.key lowercase; the code keeps the physical form.
    return { key, code: `Key${upper}`, vk: upper.charCodeAt(0) }
  }
  if (/^[0-9]$/.test(key)) {
    return { key, code: `Digit${key}`, vk: key.charCodeAt(0) }
  }
  throw new BrowserError(`browser: unsupported key "${key}"`, 'BROWSER_KEY_UNKNOWN')
}

function modifierMask(modifiers: readonly ('alt' | 'ctrl' | 'meta' | 'shift')[] | undefined): number {
  let mask = 0
  for (const mod of modifiers ?? []) {
    if (mod === 'alt') mask |= 1
    else if (mod === 'ctrl') mask |= 2
    else if (mod === 'meta') mask |= 4
    else if (mod === 'shift') mask |= 8
  }
  return mask
}
/** CDP method for navigation. */
export const CDP_PAGE_NAVIGATE = 'Page.navigate'
/** CDP methods used by native browser navigation controls. */
export const CDP_PAGE_GET_NAVIGATION_HISTORY = 'Page.getNavigationHistory'
export const CDP_PAGE_NAVIGATE_TO_HISTORY_ENTRY = 'Page.navigateToHistoryEntry'
export const CDP_PAGE_RELOAD = 'Page.reload'
export const CDP_PAGE_STOP_LOADING = 'Page.stopLoading'

/** Cap on content returned by a snapshot fetch to keep the wire bounded. */
const SNAPSHOT_LABEL_MAX = 120

/**
 * Browser provider over Electron views. Sessions hold an ordered list of
 * tabs; each tab is one view created by the host. The active tab receives
 * every operation; switching tabs calls the host's optional `showView` and
 * never loses state. Navigation is admitted only for HTTP(S) targets unless
 * {@link ElectronBrowserProviderConfig.httpOnly} is disabled.
 */
export class ElectronBrowserProvider implements BrowserProvider {
  readonly id = ELECTRON_BROWSER_PROVIDER_ID

  private readonly sessions = new Map<BrowserSessionId, Session>()
  private readonly taskStates = new Map<string, LocalTaskState>()
  private readonly httpOnly: boolean
  private readonly snapshotMaxElements: number
  private readonly contentMaxChars: number

  constructor(
    private readonly host: ElectronBrowserViewHost,
    config: ElectronBrowserProviderConfig = {},
  ) {
    this.httpOnly = config.httpOnly ?? true
    this.snapshotMaxElements = config.snapshotMaxElements ?? 60
    this.contentMaxChars = config.contentMaxChars ?? 100_000
  }

  /** Usable whenever the host can create views (always in the desktop shell). */
  available(): boolean {
    return true
  }

  /**
   * Open a NEW browser session with its own backing view. Every call mints a
   * fresh session id; per-task reuse is owned by the caller (the tool layer
   * caches one session per DSH task). Sessions keep isolated tabs, active tab,
   * and history while the host keeps one human-selected task view visible in
   * the shared BrowserWindow.
   */
  open(options?: BrowserOpenOptions): Promise<BrowserSessionId> {
    const taskKey = options?.key ?? 'default'
    const taskLabel = options?.label ?? ''
    const handle = this.host.createView(taskKey, taskLabel === '' ? undefined : taskLabel)
    const id = `browser:${randomUUID()}`
    this.sessions.set(id, { id, taskKey, taskLabel, tabs: [this.createTab(handle)], activeIndex: 0, history: [], nextSeq: 1 })
    if (!this.taskStates.has(taskKey)) {
      this.taskStates.set(taskKey, { status: 'idle', control: 'agent', updatedAt: Date.now() })
    }
    return Promise.resolve(id)
  }

  /** Open a URL in the active tab (default) or a new tab. */
  async openUrl(session: BrowserSessionId, request: BrowserOpenRequest, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    if (request.newTab === true) {
      this.newTab(s)
    }
    await this.navigate(session, { url: request.url }, signal)
  }

  /** List the session's tabs with their titles. */
  async listTabs(session: BrowserSessionId): Promise<readonly BrowserTab[]> {
    const s = this.session(session)
    const result: BrowserTab[] = []
    for (let i = 0; i < s.tabs.length; i++) {
      const tab = s.tabs[i]
      if (tab === undefined) continue // defensive: array can shift under concurrency
      result.push({
        id: tab.id,
        url: await this.currentUrl(tab.handle).catch(() => ''),
        active: i === s.activeIndex,
      })
    }
    return result
  }

  /** Switch to a tab by id; background task tabs stay hidden until user-selected. */
  switchTab(session: BrowserSessionId, tabId: string): Promise<void> {
    const s = this.session(session)
    const index = s.tabs.findIndex(tab => tab.id === tabId)
    if (index < 0) {
      throw new BrowserError(`browser: tab "${tabId}" is not open in this session`, 'BROWSER_TAB_UNKNOWN')
    }
    s.activeIndex = index
    this.showActive(s)
    return Promise.resolve()
  }

  /** Close one tab; closing the active tab activates the next. */
  closeTab(session: BrowserSessionId, tabId: string): Promise<void> {
    const s = this.session(session)
    const index = s.tabs.findIndex(tab => tab.id === tabId)
    if (index < 0) return Promise.resolve() // idempotent
    const removed = s.tabs[index]
    if (removed !== undefined) {
      s.tabs.splice(index, 1)
      this.host.destroyView(removed.handle)
    }
    if (s.tabs.length === 0) {
      // Session keeps one blank tab so it stays usable.
      this.newTab(s)
    } else if (index < s.activeIndex) {
      // Closing a tab before the active one shifts the array left; keep the
      // same tab active by decrementing the index.
      s.activeIndex -= 1
    } else if (s.activeIndex >= s.tabs.length) {
      // The active tab itself was closed; activate the last remaining one.
      s.activeIndex = s.tabs.length - 1
    }
    this.showActive(s)
    return Promise.resolve()
  }

  /** Close every tab and reset to one blank tab. */
  reset(session: BrowserSessionId): Promise<void> {
    const s = this.session(session)
    for (const tab of s.tabs) this.host.destroyView(tab.handle)
    s.tabs.length = 0
    this.newTab(s)
    s.activeIndex = 0
    this.showActive(s)
    return Promise.resolve()
  }

  /** Navigate the active tab's view to a URL, honoring HTTP(S)-only admission. */
  async navigate(session: BrowserSessionId, request: { readonly url: string }, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    const { handle } = tab
    const url = request.url
    try {
      if (this.httpOnly) {
        let parsed: URL
        try {
          parsed = new URL(url)
        } catch {
          throw new BrowserError(`browser: refusing navigation to unparseable URL "${url}"`, 'BROWSER_NAVIGATION_BLOCKED')
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new BrowserError(`browser: refusing navigation to non-HTTP(S) URL "${url}"`, 'BROWSER_NAVIGATION_BLOCKED')
        }
      }
      signal?.throwIfAborted()
      // Page.navigate can hang on an unreachable/slow host; bound it like the
      // evaluate paths so a wedged navigation surfaces as an error instead of
      // blocking the tool call forever.
      const timeoutMs = 30_000
      const result = await withTimeout(
        handle.sendCommand(CDP_PAGE_NAVIGATE, { url } satisfies CdpNavigateParams),
        timeoutMs,
        signal,
        `browser: navigation timed out after ${timeoutMs}ms`,
      )
      // Page.navigate resolves even when the navigation fails; surface the
      // failure instead of leaving a silent white screen.
      const errorText = (result as { errorText?: string }).errorText
      if (typeof errorText === 'string' && errorText !== '') {
        throw new BrowserError(`browser: navigation to "${url}" failed: ${errorText}`, 'BROWSER_NAVIGATION_FAILED')
      }
      this.invalidateSnapshots(tab)
      this.record(s, 'navigate', { url }, true)
      this.showActive(s)
      // Page.navigate resolves on commit. Wait best-effort for page load so
      // browser_open does not snapshot a still-blank renderer.
      await waitForDocumentReady(handle, signal)
      // Human chrome is page-injected: reapply after every document commit so
      // the toolbar is present after each navigation.
      void reinstallPageChrome(handle)
    } catch (error) {
      if (!(error instanceof BrowserError && (error as { code?: string }).code === 'BROWSER_NAVIGATION_BLOCKED')) {
        this.record(s, 'navigate', { url }, false, { error: String(error) })
      }
      throw error
    }
  }

  /** Navigate to the previous history entry when one exists. */
  async back(session: BrowserSessionId, signal?: AbortSignal): Promise<boolean> {
    return this.navigateHistory(session, -1, 'back', signal)
  }

  /** Navigate to the next history entry when one exists. */
  async forward(session: BrowserSessionId, signal?: AbortSignal): Promise<boolean> {
    return this.navigateHistory(session, 1, 'forward', signal)
  }

  /** Reload the active page and restore the browser chrome afterwards. */
  async reload(session: BrowserSessionId, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    await withTimeout(tab.handle.sendCommand(CDP_PAGE_RELOAD, {}), 30_000, signal, 'browser: reload timed out after 30000ms')
    this.invalidateSnapshots(tab)
    this.record(s, 'reload', {}, true)
    this.showActive(s)
    await waitForDocumentReady(tab.handle, signal)
    void reinstallPageChrome(tab.handle)
  }

  /** Stop loading the active page. */
  async stopLoading(session: BrowserSessionId, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    await withTimeout(handle.sendCommand(CDP_PAGE_STOP_LOADING, {}), 10_000, signal, 'browser: stop loading timed out after 10000ms')
    this.record(s, 'stop', {}, true)
  }

  /** Execute JS in the active tab's page context. */
  async execute(session: BrowserSessionId, request: BrowserExecuteRequest, signal?: AbortSignal): Promise<BrowserExecuteResult> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, handle)
    try {
      // Wrap the script in a Function so `return` statements are legal and
      // request.args arrive as `arguments[0..n]`. A bare script handed to CDP
      // Runtime.evaluate is an expression context — a leading `return` would
      // be a syntax error, and an object-literal script (`{...}`) would parse
      // as a block. So: if the script already starts with `return`, use it as
      // the body verbatim; otherwise wrap it as `return (expr)` so both
      // expression and object-literal forms evaluate to their value. Args are
      // embedded as a JSON array literal; unserializable members become null.
      const body = /^\s*return\b/.test(request.script)
        ? request.script
        : `return (${request.script})`
      const hasArgs = request.args !== undefined && request.args.length > 0
      const expression = hasArgs
        ? `(function(){ const __dshArgs = ${JSON.stringify(request.args)}; return Function(${JSON.stringify(body)}).apply(null, __dshArgs) })()`
        : `(function(){ return Function(${JSON.stringify(body)})() })()`
      // CDP Runtime.evaluate can hang indefinitely on a not-yet-loaded page
      // (navigate returned but the renderer has not committed). Bound it so a
      // stuck call surfaces as BROWSER_EXECUTE_TIMEOUT instead of wedging the
      // whole tool call. The caller's signal wins when it fires first.
      const timeoutMs = request.timeoutMs ?? 30_000
      const result = await withTimeout(
        handle.sendCommand(CDP_RUNTIME_EVALUATE, {
          expression,
          returnByValue: true,
          awaitPromise: true,
        } satisfies CdpEvaluateParams),
        timeoutMs,
        signal,
        `browser: execute timed out after ${timeoutMs}ms`,
      )
      if (result.exceptionDetails !== undefined) {
        const detail = result.exceptionDetails as { text?: string; exception?: { description?: string } }
        const exception = detail.exception?.description ?? detail.text ?? 'unknown exception'
        this.record(s, 'execute', { script: request.script }, false, { error: exception })
        return { ok: false, exception }
      }
      const value = (result.result as { value?: unknown } | undefined)?.value ?? null
      this.record(s, 'execute', {
        script: request.script,
        ...request.args !== undefined && request.args.length > 0 ? { args: request.args } : {},
      }, true, { result: typeof value === 'string' ? value.slice(0, 500) : JSON.stringify(value).slice(0, 500) })
      return { ok: true, value }
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new BrowserError(`browser: execute timed out after ${request.timeoutMs ?? 30_000}ms`, 'BROWSER_EXECUTE_TIMEOUT', { cause: error })
      }
      throw new BrowserError(`browser: execute failed: ${String(error)}`, 'BROWSER_EXECUTE_FAILED', { cause: error })
    }
  }

  /** Produce an AI-friendly snapshot of the active tab. */
  async snapshot(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserSnapshotResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, tab.handle)
    const script = `(() => {
      const cap = ${String(this.snapshotMaxElements)}
      const locatorOf = (el) => {
        if (el.id) return '#' + CSS.escape(el.id)
        if (el.name) return '[name=' + JSON.stringify(el.name) + ']'
        const aria = el.getAttribute('aria-label')
        if (aria) return '[aria-label=' + JSON.stringify(aria) + ']'
        const tag = el.tagName.toLowerCase()
        const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30)
        if (text) return tag + ':has-text("' + text.replace(/"/g, '\\\\"') + '")'
        return tag
      }
      const pathOf = (el) => {
        if (el.id) return '#' + CSS.escape(el.id)
        const parts = []
        let node = el
        while (node && node.nodeType === Node.ELEMENT_NODE) {
          let part = node.tagName.toLowerCase()
          const parent = node.parentElement
          if (parent) {
            const siblings = [...parent.children].filter(sibling => sibling.tagName === node.tagName)
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'
          }
          parts.unshift(part)
          if (node === document.body) break
          node = parent
        }
        return parts.join(' > ')
      }
      const fingerprintOf = (el) => [
        el.tagName,
        el.getAttribute('type') || '',
        el.id || '',
        el.getAttribute('name') || '',
        el.getAttribute('aria-label') || '',
        (el.textContent || el.value || '').toString().replace(/\s+/g, ' ').trim().slice(0, 120),
      ].join('\u001f')
      const url = location.href
      const title = document.title || undefined
      const els = [...document.querySelectorAll('input, textarea, select, button, a[href], [role="button"], [role="searchbox"], [contenteditable="true"]')]
      const out = []
      for (const el of els) {
        if (out.length >= cap) break
        if (el.closest('[data-dsh-browser-chrome]')) continue
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        if (r.width < 4 || r.height < 4 || cs.visibility === 'hidden' || cs.display === 'none') continue
        const kind = el.tagName === 'INPUT' ? (el.type === 'checkbox' ? 'checkbox' : (el.type === 'submit' || el.type === 'button' ? 'button' : 'input'))
          : el.tagName === 'TEXTAREA' ? 'textarea'
          : el.tagName === 'SELECT' ? 'select'
          : el.tagName === 'BUTTON' ? 'button'
          : el.tagName === 'A' ? 'link' : 'other'
        const label = (el.getAttribute('aria-label') || el.placeholder || el.textContent || el.value || el.name || el.id || '').toString().replace(/\\s+/g, ' ').trim().slice(0, ${String(SNAPSHOT_LABEL_MAX)})
        if (!label && kind !== 'link') continue
        out.push({
          ref: out.length + 1,
          kind,
          label,
          selector: el.id ? '#' + CSS.escape(el.id) : (el.name ? '[name=' + JSON.stringify(el.name) + ']' : ''),
          loc: locatorOf(el),
          path: pathOf(el),
          fingerprint: fingerprintOf(el),
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
        })
      }
      const challenge = ${CHALLENGE_DETECT_EXPRESSION}
      const chromeHost = document.getElementById('__dsh_browser_chrome_host__')
      const userControlling = chromeHost?.getAttribute('data-dsh-user-active') === '1'
      return { url, title, elements: out, truncated: out.length >= cap, challenge, userControlling }
    })()`
    // Same hang guard as execute: a renderer that has not committed after
    // navigate would otherwise block snapshot forever.
    const timeoutMs = 30_000
    const result = await withTimeout(
      handleSendEvaluate(tab.handle, script),
      timeoutMs,
      signal,
      `browser: snapshot timed out after ${timeoutMs}ms`,
    )
    if (!result.ok) throw new BrowserError(`browser: snapshot evaluation failed: ${result.exception}`, 'BROWSER_SNAPSHOT_FAILED')
    type RawSnapshotElement = BrowserSnapshotElement & { readonly path: string; readonly fingerprint: string }
    type RawSnapshot = Omit<BrowserSnapshotResult, 'snapshotId' | 'elements'> & { readonly elements: readonly RawSnapshotElement[] }
    let value = result.value as RawSnapshot
    // Framework apps often hydrate controls after the load event. A short
    // bounded retry turns premature empty inventories into useful snapshots.
    for (let attempt = 0; attempt < 5 && value.elements.length === 0 && value.truncated !== true; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 400))
      const retry = await withTimeout(
        handleSendEvaluate(tab.handle, script),
        timeoutMs,
        signal,
        `browser: snapshot timed out after ${timeoutMs}ms`,
      ).catch(() => undefined)
      if (retry?.ok) value = retry.value as RawSnapshot
    }
    const snapshotId = `snapshot:${randomUUID()}`
    const targets = new Map<number, SnapshotTarget>()
    for (const element of value.elements) {
      targets.set(element.ref, { path: element.path, fingerprint: element.fingerprint })
    }
    tab.snapshots.set(snapshotId, { tabId: tab.id, url: value.url, epoch: tab.navigationEpoch, targets })
    while (tab.snapshots.size > 10) {
      const oldest = tab.snapshots.keys().next().value as string | undefined
      if (oldest === undefined) break
      tab.snapshots.delete(oldest)
    }
    return {
      snapshotId,
      url: value.url,
      ...value.title !== undefined ? { title: value.title } : {},
      elements: value.elements.map(({ path: _path, fingerprint: _fingerprint, ...element }) => element),
      truncated: value.truncated,
      ...value.challenge !== undefined ? { challenge: value.challenge } : {},
      ...value.userControlling !== undefined ? { userControlling: value.userControlling } : {},
    }
  }

  /** Click one element that belongs to a retained exact page snapshot. */
  async clickRef(session: BrowserSessionId, request: BrowserRefRequest, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, tab.handle)
    const point = await this.resolveSnapshotTarget(tab, request, 'center', signal)
    await suppressAutoUserControl(tab.handle, signal)
    await tab.handle.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 } satisfies CdpMouseParams)
    await tab.handle.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 } satisfies CdpMouseParams)
    this.record(s, 'clickRef', { snapshotId: request.snapshotId, ref: request.ref }, true)
  }

  /** Scroll one element that belongs to a retained exact page snapshot into view. */
  async scrollIntoView(session: BrowserSessionId, request: BrowserScrollIntoViewRequest, signal?: AbortSignal): Promise<BrowserScrollResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const result = await this.resolveSnapshotTarget(tab, request, request.block ?? 'center', signal)
    this.record(s, 'scrollIntoView', { snapshotId: request.snapshotId, ref: request.ref, block: request.block ?? 'center' }, true)
    return result
  }

  /** Check whether a human-verification challenge is blocking the active tab. */
  async detectChallenge(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserChallenge> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const timeoutMs = 15_000
    const result = await withTimeout(
      handleSendEvaluate(tab.handle, CHALLENGE_DETECT_EXPRESSION),
      timeoutMs,
      signal,
      `browser: challenge detection timed out after ${timeoutMs}ms`,
    )
    if (!result.ok) {
      throw new BrowserError(`browser: challenge detection failed: ${result.exception}`, 'BROWSER_CHALLENGE_DETECT_FAILED')
    }
    const value = result.value as BrowserChallenge
    return { blocked: value.blocked === true, kind: value.kind, reason: value.reason }
  }

  /** Fetch page content in a requested format. */
  async content(session: BrowserSessionId, request: BrowserContentRequest, signal?: AbortSignal): Promise<BrowserContentResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, tab.handle)
    const maxChars = request.maxChars ?? this.contentMaxChars
    const selector = request.selector ?? ''
    const format = request.format
    const script = `(() => {
      const root = ${selector === '' ? 'document.body' : `document.querySelector(${JSON.stringify(selector)})`}
      if (!root) return { ok: false, reason: 'selector not found' }
      const fmt = ${JSON.stringify(format)}
      let content = ''
      if (fmt === 'txt') content = root.innerText || ''
      else if (fmt === 'html') content = root.outerHTML || ''
      else if (fmt === 'json') content = JSON.stringify(root)
      else {
        // markdown: headings, paragraphs, links, lists (best-effort)
        const parts = []
        const walk = (node) => {
          if (node.nodeType === Node.TEXT_NODE) { const t = (node.textContent || '').trim(); if (t) parts.push(t); return }
          if (node.nodeType !== Node.ELEMENT_NODE) return
          const tag = node.tagName.toLowerCase()
          if (tag === 'script' || tag === 'style' || tag === 'noscript') return
          if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') parts.push('\\n' + '#'.repeat(Number(tag[1])) + ' ' + (node.textContent || '').trim() + '\\n')
          else if (tag === 'a') { const t = (node.textContent || '').trim(); if (t) parts.push('[' + t + '](' + (node.href || '') + ')') }
          else if (tag === 'li') parts.push('  - ' + (node.textContent || '').trim())
          else if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') { const t = (node.textContent || '').trim(); if (t) parts.push(t + '\\n') }
          else { for (const child of node.childNodes) walk(child) }
        }
        if (root.nodeType === Node.TEXT_NODE) walk(root)
        else for (const child of root.childNodes) walk(child)
        // Join without a separator: each part already carries its own trailing
        // newline, so a space join would smear headings/links into run-on text.
        content = parts.join('')
      }
      const truncated = content.length > ${String(maxChars)}
      return { ok: true, content: content.slice(0, ${String(maxChars)}), truncated }
    })()`
    // Honor a per-call timeout: content evaluation can hang on a heavy page,
    // so a caller-supplied budget bounds it. Unlike a bare signal entry check,
    // withTimeout also interrupts a call already in flight.
    const timeoutMs = request.timeoutMs ?? 30_000
    const result = await withTimeout(
      handleSendEvaluate(tab.handle, script),
      timeoutMs,
      signal,
      `browser: content timed out after ${timeoutMs}ms`,
    )
    if (!result.ok) throw new BrowserError(`browser: content evaluation failed: ${result.exception}`, 'BROWSER_CONTENT_FAILED')
    const value = result.value as { ok: boolean; reason?: string; content?: string; truncated?: boolean }
    if (!value.ok) throw new BrowserError(`browser: content fetch failed: ${value.reason ?? 'unknown'}`, 'BROWSER_CONTENT_FAILED')
    return { content: value.content ?? '', truncated: value.truncated ?? false }
  }

  /** Click at viewport coordinates (CDP mousePressed + mouseReleased). */
  async click(session: BrowserSessionId, request: { readonly x: number; readonly y: number }, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, handle)
    await suppressAutoUserControl(handle, signal)
    await handle.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: request.x, y: request.y, button: 'left', clickCount: 1 } satisfies CdpMouseParams)
    await handle.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: request.x, y: request.y, button: 'left', clickCount: 1 } satisfies CdpMouseParams)
    this.record(s, 'click', { x: request.x, y: request.y }, true)
  }

  /** Double-click at viewport coordinates (physical input; clickCount 2). */
  async doubleClick(session: BrowserSessionId, request: BrowserDoubleClickRequest, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, handle)
    await suppressAutoUserControl(handle, signal)
    await handle.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: request.x, y: request.y, button: 'left', clickCount: 2 } satisfies CdpMouseParams)
    await handle.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: request.x, y: request.y, button: 'left', clickCount: 2 } satisfies CdpMouseParams)
    this.record(s, 'doubleClick', { x: request.x, y: request.y }, true)
  }

  /** Move the pointer to viewport coordinates (hover; no click). */
  async hover(session: BrowserSessionId, request: BrowserHoverRequest, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, handle)
    await handle.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: request.x, y: request.y, button: 'none' })
    this.record(s, 'hover', { x: request.x, y: request.y }, true)
  }

  /** Scroll the active page by CSS-pixel deltas and return the final position. */
  async scroll(session: BrowserSessionId, request: BrowserScrollRequest, signal?: AbortSignal): Promise<BrowserScrollResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const deltaX = request.deltaX ?? 0
    const deltaY = request.deltaY ?? 0
    const hasExplicitDelta = request.deltaX !== undefined || request.deltaY !== undefined
    const script = `(() => {
      const deltaX = ${JSON.stringify(deltaX)}
      const deltaY = ${JSON.stringify(deltaY)}
      const hasExplicitDelta = ${JSON.stringify(hasExplicitDelta)}
      const effectiveDeltaY = hasExplicitDelta ? deltaY : Math.max(window.innerHeight * 0.8, 480)
      window.scrollBy(deltaX, effectiveDeltaY)
      const root = document.documentElement
      return {
        x: window.scrollX,
        y: window.scrollY,
        maxX: Math.max(0, root.scrollWidth - window.innerWidth),
        maxY: Math.max(0, root.scrollHeight - window.innerHeight),
      }
    })()`
    const result = await withTimeout(handleSendEvaluate(tab.handle, script), 15_000, signal, 'browser: scroll timed out')
    if (!result.ok) throw new BrowserError(`browser: scroll failed: ${result.exception}`, 'BROWSER_SCROLL_FAILED')
    const value = result.value as Partial<BrowserScrollResult>
    if (typeof value.x !== 'number' || typeof value.y !== 'number' || typeof value.maxX !== 'number' || typeof value.maxY !== 'number') {
      throw new BrowserError('browser: scroll returned invalid coordinates', 'BROWSER_SCROLL_FAILED')
    }
    this.record(s, 'scroll', { deltaX, deltaY: hasExplicitDelta ? deltaY : 'viewport' }, true)
    return { x: value.x, y: value.y, maxX: value.maxX, maxY: value.maxY }
  }

  /**
   * Attach a local file to the first matching file input. Uses the CDP DOM
   * domain (nodeId path), which — unlike a synthetic change event — makes the
   * input's files list true (real file selection), so pages that read
   * input.files or upload on change behave exactly like a real pick.
   */
  async uploadFile(session: BrowserSessionId, request: BrowserUploadFileRequest, signal?: AbortSignal): Promise<BrowserUploadFileResult> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, handle)
    const selector = request.selector ?? 'input[type="file"]'
    const doc = await handle.sendCommand('DOM.getDocument', {})
    const root = (doc as { root?: { nodeId?: number } }).root
    const rootId = root?.nodeId
    if (rootId === undefined) {
      throw new BrowserError('browser: could not resolve the document node', 'BROWSER_UPLOAD_FAILED')
    }
    const query = await handle.sendCommand('DOM.querySelector', { nodeId: rootId, selector })
    const nodeId = (query as { nodeId?: number }).nodeId
    if (nodeId === undefined || nodeId === 0) {
      throw new BrowserError(`browser: no file input matches "${selector}"`, 'BROWSER_UPLOAD_NO_INPUT')
    }
    await handle.sendCommand('DOM.setFileInputFiles', { files: [request.filePath], nodeId })
    this.record(s, 'uploadFile', { filePath: request.filePath, selector }, true, { result: '1 file attached' })
    return { path: request.filePath }
  }

  /**
   * Poll until an element matching the selector exists (and is visible).
   * Bounds the total wait; a timeout surfaces as BROWSER_WAIT_TIMEOUT.
   */
  async waitForElement(session: BrowserSessionId, request: BrowserWaitForRequest, signal?: AbortSignal): Promise<BrowserWaitForResult> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    const timeoutMs = request.timeoutMs ?? 15_000
    const visible = request.visible !== false
    const selector = request.selector
    const script = `(() => {
      let el = null
      try { el = document.querySelector(${JSON.stringify(selector)}) } catch (e) { return { error: String(e) } }
      if (!el) return null
      if (${visible}) {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        if (r.width < 4 || r.height < 4 || cs.visibility === 'hidden' || cs.display === 'none') return null
      }
      return {
        found: true,
        selector: ${JSON.stringify(selector)},
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      }
    })()`
    const deadline = Date.now() + timeoutMs
    let lastError: string | undefined
    while (Date.now() <= deadline) {
      signal?.throwIfAborted()
      const result = await withTimeout(handleSendEvaluate(handle, script, signal), Math.max(deadline - Date.now(), 250), signal, 'browser: wait poll timed out').catch((error: unknown): BrowserExecuteResult => ({ ok: false, exception: String(error) }))
      if (!result.ok) {
        lastError = result.exception
      } else {
        const value = result.value as { found?: boolean; tag?: string; text?: string; error?: string } | null
        if (value?.found === true && typeof value.tag === 'string') {
          this.record(s, 'waitForElement', { selector, timeoutMs, visible }, true, { result: value.tag })
          return { found: true, selector, tag: value.tag, text: value.text ?? '' }
        }
        if (value?.error !== undefined) lastError = value.error
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(deadline - Date.now(), 1))))
    }
    throw new BrowserError(`browser: element "${selector}" did not appear within ${timeoutMs}ms${lastError !== undefined ? ` (${lastError})` : ''}`, 'BROWSER_WAIT_TIMEOUT')
  }

  /** Type into the focused element. */
  async type(session: BrowserSessionId, request: { readonly text: string }, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, handle)
    await suppressAutoUserControl(handle, signal)
    await handle.sendCommand('Input.insertText', { text: request.text } satisfies CdpInsertTextParams)
    // Store the full text so replay re-issues the same input; the history
    // tool truncates long values when rendering.
    this.record(s, 'type', { text: request.text }, true)
  }

  /** Press a key into the page (keyDown + keyUp), as a physical-input path
   * for shortcuts and keyboard-driven UI. */
  async pressKey(session: BrowserSessionId, request: BrowserPressKeyRequest, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, handle)
    await suppressAutoUserControl(handle, signal)
    const { key, code, vk } = keyDescriptor(request.key)
    const modifiers = modifierMask(request.modifiers)
    const text = keyText(request.key)
    const down: Record<string, unknown> = { type: text === null ? 'rawKeyDown' : 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
    if (text !== null) { down.text = text; down.unmodifiedText = text }
    await handle.sendCommand(CDP_INPUT_DISPATCH_KEY_EVENT, down)
    await handle.sendCommand(CDP_INPUT_DISPATCH_KEY_EVENT, { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
    this.record(s, 'pressKey', { key: request.key, ...(request.modifiers !== undefined && request.modifiers.length > 0 ? { modifiers: request.modifiers } : {}) }, true)
  }

  /**
   * Fill a form's fields in one batch. Runs one page-context script that
   * resolves each field (selector, or name/label/placeholder among visible
   * controls), sets its value with the native prototype setter (React/Vue
   * controlled inputs included) plus input/change events, handles
   * select/checkbox/radio/contenteditable, and optionally submits the form.
   */
  async fillForm(session: BrowserSessionId, request: BrowserFillRequest, signal?: AbortSignal): Promise<BrowserFillResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, tab.handle)
    const specs = JSON.stringify(request.fields.map(f => ({
      selector: f.selector ?? null,
      name: f.name ?? null,
      label: f.label ?? null,
      placeholder: f.placeholder ?? null,
      kind: f.kind ?? 'text',
      value: f.value,
    })))
    const submitFlag = request.submit === true
    const script = `(() => {
      const specs = ${specs}
      const out = []
      const setNative = (el, proto, value) => {
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (setter) setter.call(el, value)
        else el.value = value
      }
      const visible = (el) => {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return r.width >= 4 && r.height >= 4 && cs.visibility !== 'hidden' && cs.display !== 'none'
      }
      const describe = (spec) => spec.selector || spec.name || spec.label || spec.placeholder || '(unspecified)'
      const matches = (el, spec) => {
        if (spec.selector) { try { return el.matches(spec.selector) } catch { return false } }
        if (spec.name && el.name === spec.name) return true
        if (spec.placeholder && el.placeholder === spec.placeholder) return true
        if (spec.label) {
          if (el.getAttribute('aria-label') === spec.label) return true
          if (el.id) {
            const lbl = document.querySelector('label[for=' + JSON.stringify(el.id) + ']')
            if (lbl && (lbl.textContent || '').trim() === spec.label) return true
          }
          const wrap = el.closest('label')
          if (wrap && (wrap.textContent || '').trim() === spec.label) return true
        }
        return false
      }
      const candidates = (spec) => {
        const raw = spec.selector
          ? [...document.querySelectorAll(spec.selector)]
          : [...document.querySelectorAll('input, textarea, select, [contenteditable="true"]')].filter(el => matches(el, spec))
        const all = raw.filter(el => !el.closest('[data-dsh-browser-chrome]'))
        const vis = all.filter(visible)
        return vis.length > 0 ? vis : all
      }
      for (const spec of specs) {
        let els
        try {
          els = candidates(spec)
        } catch (e) {
          // A malformed selector must not abort the whole batch; report the
          // field as failed and continue with the rest.
          out.push({ ok: false, error: String(e), target: describe(spec) })
          continue
        }
        if (els.length === 0) { out.push({ ok: false, error: 'field not found', target: describe(spec) }); continue }
        const el = els[0]
        const tag = el.tagName
        const type = (el.type || '').toLowerCase()
        try {
          if (tag === 'SELECT') {
            const wanted = String(spec.value)
            if (el.multiple) {
              const wantedList = wanted.split(',').map(x => x.trim())
              let hit = false
              for (const o of [...el.options]) {
                o.selected = wantedList.includes(o.value) || wantedList.includes((o.textContent || '').trim())
                if (o.selected) hit = true
              }
              if (!hit) { out.push({ ok: false, error: 'option not found: ' + wanted, target: describe(spec) }); continue }
            } else {
              let opt = [...el.options].find(o => o.value === wanted)
              if (!opt) opt = [...el.options].find(o => (o.textContent || '').trim() === wanted)
              if (!opt) { out.push({ ok: false, error: 'option not found: ' + wanted, target: describe(spec) }); continue }
              setNative(el, HTMLSelectElement.prototype, opt.value)
            }
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            out.push({ ok: true, method: 'select', target: describe(spec) })
          } else if (type === 'file') {
            out.push({ ok: false, error: 'file inputs cannot be set from script; use browser_download or ask the human', target: describe(spec) })
          } else if (type === 'checkbox') {
            const want = spec.value === true || spec.value === 'true' || spec.value === 'on'
            if (el.checked !== want) el.click()
            out.push({ ok: true, method: 'checkbox', target: describe(spec) })
          } else if (type === 'radio') {
            const wanted = String(spec.value)
            const radio = [...document.querySelectorAll('input[type="radio"][name=' + JSON.stringify(el.name || '') + ']')]
              .find(r => r.value === wanted || (r === el && (spec.value === true || spec.value === 'true')))
            if (!radio) { out.push({ ok: false, error: 'radio option not found: ' + wanted, target: describe(spec) }); continue }
            if (!radio.checked) radio.click()
            out.push({ ok: true, method: 'radio', target: describe(spec) })
          } else if (el.isContentEditable) {
            el.textContent = String(spec.value)
            el.dispatchEvent(new Event('input', { bubbles: true }))
            out.push({ ok: true, method: 'contenteditable', target: describe(spec) })
          } else if (tag === 'TEXTAREA') {
            setNative(el, HTMLTextAreaElement.prototype, String(spec.value))
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            out.push({ ok: true, method: 'textarea', target: describe(spec) })
          } else {
            setNative(el, HTMLInputElement.prototype, String(spec.value))
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            out.push({ ok: true, method: 'input', target: describe(spec) })
          }
        } catch (e) {
          out.push({ ok: false, error: String(e), target: describe(spec) })
        }
      }
      let submitted = false
      if (${submitFlag}) {
        let last = null
        for (const spec of specs) {
          try { const els = candidates(spec); if (els.length > 0) { last = els[0]; break } } catch { /* skip */ }
        }
        const form = last && (last.form || last.closest('form'))
        if (form) { form.requestSubmit(); submitted = true }
      }
      return { fields: out, submitted }
    })()`
    const timeoutMs = request.timeoutMs ?? 30_000
    const result = await withTimeout(
      handleSendEvaluate(tab.handle, script),
      timeoutMs,
      signal,
      `browser: fillForm timed out after ${timeoutMs}ms`,
    )
    if (!result.ok) {
      throw new BrowserError(`browser: fillForm evaluation failed: ${result.exception}`, 'BROWSER_FILL_FAILED')
    }
    const value = result.value as BrowserFillResult
    const okCount = value.fields.filter(f => f.ok).length
    this.record(s, 'fill', { fields: request.fields.length, submit: submitFlag }, okCount === value.fields.length, {
      result: `${okCount}/${value.fields.length} fields filled${value.submitted ? ', form submitted' : ''}`,
    })
    return { fields: value.fields, submitted: value.submitted === true }
  }

  /**
   * Download a URL to a local file, keeping the session's cookies/login.
   * Requires the self-hosted host (which implements view-level download); the
   * desktop shell's embedded views delegate downloads to the real browser UI.
   */
  async download(session: BrowserSessionId, request: { readonly url: string; readonly savePath: string }, signal?: AbortSignal): Promise<{ readonly path: string }> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    const downloadable = handle as { download?(url: string, savePath: string): Promise<void> }
    if (typeof downloadable.download !== 'function') {
      throw new BrowserError('browser: download is only available on the self-hosted browser', 'BROWSER_DOWNLOAD_UNSUPPORTED')
    }
    // The child fetches in-page with awaitPromise; a slow/hung network can
    // block it well past the tool budget, so bound it like every other call.
    const timeoutMs = 60_000
    await withTimeout(
      downloadable.download(request.url, request.savePath),
      timeoutMs,
      signal,
      `browser: download timed out after ${timeoutMs}ms`,
    )
    this.record(s, 'download', { url: request.url, savePath: request.savePath }, true, { result: request.savePath })
    return { path: request.savePath }
  }

  /**
   * Export the session's cookies (login state) as serializable objects.
   * Self-hosted only; the desktop shell's embedded views use the real profile.
   */
  async flushAuth(session: BrowserSessionId): Promise<readonly ExportedCookie[]> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    const host = handle as { flushAuth?(): Promise<ExportedCookie[]> }
    if (typeof host.flushAuth !== 'function') {
      throw new BrowserError('browser: auth export is only available on the self-hosted browser', 'BROWSER_AUTH_UNSUPPORTED')
    }
    const timeoutMs = 30_000
    const cookies = await withTimeout(host.flushAuth(), timeoutMs, undefined, `browser: auth export timed out after ${timeoutMs}ms`)
    this.record(s, 'flushAuth', {}, true, { result: `${cookies.length} cookies` })
    return cookies
  }

  /** Import cookies into the session (restore login state). Self-hosted only. */
  async restoreAuth(session: BrowserSessionId, cookies: readonly ExportedCookie[]): Promise<number> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    const host = handle as { restoreAuth?(cookies: readonly ExportedCookie[]): Promise<number> }
    if (typeof host.restoreAuth !== 'function') {
      throw new BrowserError('browser: auth restore is only available on the self-hosted browser', 'BROWSER_AUTH_UNSUPPORTED')
    }
    const timeoutMs = 30_000
    const restored = await withTimeout(host.restoreAuth(cookies), timeoutMs, undefined, `browser: auth restore timed out after ${timeoutMs}ms`)
    this.record(s, 'restoreAuth', { count: cookies.length }, true, { result: `${restored} cookies` })
    return restored
  }

  /** Capture the current page, optionally full-page. PNG only (CDP JPEG hangs on Electron 43). */
  async screenshot(
    session: BrowserSessionId,
    request?: { readonly fullPage?: boolean; readonly savePath?: string },
    signal?: AbortSignal,
  ): Promise<{ readonly dataUrl: string; readonly path?: string }> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    // Native capturePage path (self-hosted): CDP Page.captureScreenshot can
    // hang indefinitely on a view once another (hidden) WebContentsView exists
    // in the shared window; capturePage is fast for the visible task view and resolves
    // immediately (empty) for hidden ones.
    const capturable = handle as { capture?(): Promise<{ base64: string; width: number; height: number }> }
    if (request?.fullPage !== true && typeof capturable.capture === 'function') {
      // Ensure the target view is the visible one before capturing.
      this.showActive(s)
      const timeoutMs = 30_000
      const shot = await withTimeout(
        capturable.capture(),
        timeoutMs,
        signal,
        `browser: screenshot timed out after ${timeoutMs}ms`,
      )
      if (shot.base64 === '') {
        throw new BrowserError('browser: capture returned an empty image (view not painted); retry shortly', 'BROWSER_SCREENSHOT_FAILED')
      }
      return this.saveScreenshot(shot.base64, request?.savePath)
    }
    // Fallback: a desktop-shell handle (no capture()) or a full-page capture
    // uses CDP; full-page needs `captureBeyondViewport` which capturePage lacks.
    const params: Record<string, unknown> = {}
    if (request?.fullPage === true) {
      // `captureBeyondViewport` captures the full scrollable content; without
      // a clip this yields the full-page image (CDP default is the viewport).
      params.captureBeyondViewport = true
    }
    const timeoutMs = 30_000
    const result = await withTimeout(
      handle.sendCommand(CDP_PAGE_CAPTURE_SCREENSHOT, params),
      timeoutMs,
      signal,
      `browser: screenshot timed out after ${timeoutMs}ms`,
    )
    const data = result.data
    if (typeof data !== 'string') {
      throw new BrowserError('browser: screenshot returned no image data', 'BROWSER_SCREENSHOT_FAILED')
    }
    return this.saveScreenshot(data, request?.savePath)
  }

  /** Build the data URL and optionally write the PNG to disk. */
  private saveScreenshot(base64: string, savePath?: string): { dataUrl: string; path?: string } {
    if (savePath !== undefined) {
      try {
        writeFileSync(savePath, Buffer.from(base64, 'base64'))
        return { dataUrl: `data:image/png;base64,${base64}`, path: savePath }
      } catch (error) {
        // Report the write problem but keep the capture usable.
        throw new BrowserError(`browser: screenshot save to "${savePath}" failed: ${String(error)}`, 'BROWSER_SCREENSHOT_SAVE_FAILED', { cause: error })
      }
    }
    return { dataUrl: `data:image/png;base64,${base64}` }
  }

  /**
   * Pick up (and forget) any JS dialog the host auto-accepted, so the
   * operation trail shows the human/agent what the page asked. Best-effort.
   */
  private async drainDialog(s: Session, handle: ElectronViewHandle): Promise<void> {
    const drainable = handle as { clearDialog?(): Promise<unknown> }
    if (typeof drainable.clearDialog !== 'function') return
    try {
      const dialog = await drainable.clearDialog()
      if (dialog !== null && dialog !== undefined) {
        this.record(s, 'dialog', dialog as Record<string, unknown>, true)
      }
    } catch {
      // Dialog supervision is cosmetic; never fail a page operation for it.
    }
  }

  /** Name this browser task (space). */
  async setSpace(session: BrowserSessionId, label: string): Promise<void> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    const labelable = handle as { label?(label: string): Promise<void> }
    if (typeof labelable.label === 'function') {
      await labelable.label(label)
    } else {
      throw new BrowserError('browser: space naming is only available on the self-hosted browser', 'BROWSER_SPACE_UNSUPPORTED')
    }
    s.taskLabel = label
    this.record(s, 'setSpace', { label }, true)
  }

  /** List every browser task (space) with its label. */
  async listSpaces(): Promise<readonly BrowserSpaceInfo[]> {
    const host = this.host as { listWindows?(): Promise<Array<{ key: string; label: string }>> }
    if (typeof host.listWindows !== 'function') return []
    return host.listWindows()
  }

  /** List browser tasks with live collaboration status. */
  async listTasks(): Promise<readonly BrowserTaskInfo[]> {
    if (typeof this.host.listTasks === 'function') {
      const tasks = await this.host.listTasks()
      for (const task of tasks) this.rememberHostedTask(task)
      return tasks
    }
    const tasks = new Map<string, BrowserTaskInfo>()
    for (const session of this.sessions.values()) {
      const current = tasks.get(session.taskKey)
      const next = this.localTaskInfo(session)
      tasks.set(session.taskKey, current === undefined
        ? next
        : { ...next, tabs: current.tabs + next.tabs, active: current.active || next.active })
    }
    return [...tasks.values()]
  }

  /** Read the collaboration state for one session's task. */
  async getTask(session: BrowserSessionId): Promise<BrowserTaskInfo> {
    const s = this.session(session)
    const hosted = typeof this.host.getTask === 'function' ? await this.host.getTask(s.taskKey) : undefined
    if (hosted !== undefined) {
      this.rememberHostedTask(hosted)
      return hosted
    }
    return this.localTaskInfo(s)
  }

  /** Apply one visible task state update and mirror it to a supporting host. */
  async updateTask(session: BrowserSessionId, update: BrowserTaskUpdate): Promise<BrowserTaskInfo> {
    const s = this.session(session)
    const previous = this.taskStates.get(s.taskKey) ?? { status: 'idle' as const, control: 'agent' as const, updatedAt: Date.now() }
    const next: LocalTaskState = {
      ...previous,
      ...update.status !== undefined ? { status: update.status } : {},
      ...update.control !== undefined ? { control: update.control } : {},
      ...update.latestAction !== undefined ? { latestAction: update.latestAction } : {},
      ...update.error !== undefined ? { error: update.error.slice(0, 180) } : {},
      updatedAt: Date.now(),
    }
    if (next.status !== 'failed' && update.error === undefined) delete next.error
    this.taskStates.set(s.taskKey, next)
    // Only send fields this call intentionally changes. A page-side handoff
    // can update the host between two Agent operations; replaying a stale
    // cached control field here would overwrite the newer human choice.
    const hosted = typeof this.host.updateTask === 'function'
      ? await this.host.updateTask(s.taskKey, {
        ...update.status !== undefined ? { status: update.status } : {},
        ...update.control !== undefined ? { control: update.control } : {},
        ...update.latestAction !== undefined ? { latestAction: update.latestAction } : {},
        ...update.error !== undefined ? { error: update.error.slice(0, 180) } : {},
      })
      : undefined
    if (hosted !== undefined) {
      this.rememberHostedTask(hosted)
      return hosted
    }
    return this.localTaskInfo(s)
  }

  /** Hand control to the user or return it to Agent-driven actions. */
  async setHandoff(session: BrowserSessionId, state: BrowserHandoffState): Promise<BrowserTaskInfo> {
    return this.updateTask(session, state === 'waiting-user'
      ? { status: 'waiting-user', control: 'human', latestAction: 'waiting for user' }
      : { status: 'idle', control: 'agent', latestAction: 'agent resumed' })
  }

  /** Append one operation to the session's history. */
  private record(
    s: Session,
    action: string,
    params: Record<string, unknown>,
    ok: boolean,
    detail?: { result?: string; error?: string },
  ): void {
    const entry: BrowserHistoryEntry = {
      seq: s.nextSeq++,
      action,
      params,
      ok,
      ...detail?.result !== undefined ? { result: detail.result } : {},
      ...detail?.error !== undefined ? { error: detail.error } : {},
      at: Date.now(),
    }
    s.history.push(entry)
    // Bound memory: keep the last 500 operations.
    if (s.history.length > 500) s.history.splice(0, s.history.length - 500)
    // Mirror onto the human-facing trail in the shared window (best-effort).
    const tab = s.tabs[s.activeIndex]
    const state = this.taskStates.get(s.taskKey)
    if (state !== undefined) {
      state.latestAction = action
      state.updatedAt = entry.at
    }
    try {
      this.host.trace?.(tab?.handle.id ?? 'default', { action, params, ok, at: entry.at })
      const pending = this.host.updateTask?.(s.taskKey, { latestAction: action })
      void pending?.catch(() => undefined)
    } catch { /* trail is cosmetic */ }
  }

  /** Return the session's chronological operation log (newest last). */
  async history(session: BrowserSessionId): Promise<readonly BrowserHistoryEntry[]> {
    return this.session(session).history
  }

  /**
   * Replay one recorded operation by sequence number. Navigate/click/type are
   * re-issued against the current page; execute re-runs its script. The
   * replayed step is appended to history as a new entry.
   * @param session - the session id.
   * @param seq - the recorded entry's sequence number to replay.
   */
  async replay(session: BrowserSessionId, seq: number): Promise<void> {
    const s = this.session(session)
    const entry = s.history.find(e => e.seq === seq)
    if (entry === undefined) {
      throw new BrowserError(`browser: no history entry with seq ${seq}`, 'BROWSER_HISTORY_UNKNOWN')
    }
    switch (entry.action) {
      case 'navigate': {
        const url = entry.params.url
        if (typeof url !== 'string') throw new BrowserError(`browser: history seq ${seq} navigate has no url`, 'BROWSER_HISTORY_INVALID')
        await this.navigate(session, { url })
        this.record(s, 'replay', { seq, of: entry.action, url }, true)
        return
      }
      case 'click': {
        const x = entry.params.x
        const y = entry.params.y
        if (typeof x !== 'number' || typeof y !== 'number') throw new BrowserError(`browser: history seq ${seq} click has no coordinates`, 'BROWSER_HISTORY_INVALID')
        await this.click(session, { x, y })
        this.record(s, 'replay', { seq, of: entry.action, x, y }, true)
        return
      }
      case 'type': {
        const text = entry.params.text
        if (typeof text !== 'string') throw new BrowserError(`browser: history seq ${seq} type has no text`, 'BROWSER_HISTORY_INVALID')
        await this.type(session, { text })
        this.record(s, 'replay', { seq, of: entry.action, text }, true)
        return
      }
      case 'execute': {
        const script = entry.params.script
        if (typeof script !== 'string') throw new BrowserError(`browser: history seq ${seq} execute has no script`, 'BROWSER_HISTORY_INVALID')
        const recordedArgs = entry.params.args
        const args = Array.isArray(recordedArgs) ? recordedArgs.filter((a): a is string => typeof a === 'string') : undefined
        const result = await this.execute(session, { script, ...args !== undefined && args.length > 0 ? { args } : {} })
        this.record(s, 'replay', { seq, of: entry.action, script, ...args !== undefined && args.length > 0 ? { args } : {} }, result.ok, result.ok ? { result: String(result.value) } : { error: result.exception })
        return
      }
      default:
        throw new BrowserError(`browser: history seq ${seq} action "${entry.action}" is not replayable`, 'BROWSER_HISTORY_NOT_REPLAYABLE')
    }
  }

  /** Close the session and destroy all its views. Idempotent. */
  close(session: BrowserSessionId): Promise<void> {
    const existing = this.sessions.get(session)
    if (existing !== undefined) {
      this.sessions.delete(session)
      for (const tab of existing.tabs) this.host.destroyView(tab.handle)
      if (![...this.sessions.values()].some(candidate => candidate.taskKey === existing.taskKey)) {
        this.taskStates.delete(existing.taskKey)
      }
    }
    return Promise.resolve()
  }

  /** Look up a session or throw the unknown-session error. */
  private session(session: BrowserSessionId): Session {
    const existing = this.sessions.get(session)
    if (existing === undefined) {
      throw new BrowserError(`browser: session "${session}" is not open`, 'BROWSER_SESSION_UNKNOWN')
    }
    return existing
  }

  /** The active tab of a session. */
  private activeTab(s: Session): Tab {
    const tab = s.tabs[s.activeIndex]
    if (tab === undefined) throw new BrowserError('browser: session has no active tab', 'BROWSER_TAB_UNKNOWN')
    return tab
  }

  /** Navigate through the browser history while preserving page readiness behavior. */
  private async navigateHistory(
    session: BrowserSessionId,
    direction: -1 | 1,
    action: 'back' | 'forward',
    signal?: AbortSignal,
  ): Promise<boolean> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const history = await withTimeout(
      tab.handle.sendCommand(CDP_PAGE_GET_NAVIGATION_HISTORY, {}),
      15_000,
      signal,
      'browser: history lookup timed out',
    )
    const currentIndex = typeof history.currentIndex === 'number' ? history.currentIndex : -1
    const entries = Array.isArray(history.entries) ? history.entries as Array<{ id?: unknown }> : []
    const target = entries[currentIndex + direction]
    if (target === undefined || typeof target.id !== 'number') {
      this.record(s, action, { navigated: false }, true)
      return false
    }
    await withTimeout(
      tab.handle.sendCommand(CDP_PAGE_NAVIGATE_TO_HISTORY_ENTRY, { entryId: target.id }),
      30_000,
      signal,
      `browser: ${action} timed out after 30000ms`,
    )
    this.invalidateSnapshots(tab)
    this.record(s, action, { navigated: true }, true)
    this.showActive(s)
    await waitForDocumentReady(tab.handle, signal)
    void reinstallPageChrome(tab.handle)
    return true
  }

  /** Drop every reference that was captured before a document transition. */
  private invalidateSnapshots(tab: Tab): void {
    tab.navigationEpoch += 1
    tab.snapshots.clear()
  }

  /** Resolve one exact snapshot reference, rejecting any changed or missing target. */
  private async resolveSnapshotTarget(
    tab: Tab,
    request: BrowserRefRequest,
    block: 'start' | 'center' | 'end' | 'nearest',
    signal?: AbortSignal,
  ): Promise<BrowserScrollResult & { readonly x: number; readonly y: number }> {
    const record = tab.snapshots.get(request.snapshotId)
    if (record === undefined) {
      throw new BrowserError(`browser: snapshot "${request.snapshotId}" is not available in this tab`, 'BROWSER_SNAPSHOT_UNKNOWN')
    }
    if (record.tabId !== tab.id || record.epoch !== tab.navigationEpoch) {
      throw new BrowserError(`browser: snapshot "${request.snapshotId}" is stale`, 'BROWSER_SNAPSHOT_STALE')
    }
    const target = record.targets.get(request.ref)
    if (target === undefined) {
      throw new BrowserError(`browser: snapshot "${request.snapshotId}" has no element ref ${request.ref}`, 'BROWSER_REF_UNKNOWN')
    }
    const script = `(() => {
      if (location.href !== ${JSON.stringify(record.url)}) return { stale: 'url changed' }
      let el
      try { el = document.querySelector(${JSON.stringify(target.path)}) } catch { return { stale: 'selector invalid' } }
      if (!el || el.closest('[data-dsh-browser-chrome]')) return { stale: 'element missing' }
      const fingerprint = [
        el.tagName,
        el.getAttribute('type') || '',
        el.id || '',
        el.getAttribute('name') || '',
        el.getAttribute('aria-label') || '',
        (el.textContent || el.value || '').toString().replace(/\s+/g, ' ').trim().slice(0, 120),
      ].join('\u001f')
      if (fingerprint !== ${JSON.stringify(target.fingerprint)}) return { stale: 'element changed' }
      el.scrollIntoView({ block: ${JSON.stringify(block)}, inline: 'nearest', behavior: 'auto' })
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      if (rect.width < 4 || rect.height < 4 || style.visibility === 'hidden' || style.display === 'none') return { stale: 'element hidden' }
      const root = document.documentElement
      return {
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        maxX: Math.max(0, root.scrollWidth - window.innerWidth),
        maxY: Math.max(0, root.scrollHeight - window.innerHeight),
      }
    })()`
    const result = await withTimeout(
      handleSendEvaluate(tab.handle, script),
      15_000,
      signal,
      'browser: snapshot reference resolution timed out',
    )
    if (!result.ok) {
      throw new BrowserError(`browser: snapshot reference resolution failed: ${result.exception}`, 'BROWSER_REF_RESOLVE_FAILED')
    }
    const value = result.value as { stale?: string; x?: number; y?: number; scrollX?: number; scrollY?: number; maxX?: number; maxY?: number }
    if (typeof value.stale === 'string'
      || typeof value.x !== 'number'
      || typeof value.y !== 'number'
      || typeof value.scrollX !== 'number'
      || typeof value.scrollY !== 'number'
      || typeof value.maxX !== 'number'
      || typeof value.maxY !== 'number') {
      throw new BrowserError(`browser: snapshot "${request.snapshotId}" is stale${typeof value.stale === 'string' ? `: ${value.stale}` : ''}`, 'BROWSER_SNAPSHOT_STALE')
    }
    return { x: value.x, y: value.y, maxX: value.maxX, maxY: value.maxY }
  }

  /** Sync provider fallback cache from the host's authoritative workspace state. */
  private rememberHostedTask(task: BrowserTaskInfo): void {
    this.taskStates.set(task.key, {
      status: task.status,
      control: task.control,
      ...task.latestAction !== undefined ? { latestAction: task.latestAction } : {},
      ...task.error !== undefined ? { error: task.error } : {},
      updatedAt: task.updatedAt,
    })
  }

  /** Build the provider-side task summary when a host has no richer workspace. */
  private localTaskInfo(s: Session): BrowserTaskInfo {
    const state = this.taskStates.get(s.taskKey) ?? { status: 'idle' as const, control: 'agent' as const, updatedAt: Date.now() }
    return {
      key: s.taskKey,
      label: s.taskLabel,
      active: this.sessions.size === 1,
      tabs: s.tabs.length,
      status: state.status,
      control: state.control,
      ...state.latestAction !== undefined ? { latestAction: state.latestAction } : {},
      updatedAt: state.updatedAt,
      ...state.error !== undefined ? { error: state.error } : {},
    }
  }

  /** Create a tab with its short-lived snapshot reference store. */
  private createTab(handle: ElectronViewHandle): Tab {
    return { id: `tab:${randomUUID()}`, handle, navigationEpoch: 0, snapshots: new Map() }
  }

  /** Append a fresh tab and make it active. */
  private newTab(s: Session): void {
    const handle = this.host.createView(s.taskKey, s.taskLabel === '' ? undefined : s.taskLabel)
    s.tabs.push(this.createTab(handle))
    s.activeIndex = s.tabs.length - 1
    this.showActive(s)
  }

  /** Notify the host of the active tab; it preserves the human-selected task view. */
  private showActive(s: Session): void {
    this.host.showView?.(this.activeTab(s).handle)
  }

  /** Read the current URL of a view through CDP. */
  private async currentUrl(handle: ElectronViewHandle): Promise<string> {
    // Bound the read: a wedged renderer would otherwise hang listTabs.
    const timeoutMs = 10_000
    const result = await withTimeout(
      handleSendEvaluate(handle, 'location.href'),
      timeoutMs,
      undefined,
      `browser: url read timed out after ${timeoutMs}ms`,
    )
    return result.ok && typeof result.value === 'string' ? result.value : ''
  }
}

/**
 * Bound a promise so a wedged CDP call surfaces as an error instead of
 * hanging the tool call forever. The caller's signal, when provided, wins
 * over the timeout if it fires first.
 * @param promise - the operation to bound.
 * @param ms - the timeout budget.
 * @param signal - optional caller signal.
 * @param message - the timeout error message.
 * @returns the promise's value, or a rejected promise on timeout/abort.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      // A fired timeout must also release the abort listener; { once: true }
      // only releases it on the next abort, which may never come.
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      const error = new Error(message)
      error.name = 'TimeoutError'
      reject(error)
    }, ms)
    const finish = (fn: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    )
  })
}

/**
 * Run a `Runtime.evaluate` through a view handle and normalize the result.
 * Shared by execute, snapshot, content, and internal URL reads.
 * @param handle - the view handle to evaluate in.
 * @param expression - the JS expression.
 * @param signal - optional abort signal; a fired signal rejects the call.
 */
/** Best-effort injection of the human chrome into the current document. */
async function reinstallPageChrome(handle: ElectronViewHandle): Promise<void> {
  try {
    await handle.sendCommand(CDP_RUNTIME_EVALUATE, {
      expression: PAGE_CHROME_SCRIPT,
      returnByValue: true,
    } satisfies CdpEvaluateParams)
  } catch {
    // Chrome is cosmetic; never fail navigation for it.
  }
}

/**
 * Wait until the main document reports complete, without turning an otherwise
 * successful navigation into a failure when a page is slow or never settles.
 */
async function waitForDocumentReady(
  handle: ElectronViewHandle,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 12_000
  try {
    await withTimeout((async () => {
      while (Date.now() <= deadline) {
        const result = await handleSendEvaluate(handle, 'document.readyState', signal).catch(() => undefined)
        if (result?.ok && result.value === 'complete') {
          await new Promise(resolve => setTimeout(resolve, 250))
          return
        }
        await new Promise(resolve => setTimeout(resolve, 150))
      }
    })(), 13_000, signal, 'readiness wait exceeded')
  } catch {
    // Readiness is an optimization: never fail a valid navigation for it.
  }
}

/** Mark a short window in which CDP input must not transfer control to the user. */
async function suppressAutoUserControl(handle: ElectronViewHandle, signal?: AbortSignal): Promise<void> {
  const expression = '(() => { const host = document.getElementById(' + JSON.stringify(PAGE_CHROME_HOST_ID)
    + '); if (!host) return false; host.setAttribute("data-dsh-agent-input-until", String(Date.now() + ' + String(AGENT_INPUT_SUPPRESSION_MS) + ')); return true })()'
  await withTimeout(
    handleSendEvaluate(handle, expression, signal),
    2_000,
    signal,
    'browser: agent input suppression timed out',
  ).catch(() => undefined)
}

async function handleSendEvaluate(
  handle: ElectronViewHandle,
  expression: string,
  signal?: AbortSignal,
): Promise<BrowserExecuteResult> {
  signal?.throwIfAborted()
  const result = await handle.sendCommand(CDP_RUNTIME_EVALUATE, {
    expression,
    returnByValue: true,
    awaitPromise: true,
  } satisfies CdpEvaluateParams)
  if (result.exceptionDetails !== undefined) {
    const detail = result.exceptionDetails as { text?: string; exception?: { description?: string } }
    return { ok: false, exception: detail.exception?.description ?? detail.text ?? 'unknown exception' }
  }
  return { ok: true, value: (result.result as { value?: unknown } | undefined)?.value ?? null }
}

