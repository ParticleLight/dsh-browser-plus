/**
 * Electron-backed browser provider: `WebContentsView` sessions driven over
 * `webContents.debugger` (CDP). The provider itself does not import Electron — it operates through the {@link ElectronBrowserViewHost} seam, which the
 * desktop shell implements with real Electron objects. That keeps this
 * package testable under plain Node and leaves the Electron dependency to the
 * shell that owns the `BrowserWindow`.
 * @module dsh-browser-plus/browser-electron
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import type {
  BrowserChallenge,
  BrowserClearAuthRequest,
  BrowserClearAuthResult,
  BrowserContentRequest,
  BrowserContentResult,
  BrowserControlOwner,
  BrowserDragRequest,
  BrowserDragResult,
  BrowserPointerResult,
  BrowserPointerTarget,
  BrowserExecuteRequest,
  BrowserExecuteResult,
  BrowserFillRequest,
  BrowserFillResult,
  BrowserHandoffState,
  BrowserHistoryEntry,

  BrowserOpenOptions,
  BrowserOpenRequest,
  BrowserPressKeyRequest,
  BrowserProvider,
  BrowserRefRequest,
  BrowserScrapeRequest,
  BrowserScrapeStatus,
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
  BrowserPdfRequest,
  BrowserPdfResult,
  BrowserHighlightRequest,
  BrowserHighlightResult,
  BrowserWaitForRequest,
  BrowserWaitForResult,
  ExportedCookie,
} from '../browser/types.ts'
import { BrowserError } from '../browser/types.ts'
import { PAGE_CHROME_HOST_ID, PAGE_CHROME_SCRIPT } from './page-chrome.ts'
import { defaultWriteRoots, resolveReadPath, resolveWritePath } from './write-guard.ts'

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
 * One tab request raised by the injected chrome because a human used it.
 *
 * The host owns the pixels, the tab strip and the per-view secret, so it is the
 * only party that can authenticate such a request; the provider owns the tab
 * model, so it is the only party that may act on one. `tabId` is the host's own
 * view id, which is also the provider's `ElectronViewHandle.id`, so no extra
 * mapping table is needed.
 */
export interface ChromeHostEvent {
  /** For a 'move-tab' event: the index the tab was dropped at, after removal. */
  readonly toIndex?: number
  readonly type: 'new-tab' | 'close-tab' | 'activate-tab' | 'move-tab'
  /** Task key of the chrome that raised it. */
  readonly taskKey: string
  /** Host view id of the tab; absent for `new-tab`. */
  readonly tabId?: string
  /** For `new-tab`: open this http(s) url in the new tab (a bookmark click). */
  readonly url?: string
}

/**
 * The minimal Electron surface this provider needs. Implemented by the
 * desktop shell with a real `WebContentsView`; a fake implements it in tests.
 */
export interface ElectronBrowserViewHost {
  /**
   * Subscribe to tab requests the host raises without being asked (a human
   * clicking the chrome's own `+`, `×` or tab strip). Optional: a host whose
   * chrome cannot speak first simply never raises one.
   * @param listener - invoked once per authenticated chrome request.
   */
  onChromeEvent?(listener: (event: ChromeHostEvent) => void): void
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
   * Send a CDP `Input.*` command to the host's chrome frame view.
   *
   * The frame is not a tab and has no handle, so this is its own channel. It
   * exists because the chrome can live in a view of its own (which is what lets
   * the page viewport really shrink): input aimed at a page never reaches that
   * view, and CDP input targets a webContents regardless of view stacking, so
   * the page cannot stand in for it. Optional for hosts without a frame view.
   * @param method - a CDP Input domain command, e.g. 'Input.dispatchMouseEvent'.
   * @param params - that command's parameters.
   */
  chromeInput?(method: string, params?: Record<string, unknown>): Promise<void>
  /**
   * Evaluate an expression inside the chrome frame's own document.
   *
   * The frame is a view of its own, so no page-directed call can read it. This is
   * how the tests assert the toolbar's own animations instead of inferring them
   * from the page's copy of the chrome. Optional for hosts without a frame view.
   * @param expression - JavaScript evaluated in the frame, by value.
   */
  chromeEval?(expression: string): Promise<unknown>
  /**
   * Append one operation to the human-facing trail for a view. Optional.
   * @param viewId - the view to attribute the operation to.
   * @param entry - the trail entry ({ action, params, ok, at }).
   */
  trace?(viewId: string, entry: unknown): void
  /**
   * Cheap local usability probe for this host. MUST NOT make network calls and
   * MUST NOT throw (a throw is reported as unavailable). Optional: a host that
   * omits it is assumed usable, which keeps a desktop shell's shell-owned
   * viewHost and test fakes working. A self-hosted host reports false when the
   * pinned Electron binary cannot be resolved, so the seam can pick another
   * provider (BROWSER_PROVIDER_UNAVAILABLE / BROWSER_PROVIDER_AMBIGUOUS)
   * instead of failing later on the first open().
   */
  isAvailable?(): boolean
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
  /** Optional: hosts without JS-dialog supervision omit it. */
  setDialogPolicy?(policy: DialogPolicy): Promise<unknown>
  /** Optional: bounded console capture. */
  readConsole?(clear?: boolean): Promise<unknown>
  /** Optional: bounded network capture. */
  readNetwork?(clear?: boolean): Promise<unknown>
  /**
   * Remove cookies matching a domain/name filter. Optional: hosts without a
   * deletable cookie store omit it.
   */
  clearCookies?(filter: { readonly domain?: string; readonly name?: string; readonly all?: boolean }): Promise<{ readonly removed: number; readonly names: readonly string[] }>
  /** Set this view's browser task label; it titles the shared window only when selected. Optional. */
  label?(label: string): Promise<void>
  /**
   * Re-apply the host's own page chrome to the current document. Optional: a host
   * that does not own the chrome omits it, and the provider then injects its own
   * tokenless copy as a fallback.
   */
  reinstallChrome?(): Promise<void>
}

/** Internal selector and fingerprint captured for one snapshot element. */
interface SnapshotTarget {
  /** iframe index when the target lives inside a frame. */
  readonly frame?: number
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
  /** The most recent JS dialog the host reported, kept for browser_dialog inspect. */
  lastDialog?: unknown
  /** How the host should answer the next JS dialog. Default: accept. */
  dialogPolicy?: DialogPolicy
}

/**
 * How the host answers a JS dialog (alert/confirm/prompt).
 *
 * A dialog freezes the renderer until it is answered, so the default stays
 * `accept` - automation must never hang on one. `dismiss` is for pages whose
 * confirmation is part of what is being driven (delete prompts and the like),
 * and `promptText` supplies the value for a prompt.
 */
/** One captured console message. */
export interface BrowserConsoleMessage { level: string; text: string; at: string }
/** One captured network request. */
export interface BrowserNetworkRequest {
  method: string
  url: string
  status?: number
  mime?: string
  kind?: string
  failed?: string
  ms?: number
  at: string
}

/** Device/viewport/media emulation for one tab (browser_emulate). */
export interface EmulateOptions {
  readonly width?: number
  readonly height?: number
  readonly deviceScaleFactor?: number
  readonly mobile?: boolean
  readonly userAgent?: string
  readonly colorScheme?: 'light' | 'dark' | 'no-preference'
  /** Undo everything this tool set on the tab. */
  readonly clear?: boolean
}

export interface DialogPolicy {
  readonly behavior: 'accept' | 'dismiss'
  readonly promptText?: string
}

/** Provider config: navigation admission defaults and snapshot caps. */
export interface ElectronBrowserProviderConfig {
  /** Allow navigation only to HTTP(S) URLs; reject anything else. Default true. */
  readonly httpOnly?: boolean
  /** Maximum snapshot elements before truncation. Default 60. */
  readonly snapshotMaxElements?: number
  /** Maximum content characters before truncation when no maxChars is given. Default 100_000. */
  readonly contentMaxChars?: number
  /**
   * Absolute directories a screenshot or download may write into. Defaults to
   * the workspace and the OS temp directory ({@link defaultWriteRoots}); an
   * empty list denies every write.
   */
  readonly writeRoots?: readonly string[]
  /**
   * Absolute directories `browser_upload_file` may read from. Defaults to the
   * same roots as {@link writeRoots}; an empty list denies every upload.
   */
  readonly readRoots?: readonly string[]
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
  readonly type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'
  readonly x: number
  readonly y: number
  readonly button: 'left' | 'right' | 'middle' | 'none'
  readonly clickCount?: number
  /** Buttons held during the event; 1 while a left drag is in flight. */
  readonly buttons?: number
  /** CDP modifier bitmask (Alt 1, Ctrl 2, Meta 4, Shift 8); see modifierMask. */
  readonly modifiers?: number
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
/** CDP method that renders the current document to PDF. */
export const CDP_PAGE_PRINT_TO_PDF = 'Page.printToPDF'
/** CDP methods that draw the DevTools highlight box without touching the DOM. */
export const CDP_OVERLAY_ENABLE = 'Overlay.enable'
export const CDP_OVERLAY_HIGHLIGHT_NODE = 'Overlay.highlightNode'
export const CDP_OVERLAY_HIDE_HIGHLIGHT = 'Overlay.hideHighlight'
/** CDP method for runtime evaluation (the execute path). */
export const CDP_RUNTIME_EVALUATE = 'Runtime.evaluate'

/**
 * Decide how to hand a script to `Runtime.evaluate`.
 *
 * CDP evaluates an *expression*, so a script made of statements is a syntax
 * error there. Try the expression form first - that keeps bare expressions and
 * object literals returning their value, which is what the tool has always
 * done - then fall back to a statement body. `const x = 1; return x` is the
 * shape people actually type, and it used to come back as a bare SyntaxError.
 */
export function buildEvaluateBody(script: string): { body: string } | { error: string } {
  try {
    // Parses only; nothing is executed here.
    new Function(`return (${script})`)
    return { body: `return (${script})` }
  } catch { /* not an expression - try it as a body */ }
  try {
    new Function(script)
    return { body: script }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** CDP method for keyboard input. */
export const CDP_INPUT_DISPATCH_KEY_EVENT = 'Input.dispatchKeyEvent'
/**
 * True when an input command's target view is already gone.
 *
 * The page's own chrome handles Ctrl+W/Ctrl+T by asking the provider to close or
 * open a tab, so the key dispatch that triggered it is still in flight when the
 * view disappears: the host answers `unknown view`, or CDP says the target closed.
 * Measured on the real machine - create and destroy of one view 1.5s apart, then
 * this error on the Ctrl+W that caused the destroy.
 */
function isClosedInputTarget(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /target closed|unknown view/i.test(error.message)
}

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

/** Printable ASCII with no KEY_VK entry, mapped to its US-layout position. */
const PRINTABLE_CODES: Record<string, { code: string; vk: number }> = {
  '-': { code: 'Minus', vk: 189 },
  '=': { code: 'Equal', vk: 187 },
  '[': { code: 'BracketLeft', vk: 219 },
  ']': { code: 'BracketRight', vk: 221 },
  ';': { code: 'Semicolon', vk: 186 },
  "'": { code: 'Quote', vk: 222 },
  ',': { code: 'Comma', vk: 188 },
  '.': { code: 'Period', vk: 190 },
  '/': { code: 'Slash', vk: 191 },
  '`': { code: 'Backquote', vk: 192 },
}

/** True for the ASCII range a key event can carry as text. */
function isPrintable(key: string): boolean {
  if (key.length !== 1) return false
  const code = key.charCodeAt(0)
  return code >= 0x20 && code <= 0x7e
}

function keyText(key: string): string | null {
  switch (key) {
    case 'Enter': return '\r'
    case 'Tab': return '\t'
    case 'Space': return ' '
    default: return isPrintable(key) ? key : null
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
  if (isPrintable(key)) {
    // Punctuation carries its US-layout position so shortcuts such as Ctrl+- and
    // Ctrl+/ reach the page; anything else printable falls back to its own code.
    const known = PRINTABLE_CODES[key]
    return known === undefined
      ? { key, code: key, vk: key.toUpperCase().charCodeAt(0) }
      : { key, code: known.code, vk: known.vk }
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

/** An input dispatch must not outlive this: a blocked renderer never acknowledges. */
const INPUT_DISPATCH_TIMEOUT_MS = 15_000

/**
 * Views whose renderer has already been told to consider itself focused.
 * Weak so a destroyed view does not keep its handle alive.
 */
const focusEmulatedViews = new WeakSet<ElectronViewHandle>()

/** Gap between the move events of a drag; enough to span several frames. */
const DRAG_STEP_DELAY_MS = 8

/** Upper bound on concurrent scrape workers; each one costs a tab. */
const MAX_SCRAPE_WORKERS = 8

/** Mutable progress for one background scrape batch. */
interface ScrapeJob {
  readonly id: string
  readonly session: Session
  /**
   * The batch's own tabs, created at start and destroyed when it ends. One per
   * worker. Deliberately never activated: a batch must not race a tool call for
   * the session's active tab, and it must not navigate away from the page the
   * human was reading.
   */
  readonly tabs: readonly Tab[]
  readonly path: string
  state: 'running' | 'done' | 'stopped'
  readonly total: number
  done: number
  failed: number
  error?: string
}

/** The immutable view of a job the seam hands out. */
function scrapeStatusOf(job: ScrapeJob): BrowserScrapeStatus {
  return {
    id: job.id,
    state: job.state,
    total: job.total,
    done: job.done,
    failed: job.failed,
    path: job.path,
    ...job.error === undefined ? {} : { error: job.error },
  }
}

/**
 * One JSONL row. A page can return a value JSON cannot carry (a circular object,
 * a BigInt); that must not kill a batch that has already written hundreds of rows.
 */
function scrapeRow(row: Record<string, unknown>): string {
  try {
    return JSON.stringify(row) + '\n'
  } catch (error) {
    return JSON.stringify({
      url: row.url,
      ok: false,
      error: `unserializable result: ${String((error as Error)?.message ?? error)}`,
    }) + '\n'
  }
}

/**
 * Normalize one entry of a cookie export, or undefined when it cannot be used.
 *
 * Our own flushAuth emits `url`. Browser cookie editors (Cookie-Editor,
 * EditThisCookie) and Edge's own export emit `domain` + `path` and no `url` at
 * all — so requiring `url` rejected a file straight out of a browser wholesale,
 * which is exactly the workflow this feature exists for. cookies.set wants a
 * URL, so derive one when only the domain is present.
 */
function normalizeExportedCookie(value: unknown): ExportedCookie | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || typeof record.value !== 'string') return undefined
  const path = typeof record.path === 'string' && record.path.startsWith('/') ? record.path : '/'
  const url = typeof record.url === 'string' && record.url !== ''
    ? record.url
    : typeof record.domain === 'string' && record.domain !== ''
      // A leading dot marks a domain-wide cookie; the URL host must not carry it.
      ? `${record.secure === true ? 'https' : 'http'}://${record.domain.replace(/^\./, '')}${path}`
      : undefined
  if (url === undefined) return undefined
  const sameSite = normalizeSameSite(record.sameSite)
  return {
    url,
    name: record.name,
    value: record.value,
    ...typeof record.domain === 'string' ? { domain: record.domain } : {},
    ...typeof record.path === 'string' ? { path: record.path } : {},
    ...typeof record.secure === 'boolean' ? { secure: record.secure } : {},
    ...typeof record.httpOnly === 'boolean' ? { httpOnly: record.httpOnly } : {},
    ...typeof record.expirationDate === 'number' ? { expirationDate: record.expirationDate } : {},
    ...sameSite === undefined ? {} : { sameSite },
  }
}

/**
 * Cookie editors emit Playwright's spelling (None/Lax/Strict) and Chromium's
 * (no_restriction/lax/strict). cookies.set wants the latter.
 */
function normalizeSameSite(value: unknown): ExportedCookie['sameSite'] {
  if (typeof value !== 'string') return undefined
  switch (value.toLowerCase()) {
    case 'none':
    case 'no_restriction': return 'no_restriction'
    case 'lax': return 'lax'
    case 'strict': return 'strict'
    case 'unspecified': return 'unspecified'
    default: return undefined
  }
}

/** Total budget for the snapshot's empty-inventory retries. */
const SNAPSHOT_RETRY_BUDGET_MS = 3_000

/**
 * Longest script or typed text kept in one history entry. Entries exist to be
 * replayed, so an over-long value is stored clipped and marked: replay then
 * refuses outright rather than re-issuing a silently shortened script.
 */
const HISTORY_PARAM_MAX_CHARS = 32_768

/** Clip the replay payloads that would otherwise pin unbounded text in memory. */
function clampHistoryParams(params: Record<string, unknown>): Record<string, unknown> {
  const tooLong = (value: unknown): value is string => typeof value === 'string' && value.length > HISTORY_PARAM_MAX_CHARS
  if (!tooLong(params.script) && !tooLong(params.text)) return params
  const clipped: Record<string, unknown> = { ...params }
  if (tooLong(params.script)) {
    clipped.script = params.script.slice(0, HISTORY_PARAM_MAX_CHARS)
    clipped.scriptTruncated = true
  }
  if (tooLong(params.text)) {
    clipped.text = params.text.slice(0, HISTORY_PARAM_MAX_CHARS)
    clipped.textTruncated = true
  }
  return clipped
}

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
  /** Stable task-key index so callers can recover a session after tool-layer state loss. */
  private readonly sessionsByTask = new Map<string, BrowserSessionId>()
  private readonly taskStates = new Map<string, LocalTaskState>()
  private readonly httpOnly: boolean
  private readonly snapshotMaxElements: number
  private readonly contentMaxChars: number
  private readonly writeRoots: readonly string[]
  private readonly readRoots: readonly string[]
  /** Background scrape batches, keyed by id; rows live on disk, not here. */
  private readonly scrapes = new Map<string, ScrapeJob>()

  constructor(
    private readonly host: ElectronBrowserViewHost,
    config: ElectronBrowserProviderConfig = {},
  ) {
    this.httpOnly = config.httpOnly ?? true
    this.snapshotMaxElements = config.snapshotMaxElements ?? 60
    this.contentMaxChars = config.contentMaxChars ?? 100_000
    this.writeRoots = config.writeRoots ?? defaultWriteRoots()
    this.readRoots = config.readRoots ?? defaultWriteRoots()
    // A human clicking the injected chrome's own tabs is the one case where the
    // host must tell the provider something: the host can show a different view,
    // but only the provider owns the session's tab list and active index.
    this.host.onChromeEvent?.(event => this.handleChromeEvent(event))
  }

  /**
   * Apply one authenticated chrome request to the session that owns its task.
   *
   * Every field is re-checked here: the host authenticates the sender, this
   * method decides whether the request still makes sense against the live tab
   * model. A request that resolves to nothing (a stale strip, a tab closed a
   * moment ago, a task with no session) is dropped rather than thrown, because
   * a human click must never surface as an error inside a running tool call.
   */
  private handleChromeEvent(event: ChromeHostEvent): void {
    if (typeof event !== 'object' || event === null) return
    if (typeof event.taskKey !== 'string' || event.taskKey === '') return
    const sessionId = this.sessionsByTask.get(event.taskKey)
    if (sessionId === undefined) return
    const s = this.sessions.get(sessionId)
    if (s === undefined) return
    try {
      if (event.type === 'new-tab') {
        this.newTab(s)
        // 点收藏栏来的新标签会带 url —— 建完再导航（新标签已经是 active）。
        if (typeof event.url === 'string' && event.url !== '') {
          void this.navigate(sessionId, { url: event.url }).catch(() => undefined)
        }
        return
      }
      if (typeof event.tabId !== 'string') return
      const tab = s.tabs.find(candidate => candidate.handle.id === event.tabId)
      if (tab === undefined) return
      if (event.type === 'close-tab') {
        void this.closeTab(sessionId, tab.id)
        return
      }
      if (event.type === 'move-tab' && typeof event.toIndex === 'number') {
        // The human dragged this tab: mirror the host's order so the session's tab
        // list (what browser_list_tabs reports) matches the strip.
        const from = s.tabs.indexOf(tab)
        if (from >= 0) {
          const active = s.tabs[s.activeIndex]
          const [moved] = s.tabs.splice(from, 1)
          const to = Math.max(0, Math.min(Math.trunc(event.toIndex), s.tabs.length))
          s.tabs.splice(to, 0, moved)
          // activeIndex is positional, so keep it pointing at the same tab.
          const activeNow = s.tabs.indexOf(active)
          if (activeNow >= 0) s.activeIndex = activeNow
        }
        return
      }
      if (event.type === 'activate-tab') {
        const index = s.tabs.indexOf(tab)
        if (index >= 0) s.activeIndex = index
      }
    } catch {
      // A chrome request is best-effort: never let one break the provider.
    }
  }

  /**
   * Usable whenever the host can create views. A host that exposes a local
   * {@link ElectronBrowserViewHost.isAvailable} probe is believed; a host that
   * omits it (a desktop shell's known-good viewHost, or a test fake) is assumed
   * usable. The probe is cheap and local, so this stays callable from the seam's
   * provider-selection path; the host owns any caching it needs.
   */
  available(): boolean {
    const probe = this.host.isAvailable
    if (typeof probe !== 'function') return true
    try {
      return probe.call(this.host) === true
    } catch {
      // A probe that throws (e.g. a binary resolver error) means "not usable";
      // provider selection must never surface that error itself.
      return false
    }
  }

  /**
   * Open or recover the browser session for a task key. The tool layer normally
   * caches this id, but the Provider is authoritative so a scoped tool reload or
   * a lost cache cannot create a second task session with a different tab set.
   * Sessions keep isolated tabs, active tab, and history while the host keeps one
   * human-selected task view visible in the shared BrowserWindow.
   */
  async open(options?: BrowserOpenOptions): Promise<BrowserSessionId> {
    const taskKey = options?.key ?? 'default'
    const taskLabel = options?.label ?? ''
    const existing = this.sessionForTask(taskKey)
    if (existing !== undefined) {
      if (taskLabel !== '' && existing.taskLabel !== taskLabel) {
        existing.taskLabel = taskLabel
        const active = existing.tabs[existing.activeIndex]?.handle
        const labelable = active as { label?(label: string): Promise<void> } | undefined
        if (typeof labelable?.label === 'function') await labelable.label(taskLabel).catch(() => undefined)
      }
      return existing.id
    }
    const handle = this.host.createView(taskKey, taskLabel === '' ? undefined : taskLabel)
    const id = `browser:${randomUUID()}`
    this.sessions.set(id, { id, taskKey, taskLabel, tabs: [this.createTab(handle)], activeIndex: 0, history: [], nextSeq: 1 })
    this.sessionsByTask.set(taskKey, id)
    if (!this.taskStates.has(taskKey)) {
      this.taskStates.set(taskKey, { status: 'idle', control: 'agent', updatedAt: Date.now() })
    }
    return id
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

  /**
   * Close one tab; closing the active tab activates the next. Resolves false when
   * the id is not open in this session, so a miss is distinguishable from a close.
   */
  async closeTab(session: BrowserSessionId, tabId: string): Promise<boolean> {
    const s = this.session(session)
    const index = s.tabs.findIndex(tab => tab.id === tabId)
    if (index < 0) return Promise.resolve(false) // idempotent
    const removed = s.tabs[index]
    if (removed !== undefined) {
      s.tabs.splice(index, 1)
      this.ignoreHostFailure(this.host.destroyView(removed.handle))
    }
    if (s.tabs.length === 0) {
      // Session keeps one blank tab so it stays usable. **必须等**：newTab 建宿主视图是异步的，
      // 先 showActive 会去显示一个还不存在的视图 → 宿主报 unknown view（而且是条没人接的 rejection，
      // 会串到别的工具调用上报错）。
      await this.newTab(s)
    } else if (index < s.activeIndex) {
      // Closing a tab before the active one shifts the array left; keep the
      // same tab active by decrementing the index.
      s.activeIndex -= 1
    } else if (s.activeIndex >= s.tabs.length) {
      // The active tab itself was closed; activate the last remaining one.
      s.activeIndex = s.tabs.length - 1
    }
    this.showActive(s)
    return true
  }

  /** Close every tab and reset to one blank tab. */
  reset(session: BrowserSessionId): Promise<void> {
    const s = this.session(session)
    for (const tab of s.tabs) this.ignoreHostFailure(this.host.destroyView(tab.handle))
    s.tabs.length = 0
    this.newTab(s)
    s.activeIndex = 0
    this.showActive(s)
    return Promise.resolve()
  }

  /**
   * Dispatch one input command under the same hang guard as the CDP reads. A
   * renderer blocked in synchronous JS never acknowledges, so an unbounded await
   * here would hang the tool call until the caller's budget expired.
   * @param handle - the view to dispatch into.
   * @param method - the CDP input method.
   * @param params - its parameters.
   * @param signal - optional caller signal.
   */
  private async dispatchInput(
    handle: ElectronViewHandle,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.ensureInputFocus(handle)
      await withTimeout(
        handle.sendCommand(method, params),
        INPUT_DISPATCH_TIMEOUT_MS,
        signal,
        `browser: ${method} timed out after ${INPUT_DISPATCH_TIMEOUT_MS}ms`,
      )
    } catch (error) {
      // A tab closed under the keystroke that closed it is the requested outcome,
      // not a failure: there is nothing left for this event to act on.
      if (!isClosedInputTarget(error)) throw error
    }
  }

  /**
   * Tell a renderer it is focused, once, before synthesized input.
   *
   * Chromium drops a synthesized mouse *press* when the renderer does not
   * believe it has focus — which is the normal state for a background task's
   * view, and on a real page even for the visible one while its window is not
   * active. Moves are not gated, so hover looked fine while every click
   * resolved its target, reported success, and left the page untouched.
   *
   * Focus emulation keeps this on the trusted CDP input path: no synthetic
   * DOM click, so the events stay isTrusted and nothing about the page's
   * view of the browser changes.
   */
  private async ensureInputFocus(handle: ElectronViewHandle): Promise<void> {
    if (focusEmulatedViews.has(handle)) return
    await handle.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
      .then(() => { focusEmulatedViews.add(handle) })
      .catch(() => undefined)
  }

  /**
   * Admit one URL for a provider-driven fetch (navigation or download).
   * The whole check is gated by `httpOnly`: when it is disabled, callers are
   * trusted with any scheme. When it is enabled, only HTTP(S) is admitted and
   * URL-embedded credentials are refused, so a target can never be reached
   * with in-URL auth.
   * @param url - the candidate URL.
   * @param subject - the operation name used in the error text.
   */
  private admitUrl(url: string, subject: 'navigation' | 'download'): void {
    if (!this.httpOnly) return
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new BrowserError(`browser: refusing ${subject} to unparseable URL "${url}"`, 'BROWSER_NAVIGATION_BLOCKED')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BrowserError(`browser: refusing ${subject} to non-HTTP(S) URL "${url}"`, 'BROWSER_NAVIGATION_BLOCKED')
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new BrowserError(`browser: refusing ${subject} to a URL with embedded credentials`, 'BROWSER_NAVIGATION_BLOCKED')
    }
  }

  /** Navigate the active tab's view to a URL, honoring HTTP(S)-only admission. */
  async navigate(session: BrowserSessionId, request: { readonly url: string }, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    return this.navigateTab(s, this.activeTab(s), request.url, signal)
  }

  /**
   * Navigate one tab. A scrape worker passes its own tab so a batch never races
   * a tool call for the session's active tab.
   * @param show - bring the tab to the front; a background worker passes false.
   * @param settleMs - post-ready paint delay; a DOM-only reader passes 0.
   */
  private async navigateTab(s: Session, tab: Tab, url: string, signal?: AbortSignal, show = true, settleMs = 250): Promise<void> {
    const { handle } = tab
    try {
      this.admitUrl(url, 'navigation')
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
      if (show) this.showActive(s)
      // Page.navigate resolves on commit. Wait best-effort for page load so
      // browser_open does not snapshot a still-blank renderer.
      await waitForDocumentReady(handle, signal, settleMs)
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
    return this.executeTab(s, this.activeTab(s), request, signal)
  }

  /** Evaluate in one tab's page context. */
  private async executeTab(s: Session, tab: Tab, request: BrowserExecuteRequest, signal?: AbortSignal): Promise<BrowserExecuteResult> {
    const { handle } = tab
    signal?.throwIfAborted()
    await this.drainDialog(s, handle)
    try {
      // Wrap the script in a Function so `return` statements are legal and
      // request.args arrive as `arguments[0..n]` (a real function, not an
      // arrow, so `arguments` resolves). Args are embedded as a JSON array
      // literal; unserializable members become null.
      const built = buildEvaluateBody(request.script)
      if ('error' in built) {
        const exception = `browser: execute could not parse the script as an expression or as a statement body: ${built.error}`
        this.record(s, 'execute', { script: request.script }, false, { error: exception })
        return { ok: false, exception }
      }
      const body = built.body
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
  async snapshot(session: BrowserSessionId, options: { query?: string; limit?: number } = {}, signal?: AbortSignal): Promise<BrowserSnapshotResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, tab.handle)
    const requested = options.limit === undefined ? this.snapshotMaxElements : Math.max(1, Math.min(1000, Math.trunc(options.limit)))
    const cap = options.limit === undefined ? this.snapshotMaxElements : requested
    const query = (options.query ?? '').trim().toLowerCase()
    const script = `(() => {
      const cap = ${String(cap)}
      const query = ${JSON.stringify(query)}
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
      const pathOf = (el, doc) => {
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
          if (node === doc.body) break
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
      const out = []
      let capped = false
      // 同一套判定，用在顶层文档和每个同源子框架上；dx/dy 把框架内的坐标换算成页面坐标。
      const collect = (doc, frameIndex, dx, dy) => {
        const els = [...doc.querySelectorAll('input, textarea, select, button, a[href], [role="button"], [role="searchbox"], [role="link"], [contenteditable="true"]')]
        for (const el of els) {
          if (el.closest('[data-dsh-browser-chrome]')) continue
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          if (r.width < 4 || r.height < 4 || cs.visibility === 'hidden' || cs.display === 'none') continue
          const kind = el.tagName === 'INPUT' ? (el.type === 'checkbox' ? 'checkbox' : (el.type === 'submit' || el.type === 'button' ? 'button' : 'text'))
            : el.tagName === 'TEXTAREA' ? 'textarea'
            : el.tagName === 'SELECT' ? 'select'
            : el.tagName === 'BUTTON' ? 'button'
            : el.tagName === 'A' ? 'link' : 'other'
          const label = (el.getAttribute('aria-label') || el.placeholder || el.textContent || el.value || el.name || el.id || '').replace(/\s+/g, ' ').trim().slice(0, 120)
          if (!label && kind !== 'link') continue
          // 过滤放在计上限**之前**：默认上限是 60，先截断就永远搜不到后面的元素。
          if (query !== '' && (kind + ' ' + label).toLowerCase().indexOf(query) === -1) continue
          if (out.length >= cap) { capped = true; return }
          out.push({
            ref: out.length + 1,
            kind,
            label,
            ...(frameIndex === undefined ? {} : { frame: frameIndex }),
            selector: el.id ? '#' + CSS.escape(el.id) : (el.name ? '[name=' + JSON.stringify(el.name) + ']' : ''),
            loc: locatorOf(el),
            path: pathOf(el, doc),
            fingerprint: fingerprintOf(el),
            x: Math.round(r.x + r.width / 2 + dx),
            y: Math.round(r.y + r.height / 2 + dy),
          })
        }
      }
      collect(document, undefined, 0, 0)
      // 子框架：同源的走进去（元素带 frame 序号、坐标加上框架自己的矩形）；
      // 跨源的 contentDocument 读不到，就只记一条 readable:false —— 不假装能读。
      const frames = []
      const frameEls = [...document.querySelectorAll('iframe')]
      for (let i = 0; i < frameEls.length; i++) {
        const frame = frameEls[i]
        const src = frame.getAttribute('src') || ''
        let inner = null
        try { inner = frame.contentDocument } catch (error) { inner = null }
        if (inner === null) {
          frames.push({ index: i, url: src, readable: false })
          continue
        }
        const fr = frame.getBoundingClientRect()
        frames.push({ index: i, url: inner.location.href || src, readable: true })
        if (out.length >= cap) { capped = true; continue }
        collect(inner, i, fr.left, fr.top)
      }
      const challenge = ${CHALLENGE_DETECT_EXPRESSION}
      const chromeHost = document.getElementById('__dsh_browser_chrome_host__')
      const userControlling = chromeHost?.getAttribute('data-dsh-user-active') === '1'
      // Only an early break means truncation: exactly cap candidates is a
      // complete inventory, not a truncated one.
      return { url, title, elements: out, truncated: capped, frames, challenge, userControlling }
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
    // The phase is budgeted because each attempt may itself wait the evaluation
    // timeout, and an aborted call must surface rather than be retried on.
    const retryDeadline = Date.now() + SNAPSHOT_RETRY_BUDGET_MS
    for (let attempt = 0; attempt < 5 && value.elements.length === 0 && value.truncated !== true; attempt++) {
      const remaining = retryDeadline - Date.now()
      if (remaining <= 0) break
      signal?.throwIfAborted()
      await new Promise(resolve => setTimeout(resolve, Math.min(400, remaining)))
      if (signal?.aborted === true) break
      const retry = await withTimeout(
        handleSendEvaluate(tab.handle, script, signal),
        Math.min(timeoutMs, Math.max(retryDeadline - Date.now(), 500)),
        signal,
        `browser: snapshot timed out after ${timeoutMs}ms`,
      ).catch((error: unknown) => {
        if (signal?.aborted === true) throw error
        return undefined
      })
      if (retry?.ok) value = retry.value as RawSnapshot
    }
    const snapshotId = `snapshot:${randomUUID()}`
    const targets = new Map<number, SnapshotTarget>()
    for (const element of value.elements) {
      targets.set(element.ref, {
        path: element.path,
        fingerprint: element.fingerprint,
        ...element.frame !== undefined ? { frame: element.frame } : {},
      })
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
      ...value.frames !== undefined ? { frames: value.frames } : {},
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
    await this.dispatchInput(tab.handle, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 } satisfies CdpMouseParams, signal)
    await this.dispatchInput(tab.handle, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 } satisfies CdpMouseParams, signal)
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
      else if (fmt === 'json') {
        // An element has no own enumerable properties, so JSON.stringify(root)
        // always produced "{}". Serialize a bounded structural view instead, and
        // pass a genuine JSON payload through unchanged.
        const raw = (root.textContent || '').trim()
        let parsed
        try { parsed = JSON.parse(raw) } catch { parsed = undefined }
        if (parsed !== undefined) content = JSON.stringify(parsed)
        else {
          const shape = (el, depth) => {
            const node = { tag: el.tagName ? el.tagName.toLowerCase() : undefined }
            if (depth >= 8) return node
            if (el.id) node.id = el.id
            if (typeof el.className === 'string' && el.className !== '') node.class = el.className
            const kids = el.children ? [...el.children].slice(0, 40) : []
            if (kids.length > 0) node.children = kids.map(child => shape(child, depth + 1))
            else {
              const text = (el.textContent || '').trim().slice(0, 200)
              if (text !== '') node.text = text
            }
            return node
          }
          content = JSON.stringify(shape(root, 0))
        }
      }
      // markdown: headings, links, lists, paragraphs (best-effort). The
      // renderer is embedded from its own source, so the function under test
      // is byte-for-byte the one that runs in the page.
      else content = (${renderMarkdown.toString()})(root)
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
  async click(session: BrowserSessionId, target: BrowserPointerTarget, signal?: AbortSignal): Promise<BrowserPointerResult> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, handle)
    const point = await resolvePointerTarget(handle, target, signal)
    await suppressAutoUserControl(handle, signal)
    // Electron installs no native context menu, so a right-click reaches the
    // page's own handler — which is exactly what an agent wants to drive.
    const button = target.button ?? 'left'
    const modifiers = modifierMask(target.modifiers)
    await this.dispatchInput(handle, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, clickCount: 1, modifiers } satisfies CdpMouseParams, signal)
    await this.dispatchInput(handle, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, clickCount: 1, modifiers } satisfies CdpMouseParams, signal)
    this.record(s, 'click', { x: point.x, y: point.y, ...point.target === undefined ? {} : { target: point.target }, button, ...target.modifiers !== undefined && target.modifiers.length > 0 ? { modifiers: target.modifiers } : {} }, true)
    return point
  }

  /** Double-click a target (physical input; clickCount 2). */
  async doubleClick(session: BrowserSessionId, target: BrowserPointerTarget, signal?: AbortSignal): Promise<BrowserPointerResult> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, handle)
    const point = await resolvePointerTarget(handle, target, signal)
    await suppressAutoUserControl(handle, signal)
    const button = target.button ?? 'left'
    const modifiers = modifierMask(target.modifiers)
    await this.dispatchInput(handle, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, clickCount: 2, modifiers } satisfies CdpMouseParams, signal)
    await this.dispatchInput(handle, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, clickCount: 2, modifiers } satisfies CdpMouseParams, signal)
    this.record(s, 'doubleClick', { x: point.x, y: point.y, ...point.target === undefined ? {} : { target: point.target }, button, ...target.modifiers !== undefined && target.modifiers.length > 0 ? { modifiers: target.modifiers } : {} }, true)
    return point
  }

  /** Move the pointer over a target (no click). */
  async hover(session: BrowserSessionId, target: BrowserPointerTarget, signal?: AbortSignal): Promise<BrowserPointerResult> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, handle)
    const point = await resolvePointerTarget(handle, target, signal)
    await this.dispatchInput(handle, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', modifiers: modifierMask(target.modifiers) } satisfies CdpMouseParams, signal)
    this.record(s, 'hover', { x: point.x, y: point.y, ...point.target === undefined ? {} : { target: point.target } }, true)
    return point
  }

  /**
   * Press on one target, move to another, release.
   *
   * A hand does not teleport: the intermediate moves are what pointer-based
   * sliders and sortable libraries listen for, so a press straight onto the
   * destination would be ignored. Note this drives *pointer* drags only —
   * HTML5 drag-and-drop needs dragstart/drop, which synthesized mouse moves do
   * not produce; use the page's own controls, or a click-based reorder, there.
   */
  async drag(session: BrowserSessionId, request: BrowserDragRequest, signal?: AbortSignal): Promise<BrowserDragResult> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, handle)
    const from = await resolvePointerTarget(handle, request.from, signal)
    const to = await resolvePointerTarget(handle, request.to, signal)
    await suppressAutoUserControl(handle, signal)
    const steps = Math.max(1, Math.min(Math.trunc(request.steps ?? 12) || 12, 60))
    // Hover the source first: some libraries only arm on an enter.
    await this.dispatchInput(handle, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0 } satisfies CdpMouseParams, signal)
    await this.dispatchInput(handle, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 } satisfies CdpMouseParams, signal)
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps
      await this.dispatchInput(handle, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from.x + (to.x - from.x) * ratio,
        y: from.y + (to.y - from.y) * ratio,
        button: 'left',
        buttons: 1,
      } satisfies CdpMouseParams, signal)
      // Distinct events, not one burst: a listener that reads positions per
      // frame needs the gesture to span more than a single tick.
      await new Promise(resolve => setTimeout(resolve, DRAG_STEP_DELAY_MS))
    }
    await this.dispatchInput(handle, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, buttons: 0 } satisfies CdpMouseParams, signal)
    this.record(s, 'drag', {
      from: { x: Math.round(from.x), y: Math.round(from.y), ...from.target === undefined ? {} : { target: from.target } },
      to: { x: Math.round(to.x), y: Math.round(to.y), ...to.target === undefined ? {} : { target: to.target } },
      steps,
    }, true)
    return { from, to }
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
    // Same input semantics as click/type: do not let the page hand control to
    // the human while an agent-driven file selection is in flight.
    await suppressAutoUserControl(handle, signal)
    const selector = request.selector ?? 'input[type="file"]'
    // A file handed to a page leaves the machine, so admission happens before
    // any DOM work: the path must exist and sit inside the configured roots.
    const filePath = resolveReadPath(request.filePath, this.readRoots)
    // Bound the whole DOM sequence: a wedged renderer must not hang the tool.
    const timeoutMs = 30_000
    await withTimeout((async () => {
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
      await handle.sendCommand('DOM.setFileInputFiles', { files: [filePath], nodeId })
    })(), timeoutMs, signal, `browser: upload timed out after ${timeoutMs}ms`)
    this.record(s, 'uploadFile', { filePath: request.filePath, selector }, true, { result: '1 file attached' })
    return { path: request.filePath }
  }

  /**
   * Poll until an element matching the selector exists (and is visible).
   * Bounds the total wait; a timeout surfaces as BROWSER_WAIT_TIMEOUT.
   */
  async waitForElement(session: BrowserSessionId, request: BrowserWaitForRequest, signal?: AbortSignal): Promise<BrowserWaitForResult> {
    const s = this.session(session)
    return this.waitForElementTab(s, this.activeTab(s), request, signal)
  }

  /** Poll one tab until the selector and/or text reaches the requested state. */
  private async waitForElementTab(s: Session, tab: Tab, request: BrowserWaitForRequest, signal?: AbortSignal): Promise<BrowserWaitForResult> {
    const { handle } = tab
    signal?.throwIfAborted()
    const timeoutMs = request.timeoutMs ?? 15_000
    const selector = request.selector ?? ''
    const wanted = request.text
    const state: 'visible' | 'attached' | 'hidden' | 'detached' = request.state ?? (request.visible === false ? 'attached' : 'visible')
    if (selector === '' && wanted === undefined) {
      throw new BrowserError('browser: waitForElement needs a selector, some text, or both', 'BROWSER_WAIT_INVALID')
    }
    if (selector === '' && (state === 'hidden' || state === 'detached')) {
      throw new BrowserError(`browser: state "${state}" needs a selector to watch disappear`, 'BROWSER_WAIT_INVALID')
    }
    const script = `(() => {
      const selector = ${JSON.stringify(selector)}
      const wanted = ${JSON.stringify(wanted ?? null)}
      const state = ${JSON.stringify(state)}
      let el = null
      if (selector !== '') {
        try { el = document.querySelector(selector) } catch (e) { return { error: String(e) } }
      }
      const visibleNow = node => {
        if (node === null) return false
        const r = node.getBoundingClientRect()
        if (r.width < 4 || r.height < 4) return false
        const cs = getComputedStyle(node)
        return cs.visibility !== 'hidden' && cs.display !== 'none'
      }
      const textOf = node => (node === null ? '' : (node.textContent || '')).replace(/\\s+/g, ' ').trim()
      const attached = el !== null
      const visible = visibleNow(el)
      let met = state === 'attached' ? attached : state === 'visible' ? visible : state === 'hidden' ? !visible : state === 'detached' ? !attached : false
      if (met && wanted !== null) met = (selector === '' ? textOf(document.body) : textOf(el)).includes(wanted)
      if (!met) return null
      return {
        found: true,
        state,
        selector,
        tag: attached ? el.tagName.toLowerCase() : '',
        text: (wanted !== null && !attached ? wanted : textOf(selector === '' ? document.body : el)).slice(0, 200),
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
          this.record(s, 'waitForElement', { selector, text: wanted, state, timeoutMs }, true, { result: value.tag ?? '' })
          return { found: true, state, selector, tag: value.tag, text: value.text ?? '' }
        }
        if (value?.error !== undefined) {
          // A malformed selector can never start matching, so fail now instead of
          // polling to the deadline and reporting a misleading timeout.
          throw new BrowserError(`browser: invalid selector "${selector}": ${value.error}`, 'BROWSER_SELECTOR_INVALID')
        }
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(deadline - Date.now(), 1))))
    }
    const what = selector === '' ? `text ${JSON.stringify(wanted)}` : `"${selector}"`
    throw new BrowserError(`browser: ${what} did not reach state "${state}" within ${timeoutMs}ms${lastError !== undefined ? ` (${lastError})` : ''}`, 'BROWSER_WAIT_TIMEOUT')
  }

  /** Type into the focused element. */
  async type(session: BrowserSessionId, request: { readonly text: string }, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    await this.drainDialog(s, handle)
    await suppressAutoUserControl(handle, signal)
    await this.dispatchInput(handle, 'Input.insertText', { text: request.text } satisfies CdpInsertTextParams, signal)
    // Store the full text so replay re-issues the same input; the history
    // tool truncates long values when rendering.
    this.record(s, 'type', { text: request.text }, true)
  }

  /**
   * Drive the host's chrome frame view with a raw CDP command.
   *
   * The chrome can live in a view of its own so the page viewport can really
   * shrink; that view is not a tab, so this is the only way to click the toolbar
   * (the click tests use it, and so does anything that needs to exercise the
   * chrome the way a person does).
   */
  async chromeInput(method: string, params: Record<string, unknown> = {}): Promise<void> {
    const host = this.host
    if (typeof host.chromeInput !== 'function') throw new Error('this browser host has no chrome frame view')
    await host.chromeInput(method, params)
  }

  /**
   * Read a value back out of the chrome frame's own document.
   *
   * The frame is not a tab, so a page-directed evaluate cannot see it; without
   * this the toolbar's animations could only be inferred from the page's copy.
   */
  async chromeEval(expression: string): Promise<unknown> {
    const host = this.host
    if (typeof host.chromeEval !== 'function') throw new Error('this browser host has no chrome frame view')
    return await host.chromeEval(expression)
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
    await this.dispatchInput(handle, CDP_INPUT_DISPATCH_KEY_EVENT, down, signal)
    await this.dispatchInput(handle, CDP_INPUT_DISPATCH_KEY_EVENT, { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }, signal)
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
      const filledEls = []
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
        const before = out.length
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
            if (el.checked !== want) { out.push({ ok: false, error: 'checkbox did not change (disabled, or a handler prevented it)', target: describe(spec) }); continue }
            out.push({ ok: true, method: 'checkbox', target: describe(spec) })
          } else if (type === 'radio') {
            const wanted = String(spec.value)
            const radio = [...document.querySelectorAll('input[type="radio"][name=' + JSON.stringify(el.name || '') + ']')]
              .find(r => r.value === wanted || (r === el && (spec.value === true || spec.value === 'true')))
            if (!radio) { out.push({ ok: false, error: 'radio option not found: ' + wanted, target: describe(spec) }); continue }
            if (!radio.checked) radio.click()
            if (!radio.checked) { out.push({ ok: false, error: 'radio did not change (disabled, or a handler prevented it)', target: describe(spec) }); continue }
            out.push({ ok: true, method: 'radio', target: describe(spec) })
          } else if (el.isContentEditable) {
            el.textContent = String(spec.value)
            el.dispatchEvent(new Event('input', { bubbles: true }))
            out.push({ ok: true, method: 'contenteditable', target: describe(spec) })
          } else if (tag === 'TEXTAREA') {
            const wanted = String(spec.value)
            setNative(el, HTMLTextAreaElement.prototype, wanted)
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            if (wanted !== '' && el.value === '') { out.push({ ok: false, error: 'the field rejected the value', target: describe(spec) }); continue }
            out.push({ ok: true, method: 'textarea', target: describe(spec) })
          } else {
            const wanted = String(spec.value)
            setNative(el, HTMLInputElement.prototype, wanted)
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            // A constrained input (number/date/email) silently blanks a value it
            // will not accept. Only the empty outcome is unambiguous: the DOM may
            // legitimately normalise a value it did accept.
            if (wanted !== '' && el.value === '') { out.push({ ok: false, error: 'the field rejected the value', target: describe(spec) }); continue }
            out.push({ ok: true, method: 'input', target: describe(spec) })
          }
        } catch (e) {
          out.push({ ok: false, error: String(e), target: describe(spec) })
        }
        // Remember what actually landed, so submit anchors on a form the caller
        // really filled rather than the first field the page happens to expose.
        if (out.length > before && out[out.length - 1].ok === true) filledEls.push(el)
      }
      let submitted = false
      let blockReason = ''
      if (${submitFlag}) {
        let anchor = null
        for (let index = filledEls.length - 1; index >= 0; index--) {
          const candidate = filledEls[index]
          if (candidate.form || candidate.closest('form')) { anchor = candidate; break }
        }
        const form = anchor === null ? null : (anchor.form || anchor.closest('form'))
        if (form === null) blockReason = 'no containing form'
        // requestSubmit() runs constraint validation: on an invalid form it
        // neither throws nor submits, so reporting submitted:true was a silent
        // false success.
        else if (typeof form.checkValidity === 'function' && form.checkValidity() !== true) blockReason = 'the form is invalid'
        else { form.requestSubmit(); submitted = true }
      }
      return { fields: out, submitted, blockReason }
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
    const value = result.value as BrowserFillResult & { readonly blockReason?: string }
    const okCount = value.fields.filter(f => f.ok).length
    const submitNote = value.submitted
      ? ', form submitted'
      : value.blockReason !== undefined && value.blockReason !== ''
        ? `, submit blocked: ${value.blockReason}`
        : ''
    this.record(s, 'fill', { fields: request.fields.length, submit: submitFlag }, okCount === value.fields.length, {
      result: `${okCount}/${value.fields.length} fields filled${submitNote}`,
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
    // A download reaches the network with the session's cookies, so it passes
    // the same URL admission as navigation, and may only write inside the
    // configured roots.
    this.admitUrl(request.url, 'download')
    const target = resolveWritePath(request.savePath, this.writeRoots)
    // The child fetches in-page with awaitPromise; a slow/hung network can
    // block it well past the tool budget, so bound it like every other call.
    const timeoutMs = 60_000
    await withTimeout(
      downloadable.download(request.url, target),
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

  /**
   * Remove cookies for one site scope. Challenge cookies that rotate their names
   * (WAF challenges) otherwise pile up generation after generation, and two live
   * generations in one request can be rejected by the site. Self-hosted only.
   */
  async clearAuth(session: BrowserSessionId, request: BrowserClearAuthRequest): Promise<BrowserClearAuthResult> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    const clearable = handle as { clearCookies?(filter: BrowserClearAuthRequest): Promise<{ removed: number; names: readonly string[] }> }
    if (typeof clearable.clearCookies !== 'function') {
      throw new BrowserError('browser: cookie clearing is only available on the self-hosted browser', 'BROWSER_AUTH_UNSUPPORTED')
    }
    const timeoutMs = 30_000
    const result = await withTimeout(
      clearable.clearCookies(request),
      timeoutMs,
      undefined,
      'browser: cookie clear timed out after ' + String(timeoutMs) + 'ms',
    )
    this.record(s, 'clearAuth', {
      ...request.domain !== undefined ? { domain: request.domain } : {},
      ...request.name !== undefined ? { name: request.name } : {},
      ...request.all === true ? { all: true } : {},
    }, true, { result: String(result.removed) + ' cookies' })
    return { removed: result.removed, names: [...result.names] }
  }

  /**
   * Import cookies from a JSON export on disk.
   *
   * The path is read-guarded exactly like browser_upload_file: a prompt-injected
   * path must not turn this into a way to read a file the operator never allowed.
   * A browser cookie export cannot be produced automatically — Chrome and Edge
   * 127+ encrypt cookie values with App-Bound Encryption, so a copied profile
   * yields nothing — which is why this takes a file the user exported.
   */
  async importAuth(session: BrowserSessionId, path: string): Promise<{ restored: number; failed: number }> {
    const s = this.session(session)
    const target = resolveReadPath(path, this.readRoots)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(target, 'utf8')) as unknown
    } catch (error) {
      throw new BrowserError(`browser: cannot read the cookie file: ${(error as Error).message}`, 'BROWSER_AUTH_FILE_INVALID')
    }
    // Accept both a bare array and the {"cookies": [...]} shape editors emit.
    const list = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { cookies?: unknown }).cookies)
        ? (parsed as { cookies: unknown[] }).cookies
        : undefined
    if (list === undefined) {
      throw new BrowserError('browser: the cookie file must be a JSON array or {"cookies": [...]}', 'BROWSER_AUTH_FILE_INVALID')
    }
    const usable = list.map(normalizeExportedCookie).filter((cookie): cookie is ExportedCookie => cookie !== undefined)
    if (usable.length === 0) {
      throw new BrowserError(`browser: the cookie file has no usable entries (${list.length} read)`, 'BROWSER_AUTH_FILE_INVALID')
    }
    const restored = await this.restoreAuth(session, usable)
    this.record(s, 'importAuth', { count: usable.length }, true, { result: `${restored} cookies` })
    return { restored, failed: list.length - usable.length }
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

  /**
   * Start a background scrape batch.
   *
   * It runs detached on purpose: one tool call has a ~60s budget while a large
   * batch takes minutes. Progress is polled with scrapeStatus, and each row is
   * appended the moment it is produced, so a stopped or interrupted batch keeps
   * everything it managed. `outPath` is write-guarded like any other browser
   * write, and truncated up front so a re-run never mixes two batches.
   */
  async startScrape(session: BrowserSessionId, request: BrowserScrapeRequest): Promise<BrowserScrapeStatus> {
    const s = this.session(session)
    const urls = request.urls.filter(url => typeof url === 'string' && url.trim() !== '')
    if (urls.length === 0) {
      throw new BrowserError('browser: scrape needs at least one URL', 'BROWSER_SCRAPE_EMPTY')
    }
    if (typeof request.script !== 'string' || request.script.trim() === '') {
      throw new BrowserError('browser: scrape needs an extraction script', 'BROWSER_SCRAPE_EMPTY')
    }
    const target = resolveWritePath(request.outPath, this.writeRoots)
    writeFileSync(target, '')
    // Created only after every guard has passed, so a rejected start leaves no
    // orphaned view behind.
    const workers = Math.max(1, Math.min(Math.trunc(request.concurrency ?? 1) || 1, MAX_SCRAPE_WORKERS))
    const tabs: Tab[] = []
    for (let i = 0; i < workers; i += 1) {
      const handle = this.host.createView(s.taskKey, s.taskLabel === '' ? undefined : s.taskLabel)
      const tab = this.createTab(handle)
      s.tabs.push(tab)
      tabs.push(tab)
    }
    const job: ScrapeJob = {
      id: `scrape:${randomUUID()}`,
      session: s,
      tabs,
      path: target,
      state: 'running',
      total: urls.length,
      done: 0,
      failed: 0,
    }
    this.scrapes.set(job.id, job)
    void this.runScrape(job, urls, request).catch(error => {
      job.state = 'done'
      job.error = String((error as Error)?.message ?? error)
    })
    this.record(s, 'scrape', { total: urls.length }, true, { result: `${urls.length} urls` })
    return scrapeStatusOf(job)
  }

  /** Progress of one batch. */
  async scrapeStatus(id: string): Promise<BrowserScrapeStatus> {
    return scrapeStatusOf(this.scrapeJob(id))
  }

  /** Ask a running batch to stop; rows already written stay. */
  async stopScrape(id: string): Promise<BrowserScrapeStatus> {
    const job = this.scrapeJob(id)
    if (job.state === 'running') job.state = 'stopped'
    return scrapeStatusOf(job)
  }

  /** Every batch this process knows about, oldest first. */
  async listScrapes(): Promise<readonly BrowserScrapeStatus[]> {
    return [...this.scrapes.values()].map(scrapeStatusOf)
  }

  private scrapeJob(id: string): ScrapeJob {
    const job = this.scrapes.get(id)
    if (job === undefined) {
      throw new BrowserError(`browser: unknown scrape ${id}`, 'BROWSER_SCRAPE_UNKNOWN')
    }
    return job
  }

  /**
   * Visit each URL once, appending one JSONL row per page.
   *
   * Workers pull from one shared index, so `concurrency` sets the throughput
   * without changing the work. Rows therefore land in completion order; each row
   * carries its URL's index as `seq` so the caller can restore the original.
   */
  private async runScrape(job: ScrapeJob, urls: readonly string[], request: BrowserScrapeRequest): Promise<void> {
    const perUrl = request.timeoutMs ?? 30_000
    let next = 0
    const take = (): number | undefined => (next < urls.length ? next++ : undefined)

    const worker = async (tab: Tab): Promise<void> => {
      for (;;) {
        if (job.state !== 'running') return
        const index = take()
        if (index === undefined) return
        const url = urls[index] ?? ''
        let row: Record<string, unknown>
        try {
          // show: false — the batch works in the background tab it owns.
          // settleMs: 0 — it reads the DOM, so it must not pay the paint delay.
          await this.navigateTab(job.session, tab, url, undefined, false, 0)
          if (request.waitFor !== undefined) {
            await this.waitForElementTab(job.session, tab, { selector: request.waitFor, timeoutMs: perUrl })
          }
          const result = await this.executeTab(job.session, tab, { script: request.script, timeoutMs: perUrl })
          if (result.ok) {
            row = { seq: index, url, ok: true, data: result.value }
          } else {
            job.failed += 1
            row = { seq: index, url, ok: false, error: result.exception }
          }
        } catch (error) {
          // One bad page must not end the batch: record it and keep going.
          job.failed += 1
          row = { seq: index, url, ok: false, error: String((error as Error)?.message ?? error) }
        }
        // appendFileSync blocks, so two workers can never interleave a row.
        appendFileSync(job.path, scrapeRow(row))
        job.done += 1
      }
    }

    try {
      await Promise.all(job.tabs.map(tab => worker(tab)))
      job.state = 'done'
    } finally {
      // The tabs outlive the loop only until here; a stopped batch cleans up too.
      this.destroyScrapeTabs(job)
    }
  }

  /** Drop a batch's private tabs (and their views) once the batch is over. */
  private destroyScrapeTabs(job: ScrapeJob): void {
    const s = job.session
    for (const tab of job.tabs) {
      const index = s.tabs.findIndex(candidate => candidate.id === tab.id)
      if (index < 0) continue
      s.tabs.splice(index, 1)
      this.ignoreHostFailure(this.host.destroyView(tab.handle))
      // Same index bookkeeping as closeTab: a batch tab is normally not active,
      // but a tool call could have activated one mid-batch.
      if (s.tabs.length === 0) {
        this.newTab(s)
      } else if (index < s.activeIndex) {
        s.activeIndex -= 1
      } else if (s.activeIndex >= s.tabs.length) {
        s.activeIndex = s.tabs.length - 1
      }
    }
    this.showActive(s)
  }

  /** Capture the current page, optionally full-page. PNG only (CDP JPEG hangs on Electron 43). */
  /**
   * Draw the DevTools highlight box over the first match of a selector, or clear it.
   * Uses CDP Overlay, so the page DOM is never touched.
   */
  async highlight(
    session: BrowserSessionId,
    request: BrowserHighlightRequest,
    signal?: AbortSignal,
  ): Promise<BrowserHighlightResult> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    if (request.clear === true) {
      this.ignoreHostFailure(handle.sendCommand(CDP_OVERLAY_HIDE_HIGHLIGHT, {}))
      return { matched: false, cleared: true }
    }
    const selector = request.selector ?? ''
    if (selector === '') {
      throw new BrowserError('browser: highlight needs a selector, or clear: true', 'BROWSER_HIGHLIGHT_INVALID')
    }
    const doc = await handle.sendCommand('DOM.getDocument', {})
    const rootId = (doc as { root?: { nodeId?: number } }).root?.nodeId
    if (typeof rootId !== 'number') {
      throw new BrowserError('browser: could not read the document root', 'BROWSER_HIGHLIGHT_FAILED')
    }
    const found = await handle.sendCommand('DOM.querySelector', { nodeId: rootId, selector })
    const nodeId = (found as { nodeId?: number }).nodeId ?? 0
    if (nodeId === 0) return { matched: false, cleared: false }
    let box: { x: number; y: number; width: number; height: number } | undefined
    try {
      const model = await handle.sendCommand('DOM.getBoxModel', { nodeId })
      const quad = (model as { model?: { content?: number[] } }).model?.content
      if (Array.isArray(quad) && quad.length >= 8) {
        const xs = [quad[0], quad[2], quad[4], quad[6]]
        const ys = [quad[1], quad[3], quad[5], quad[7]]
        const x = Math.min(...xs)
        const y = Math.min(...ys)
        box = { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
      }
    } catch { /* a zero-size element has no box model; the box is still highlighted */ }
    await handle.sendCommand(CDP_OVERLAY_ENABLE, {})
    await handle.sendCommand(CDP_OVERLAY_HIGHLIGHT_NODE, {
      nodeId,
      highlightConfig: {
        showInfo: true,
        contentColor: { r: 77, g: 107, b: 254, a: 0.28 },
        borderColor: { r: 77, g: 107, b: 254, a: 0.9 },
      },
    })
    this.record(s, 'highlight', { selector }, true, { result: `node ${nodeId}` })
    return { matched: true, cleared: false, nodeId, ...box !== undefined ? { box } : {} }
  }


  /** Print the active tab to a PDF file (Chrome's "Save as PDF"). */
  async pdf(
    session: BrowserSessionId,
    request: BrowserPdfRequest,
    signal?: AbortSignal,
  ): Promise<BrowserPdfResult> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    // Resolve first: a bad path must fail before we spend time printing.
    const target = resolveWritePath(request.savePath, this.writeRoots)
    const params: Record<string, unknown> = {
      // Backgrounds off by default would print dark pages as white paper.
      printBackground: request.printBackground !== false,
      landscape: request.landscape === true,
    }
    if (request.paperWidth !== undefined) params.paperWidth = request.paperWidth
    if (request.paperHeight !== undefined) params.paperHeight = request.paperHeight
    const timeoutMs = 60_000
    const result = await withTimeout(
      handle.sendCommand(CDP_PAGE_PRINT_TO_PDF, params),
      timeoutMs,
      signal,
      `browser: pdf timed out after ${timeoutMs}ms`,
    )
    const data = result.data
    if (typeof data !== 'string' || data === '') {
      throw new BrowserError('browser: printToPDF returned no data', 'BROWSER_PDF_FAILED')
    }
    const bytes = Buffer.from(data, 'base64')
    writeFileSync(target, bytes)
    this.record(s, 'pdf', { savePath: request.savePath, landscape: params.landscape }, true, { result: `${bytes.length} bytes` })
    return { path: request.savePath, bytes: bytes.length }
  }


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
      // Admit before writing so a denied path never touches disk.
      const target = resolveWritePath(savePath, this.writeRoots)
      try {
        writeFileSync(target, Buffer.from(base64, 'base64'))
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
        // Keep it: browser_dialog inspect reports the last one, and drainDialog is the
        // only place the host hands it over.
        s.lastDialog = dialog
        this.record(s, 'dialog', dialog as Record<string, unknown>, true)
      }
    } catch {
      // Dialog supervision is cosmetic; never fail a page operation for it.
    }
  }

  /**
   * Set how the host answers the next JS dialog, and report the resulting state.
   *
   * The policy lives in the host (it answers the CDP event there, where a
   * round-trip would already be too late), so this is a push, not a pull.
   */
  async setDialogPolicy(session: BrowserSessionId, policy: DialogPolicy): Promise<{ dialog: unknown; policy: DialogPolicy }> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    const normalized: DialogPolicy = policy.behavior === 'dismiss'
      ? (policy.promptText === undefined ? { behavior: 'dismiss' } : { behavior: 'dismiss', promptText: policy.promptText })
      : (policy.promptText === undefined ? { behavior: 'accept' } : { behavior: 'accept', promptText: policy.promptText })
    const pushable = handle as { setDialogPolicy?(policy: DialogPolicy): Promise<unknown> }
    if (typeof pushable.setDialogPolicy === 'function') {
      await pushable.setDialogPolicy(normalized)
    }
    s.dialogPolicy = normalized
    this.record(s, 'dialog-policy', { ...normalized }, true)
    return { dialog: s.lastDialog ?? null, policy: normalized }
  }

  /**
   * Console messages the host captured for the active tab.
   *
   * Reading does NOT clear by default: debugging is usually a look-again loop, so
   * `clear: true` is explicit. The host keeps a bounded ring, so old entries fall
   * off on their own.
   */
  async consoleMessages(session: BrowserSessionId, options: { limit?: number; level?: string; clear?: boolean } = {}): Promise<{ messages: BrowserConsoleMessage[] }> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    const reader = handle as { readConsole?(clear?: boolean): Promise<unknown> }
    if (typeof reader.readConsole !== 'function') return { messages: [] }
    const raw = await reader.readConsole(options.clear === true) as { messages?: unknown } | null | undefined
    const list = Array.isArray(raw?.messages) ? raw.messages as BrowserConsoleMessage[] : []
    const filtered = options.level === undefined ? list : list.filter(entry => entry.level === options.level)
    const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50)))
    return { messages: filtered.slice(-limit) }
  }

  /** Network requests the host captured for the active tab (bounded ring). */
  async networkRequests(session: BrowserSessionId, options: { limit?: number; failedOnly?: boolean; urlContains?: string; clear?: boolean } = {}): Promise<{ requests: BrowserNetworkRequest[] }> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    const reader = handle as { readNetwork?(clear?: boolean): Promise<unknown> }
    if (typeof reader.readNetwork !== 'function') return { requests: [] }
    const raw = await reader.readNetwork(options.clear === true) as { requests?: unknown } | null | undefined
    const list = Array.isArray(raw?.requests) ? raw.requests as BrowserNetworkRequest[] : []
    const needle = (options.urlContains ?? '').toLowerCase()
    const filtered = list.filter(entry => (options.failedOnly !== true || entry.failed !== undefined)
      && (needle === '' || entry.url.toLowerCase().includes(needle)))
    const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50)))
    return { requests: filtered.slice(-limit) }
  }

  /**
   * Apply device/viewport/media emulation to the active tab.
   *
   * Plain CDP through the existing command path, so no host change was needed.
   * `clear` undoes all three: metrics, user agent, and emulated media.
   */
  async emulate(session: BrowserSessionId, options: EmulateOptions = {}): Promise<{ applied: string[] }> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    const applied: string[] = []
    if (options.clear === true) {
      await handle.sendCommand('Emulation.clearDeviceMetricsOverride', {})
      await handle.sendCommand('Emulation.setUserAgentOverride', { userAgent: '' })
      await handle.sendCommand('Emulation.setEmulatedMedia', { media: '', features: [] })
      this.record(s, 'emulate', { clear: true }, true)
      return { applied: ['cleared'] }
    }
    if (options.width !== undefined && options.height !== undefined) {
      const width = Math.max(1, Math.trunc(options.width))
      const height = Math.max(1, Math.trunc(options.height))
      await handle.sendCommand('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: options.deviceScaleFactor ?? 0,
        mobile: options.mobile === true,
      })
      applied.push('viewport ' + String(width) + 'x' + String(height) + (options.mobile === true ? ' mobile' : ''))
    }
    if (options.userAgent !== undefined) {
      await handle.sendCommand('Emulation.setUserAgentOverride', { userAgent: options.userAgent })
      applied.push('user-agent')
    }
    if (options.colorScheme !== undefined) {
      await handle.sendCommand('Emulation.setEmulatedMedia', {
        media: '',
        features: [{ name: 'prefers-color-scheme', value: options.colorScheme }],
      })
      applied.push('color-scheme ' + options.colorScheme)
    }
    this.record(s, 'emulate', { ...applied.length === 0 ? { noop: true } : {} }, true)
    return { applied }
  }

  /**
   * Drain any dialog that opened since the last input call, then report the last
   * one and the current policy.
   *
   * `dialogState` alone is not enough for the tool: the host only hands a dialog
   * over when something drains it, so an inspect that does not drain misses exactly
   * the dialog the caller just triggered. (Found on the real machine.)
   */
  async inspectDialog(session: BrowserSessionId): Promise<{ dialog: unknown; policy: DialogPolicy }> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    await this.drainDialog(s, handle)
    return { dialog: s.lastDialog ?? null, policy: s.dialogPolicy ?? { behavior: 'accept' } }
  }

  /** The last JS dialog the host reported, plus the current policy. */
  dialogState(session: BrowserSessionId): { dialog: unknown; policy: DialogPolicy } {
    const s = this.session(session)
    return { dialog: s.lastDialog ?? null, policy: s.dialogPolicy ?? { behavior: 'accept' } }
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
      params: clampHistoryParams(params),
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
        if (entry.params.textTruncated === true) {
          throw new BrowserError(`browser: history seq ${seq} text was too long to keep in full; replay is not possible`, 'BROWSER_HISTORY_TRUNCATED')
        }
        await this.type(session, { text })
        this.record(s, 'replay', { seq, of: entry.action, text }, true)
        return
      }
      case 'execute': {
        const script = entry.params.script
        if (typeof script !== 'string') throw new BrowserError(`browser: history seq ${seq} execute has no script`, 'BROWSER_HISTORY_INVALID')
        if (entry.params.scriptTruncated === true) {
          throw new BrowserError(`browser: history seq ${seq} script was too long to keep in full; replay is not possible`, 'BROWSER_HISTORY_TRUNCATED')
        }
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
      for (const tab of existing.tabs) this.ignoreHostFailure(this.host.destroyView(tab.handle))
      const replacement = [...this.sessions.values()].find(candidate => candidate.taskKey === existing.taskKey)
      if (this.sessionsByTask.get(existing.taskKey) === session) {
        if (replacement === undefined) this.sessionsByTask.delete(existing.taskKey)
        else this.sessionsByTask.set(existing.taskKey, replacement.id)
      }
      if (replacement === undefined) {
        this.taskStates.delete(existing.taskKey)
      }
    }
    return Promise.resolve()
  }

  /** Recover the live session associated with a stable task key. */
  private sessionForTask(taskKey: string): Session | undefined {
    const indexed = this.sessionsByTask.get(taskKey)
    if (indexed !== undefined) {
      const session = this.sessions.get(indexed)
      if (session !== undefined) return session
      this.sessionsByTask.delete(taskKey)
    }
    for (const session of this.sessions.values()) {
      if (session.taskKey === taskKey) {
        this.sessionsByTask.set(taskKey, session.id)
        return session
      }
    }
    return undefined
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
      // 框架里的元素：先进入对应的同源 iframe，坐标再加上框架自己的矩形。
      const frameIndex = ${JSON.stringify(target.frame ?? null)}
      let scope = document
      let dx = 0
      let dy = 0
      if (frameIndex !== null) {
        const frame = document.querySelectorAll('iframe')[frameIndex]
        if (!frame) return { stale: 'frame missing' }
        let inner = null
        try { inner = frame.contentDocument } catch { inner = null }
        if (inner === null) return { stale: 'frame is cross-origin' }
        scope = inner
        const fr = frame.getBoundingClientRect()
        dx = fr.left
        dy = fr.top
      }
      let el
      try { el = scope.querySelector(${JSON.stringify(target.path)}) } catch { return { stale: 'selector invalid' } }
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
        x: Math.round(rect.x + rect.width / 2 + dx),
        y: Math.round(rect.y + rect.height / 2 + dy),
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
  /**
   * Fire-and-forget host call: these run while the provider keeps going, so a rejection
   * must never escape. Electron's host answers `unknown view` for a handle it no longer
   * knows (a host restart leaves the provider holding stale ones), and an unhandled
   * rejection surfaces as *some other* tool call failing - Ctrl+W did exactly that.
   * The desired end state (view gone) holds either way, so swallowing is right here.
   */
  private ignoreHostFailure(promise: unknown): void {
    void Promise.resolve(promise).catch(() => undefined)
  }
  private showActive(s: Session): void {
    // 让陈旧的一次显示安静地失败：紧接着的操作/切换会把它纠正回来，而一条没人接的
    // rejection 会以「别的工具调用失败了」的形式冒出来（实测 Ctrl+W 关最后一个标签就是这样）。
    void Promise.resolve(this.host.showView?.(this.activeTab(s).handle)).catch(() => undefined)
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
      // A stable code lets callers branch on a timeout; the name is preserved for
      // the one call site that already matched on it.
      const error = new BrowserError(message, 'BROWSER_OPERATION_TIMEOUT')
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
  // Prefer the host's own injection: only it holds the per-view binding token, so
  // its copy can still authenticate actions the human triggers. The tokenless
  // script below is a fallback for hosts that do not own the chrome.
  if (typeof handle.reinstallChrome === 'function') {
    try {
      await handle.reinstallChrome()
      return
    } catch {
      // Fall through rather than leaving the document without any chrome.
    }
  }
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
 * The in-page half of {@link resolvePointerTarget}: resolve the element, scroll
 * it into view, and return its centre.
 *
 * Exported so it can be exercised. The matching rule — the innermost visible
 * element whose label contains the text wins — is the part most likely to be
 * wrong, and Node has no DOM to check it against.
 */
export function pointerTargetScript(selector: string | undefined, text: string | undefined): string {
  return `(() => {
    const selector = ${JSON.stringify(selector ?? null)}
    const needle = ${JSON.stringify(text ?? null)}
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return r.width >= 4 && r.height >= 4 && cs.visibility !== 'hidden' && cs.display !== 'none'
    }
    const usable = (el) => !el.closest('[data-dsh-browser-chrome]') && visible(el)
    const labelOf = (el) => (el.getAttribute('aria-label') || el.textContent || el.value || '').toString().replace(/\\s+/g, ' ').trim()
    const describe = (el) => labelOf(el).slice(0, 80)
    let el = null
    if (selector !== null) {
      let matches
      try { matches = [...document.querySelectorAll(selector)] } catch (e) { return { error: 'invalid selector: ' + String(e) } }
      el = matches.find(usable) ?? null
    } else {
      const lower = needle.toLowerCase()
      // One bottom-up pass gives every element its own text. Matching a list of
      // tag names is not enough: plenty of text lives in tags nobody thinks to
      // list (p, h1, dd, figcaption, legend, option...), and a site that splits a
      // label into one span per character leaves every leaf holding a single
      // character while its container holds the whole phrase. Reading
      // textContent per element instead would re-walk each subtree.
      const texts = new Map()
      const walk = (node) => {
        let text = ''
        for (const child of node.childNodes) {
          if (child.nodeType === 3) text += child.nodeValue ?? ''
          else if (child.nodeType === 1) text += walk(child)
        }
        if (node.nodeType === 1) texts.set(node, text)
        return text
      }
      if (document.body !== null) walk(document.body)
      let best = null
      for (const [candidate, own] of texts) {
        // Cheapest rejection first: a big page has far more elements than matches.
        const label = (candidate.getAttribute('aria-label') || own || candidate.value || '').replace(/\\s+/g, ' ').trim()
        if (label === '' || !label.toLowerCase().includes(lower)) continue
        if (!usable(candidate)) continue
        let depth = 0
        for (let node = candidate; node !== null; node = node.parentElement) depth += 1
        // The shortest label is the innermost element still containing the text;
        // on a tie the deeper one wins, so a <button> beats its wrapper.
        if (best === null || label.length < best.label.length || (label.length === best.label.length && depth > best.depth)) {
          best = { el: candidate, label, depth }
        }
      }
      el = best?.el ?? null
    }
    if (el === null) return { missing: true }
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' })
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return { missing: true }
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, target: describe(el) }
  })()`
}
/**
 * Resolve a pointer target to a viewport point.
 *
 * Coordinates pass straight through. A selector or text is resolved inside the
 * page and scrolled into view first, and the element is described in the result
 * so the caller can confirm what it actually hit — a bare coordinate click
 * cannot tell you that.
 */
async function resolvePointerTarget(
  handle: ElectronViewHandle,
  target: BrowserPointerTarget,
  signal?: AbortSignal,
): Promise<BrowserPointerResult> {
  if (target.selector === undefined && target.text === undefined) {
    if (typeof target.x !== 'number' || typeof target.y !== 'number') {
      throw new BrowserError('browser: a pointer action needs x and y, a selector, or text', 'BROWSER_TARGET_MISSING')
    }
    // Coordinates are NOT scrolled into view (only selector/text are), so a point
    // below the fold is dropped by the renderer and the call looks like it worked.
    // Measured on a real page: the same centre that hits at 100% is off-screen at
    // 110% because the page reflows taller. Refuse, and say what is actually there.
    const view = await withTimeout(
      handleSendEvaluate(handle, `(function () {
        var x = ${JSON.stringify(target.x)}, y = ${JSON.stringify(target.y)};
        var el = document.elementFromPoint(x, y);
        return { iw: window.innerWidth, ih: window.innerHeight,
          hit: el === null ? '' : (el.tagName + (el.id ? '#' + el.id : '') + (el.textContent ? ' ' + el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40) : '')) };
      })()`, signal),
      5_000,
      signal,
      'browser: coordinate probe timed out after 5000ms',
    )
    const info = view.ok ? view.value as { iw?: number; ih?: number; hit?: string } | null : null
    // A 0x0 viewport means "not laid out yet" (hidden view), not "the point is off
    // screen": clicks still land there (the smoke's input checks prove it), so only a
    // real, non-zero viewport may refuse.
    if (info !== null && typeof info?.iw === 'number' && typeof info?.ih === 'number' && info.iw > 0 && info.ih > 0) {
      if (target.x >= info.iw || target.y >= info.ih || target.x < 0 || target.y < 0) {
        throw new BrowserError(
          `browser: (${target.x}, ${target.y}) is outside the visible viewport (${info.iw}x${info.ih}) - a coordinate click does not scroll, so nothing would be clicked; scroll it into view first, or address the element with a selector/text (those scroll automatically)`,
          'BROWSER_TARGET_OFFSCREEN',
        )
      }
    }
    return {
      x: target.x,
      y: target.y,
      ...info?.hit !== undefined && info.hit !== '' ? { target: info.hit } : {},
    }
  }
  const script = pointerTargetScript(target.selector, target.text)
  const result = await withTimeout(
    handleSendEvaluate(handle, script, signal),
    10_000,
    signal,
    'browser: target resolution timed out after 10000ms',
  )
  if (!result.ok) {
    throw new BrowserError(`browser: could not resolve the target: ${result.exception}`, 'BROWSER_TARGET_FAILED')
  }
  const value = result.value as { x?: number; y?: number; target?: string; missing?: boolean; error?: string } | null
  if (value?.error !== undefined) {
    throw new BrowserError(`browser: ${value.error}`, 'BROWSER_TARGET_FAILED')
  }
  if (value?.missing === true || typeof value?.x !== 'number' || typeof value?.y !== 'number') {
    const what = target.selector !== undefined ? `selector "${target.selector}"` : `text "${target.text ?? ''}"`
    throw new BrowserError(`browser: no visible element matches ${what}`, 'BROWSER_TARGET_NOT_FOUND')
  }
  return { x: value.x, y: value.y, ...value.target === undefined ? {} : { target: value.target } }
}

/**
 * Wait until the main document reports complete, without turning an otherwise
 * successful navigation into a failure when a page is slow or never settles.
 */
async function waitForDocumentReady(
  handle: ElectronViewHandle,
  signal?: AbortSignal,
  settleMs = 250,
): Promise<void> {
  const deadline = Date.now() + 12_000
  try {
    await withTimeout((async () => {
      while (Date.now() <= deadline) {
        const result = await handleSendEvaluate(handle, 'document.readyState', signal).catch(() => undefined)
        if (result?.ok && result.value === 'complete') {
          // The settle delay exists so a screenshot or snapshot does not catch a
          // still-blank renderer. A scrape reads the DOM, not pixels, so it
          // passes 0 — otherwise a thousand-page batch would idle 250s.
          if (settleMs > 0) await new Promise(resolve => setTimeout(resolve, settleMs))
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

/**
 * Minimal DOM shape {@link renderMarkdown} reads; a real DOM node fits it.
 */
export interface MarkdownNode {
  readonly nodeType?: number
  readonly tagName?: string | null
  readonly textContent?: string | null
  readonly childNodes?: ArrayLike<MarkdownNode> | null
  readonly href?: string | null
  readonly src?: string | null
  readonly alt?: string | null
}

/**
 * Best-effort markdown rendering of a DOM subtree, used by
 * {@link ElectronBrowserProvider.content} for `format: 'markdown'`.
 *
 * Deliberately self-contained (no closures over module state, no imports):
 * the provider embeds this function's source in the page with
 * `Function.prototype.toString`, so the tests exercise the very code the page
 * runs.
 *
 * Block containers (div/p/section/article/li/headings/...) recurse into their
 * children and are joined with newlines, while adjacent inline runs are
 * concatenated — text split by <b>/<span> stays one paragraph, and a container
 * never emits its own `textContent` on top of its children (the old walker did,
 * which flattened real pages — everything is wrapped in divs — to plain text).
 * @param root - the subtree root (an element, or a text node).
 * @returns the markdown text.
 */
export function renderMarkdown(root: MarkdownNode): string {
  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'dialog',
    'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li',
    'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table',
    'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
  ])
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template'])
  const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()
  const childrenOf = (node: MarkdownNode): MarkdownNode[] => {
    const list = node.childNodes
    if (list === undefined || list === null) return []
    const out: MarkdownNode[] = []
    for (let index = 0; index < list.length; index++) out.push(list[index])
    return out
  }
  /** Inline rendering: concatenates descendants, keeping links/images inline. */
  const inline = (node: MarkdownNode): string => {
    // Whitespace is collapsed but NOT trimmed: trimming here would eat the space
    // that separates two inline runs ('Hello ' + <b>world</b>).
    if (node.nodeType === 3) return (node.textContent ?? '').replace(/\s+/g, ' ')
    if (node.nodeType !== 1) return ''
    const tag = (node.tagName ?? '').toLowerCase()
    if (SKIP_TAGS.has(tag)) return ''
    if (tag === 'br') return '\n'
    if (tag === 'img') return node.src ? '![' + collapse(node.alt ?? '') + '](' + node.src + ')' : ''
    if (tag === 'a') {
      const text = collapse(inlineChildren(node))
      return text === '' ? '' : '[' + text + '](' + (node.href ?? '') + ')'
    }
    return inlineChildren(node)
  }
  const inlineChildren = (node: MarkdownNode): string => childrenOf(node).map(inline).join('')
  /** Render one child as a block piece (own line) or an inline piece (merged). */
  const renderBlock = (node: MarkdownNode): { text: string; block: boolean } => {
    if (node.nodeType === 3) return { text: inline(node), block: false }
    if (node.nodeType !== 1) return { text: '', block: false }
    const tag = (node.tagName ?? '').toLowerCase()
    if (SKIP_TAGS.has(tag)) return { text: '', block: false }
    if (tag === 'br') return { text: '\n', block: false }
    if (tag === 'hr') return { text: '---', block: true }
    const heading = /^h([1-6])$/.exec(tag)
    if (heading !== null) {
      const text = collapse(inline(node))
      return { text: text === '' ? '' : '#'.repeat(Number(heading[1])) + ' ' + text, block: true }
    }
    if (tag === 'li') {
      const text = collapse(inline(node))
      return { text: text === '' ? '' : '- ' + text, block: true }
    }
    if (BLOCK_TAGS.has(tag)) return { text: renderChildren(node), block: true }
    return { text: inline(node), block: false }
  }
  /** Join a node's children: inline neighbours merge, block boundaries newline. */
  const renderChildren = (node: MarkdownNode): string => {
    const out: Array<{ text: string; block: boolean }> = []
    for (const child of childrenOf(node)) {
      const piece = renderBlock(child)
      if (collapse(piece.text) === '') continue
      const previous = out[out.length - 1]
      if (previous !== undefined && !previous.block && !piece.block) previous.text += piece.text
      else out.push({ text: piece.text, block: piece.block })
    }
    // Inline runs are trimmed once, after merging, so their inner spacing stays.
    return out.map(piece => piece.block ? piece.text : collapse(piece.text)).join('\n')
  }
  if (root.nodeType === 3) return collapse(root.textContent ?? '')
  return renderChildren(root).replace(/\n{3,}/g, '\n\n').trim()
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

