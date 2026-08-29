/**
 * Vocabulary for the browser capability seam (`ctx.browser`). One seam owns
 * provider registration, session lifecycle, cancellation, errors, and product
 * configuration; providers differ only in what backs a session (an Electron
 * `WebContentsView` in the desktop shell, a headless Chromium relay for
 * remote deployments, and so on).
 * @module dsh-browser-plus/browser/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/**
 * Stable identity of one browser session, resolved by the Host through a
 * Typert `LookupMap` to the live session object (the same mechanism
 * `Agent → agentId` uses). The id is opaque to the wire; only the provider
 * and its host binding can interpret it.
 */
export type BrowserSessionId = string

/**
 * What one browser-capable backend is asked to do. Navigation is the minimal
 * operation every provider shares; the seam deliberately keeps the request
 * minimal so a provider swap never changes how the model asks.
 */
export interface BrowserNavigateRequest {
  /** The URL to open. Admission (HTTP(S) only, no credentials/private targets) is provider-owned. */
  readonly url: string
}

/**
 * Click at viewport coordinates. Coordinates are viewport-relative pixels in
 * the session's own coordinate space — the same space the human interacts
 * with, so a real view and a relay agree without scaling.
 */
export interface BrowserClickRequest {
  /** Viewport-relative x in CSS pixels. */
  readonly x: number
  /** Viewport-relative y in CSS pixels. */
  readonly y: number
}

/** Type text into the focused element. */
export interface BrowserTypeRequest {
  /** The text to insert. */
  readonly text: string
}

/** Key press into the page, as one keyDown+keyUp pair. */
export interface BrowserPressKeyRequest {
  /** The key to press: a single character ('a', '1'), an Enter/Tab/Escape,
   * navigation key (ArrowUp/ArrowDown/…), Home/End/PageUp/PageDown,
   * Backspace/Delete, or F1..F12. */
  readonly key: string
  /** Modifier keys held during the press. */
  readonly modifiers?: readonly ('alt' | 'ctrl' | 'meta' | 'shift')[]
}

/** Double-click at viewport coordinates (one press/release pair, clickCount 2). */
export interface BrowserDoubleClickRequest {
  /** Viewport-relative x in CSS pixels. */
  readonly x: number
  /** Viewport-relative y in CSS pixels. */
  readonly y: number
}

/** Move the pointer to viewport coordinates (no button). */
export interface BrowserHoverRequest {
  /** Viewport-relative x in CSS pixels. */
  readonly x: number
  /** Viewport-relative y in CSS pixels. */
  readonly y: number
}

/** Scroll the active page by a CSS-pixel delta. */
export interface BrowserScrollRequest {
  /** Horizontal delta in CSS pixels. Default 0. */
  readonly deltaX?: number
  /** Vertical delta in CSS pixels. Default one viewport height downward. */
  readonly deltaY?: number
}

/** Final page scroll position after a scroll operation. */
export interface BrowserScrollResult {
  /** Horizontal scroll offset in CSS pixels. */
  readonly x: number
  /** Vertical scroll offset in CSS pixels. */
  readonly y: number
  /** Maximum horizontal scroll offset in CSS pixels. */
  readonly maxX: number
  /** Maximum vertical scroll offset in CSS pixels. */
  readonly maxY: number
}

/** One element reference from a specific browser snapshot. */
export interface BrowserRefRequest {
  /** Opaque id returned by browser_open or browser_snapshot. */
  readonly snapshotId: string
  /** Element reference number from that snapshot. */
  readonly ref: number
}

/** Scroll one referenced element into the visible viewport. */
export interface BrowserScrollIntoViewRequest extends BrowserRefRequest {
  /** Vertical alignment for the referenced element. Default center. */
  readonly block?: 'start' | 'center' | 'end' | 'nearest'
}

/** Set a file input's value from a local path. */
export interface BrowserUploadFileRequest {
  /** Absolute path of the file to attach. */
  readonly filePath: string
  /** CSS selector of the file input; defaults to the first input[type="file"]. */
  readonly selector?: string
}

/** Outcome of a file upload. */
export interface BrowserUploadFileResult {
  /** The path uploaded. */
  readonly path: string
}

/** Wait for an element matching a CSS selector to appear (optionally visible). */
export interface BrowserWaitForRequest {
  /** CSS selector to wait for. */
  readonly selector: string
  /** Total budget in ms. Default 15000. */
  readonly timeoutMs?: number
  /** Wait for the element to be visible (at least 4x4 px and not visibility:hidden or display:none). Default true. */
  readonly visible?: boolean
}

/** Outcome of a successful wait. */
export interface BrowserWaitForResult {
  readonly found: true
  readonly selector: string
  /** Matching element's tag name. */
  readonly tag: string
  /** Matching element's visible text (first 200 chars). */
  readonly text: string
}

/** One field of a batch form fill. Match by selector, or by name/label/placeholder. */
export interface BrowserFillField {
  /** CSS selector; when present, candidates are scoped to it. */
  readonly selector?: string
  /** Match by the field's `name` attribute. */
  readonly name?: string
  /** Match by associated `<label>` text or `aria-label`. */
  readonly label?: string
  /** Match by `placeholder` text. */
  readonly placeholder?: string
  /** Field kind; defaults to text. */
  readonly kind?: 'text' | 'textarea' | 'checkbox' | 'radio' | 'select'
  /** Value to set: string, number, or boolean (checkbox/radio). For a
   *  multi-select or radio group, the option value (or visible text). */
  readonly value: string | number | boolean
}

/** Batch form fill: set several fields, optionally submitting the form. */
export interface BrowserFillRequest {
  /** The fields to fill, in order. */
  readonly fields: readonly BrowserFillField[]
  /** Submit the containing form after filling. Default false. */
  readonly submit?: boolean
  /** Total evaluation budget for the whole batch in ms. Default 30000. */
  readonly timeoutMs?: number
}

/** One field's outcome in a batch fill. */
export interface BrowserFillFieldResult {
  readonly ok: boolean
  /** The field description matched (selector/name/label/placeholder). */
  readonly target: string
  /** How the value was applied: input | textarea | select | checkbox | radio | contenteditable. */
  readonly method?: string
  /** Error text when the field could not be filled. */
  readonly error?: string
}

/** Outcome of a batch form fill. */
export interface BrowserFillResult {
  /** Per-field outcomes, in request order. */
  readonly fields: readonly BrowserFillFieldResult[]
  /** Whether the containing form was submitted. */
  readonly submitted: boolean
}

/**
 * A screenshot of the current page state. `dataUrl` is a base64 data URL the
 * tool layer renders directly; the live view itself never crosses the wire
 * (the human watches the real view in the desktop shape).
 */
export interface BrowserScreenshotResult {
  /** Base64 PNG data URL of the capture. */
  readonly dataUrl: string
  /** File path the capture was also saved to, when the request asked for it. */
  readonly path?: string
}

/** Screenshot capture options. PNG only (CDP JPEG hangs on Electron 43). */
export interface BrowserScreenshotRequest {
  /** Capture the full scrollable page instead of the viewport. Default false. */
  readonly fullPage?: boolean
  /** Absolute file path to also save the PNG to (for vision-tool reads). */
  readonly savePath?: string
}

/** Download options: fetch a URL into a local file, keeping the session's cookies. */
export interface BrowserDownloadRequest {
  /** The URL to download. */
  readonly url: string
  /** Absolute path of the file to write. */
  readonly savePath: string
}

/** A serializable cookie, exported from or imported into the browser session. */
export interface ExportedCookie {
  /** Cookie URL (scheme + domain + path), as accepted by cookies.set. */
  readonly url: string
  readonly name: string
  readonly value: string
  readonly domain?: string
  readonly path?: string
  readonly secure?: boolean
  readonly httpOnly?: boolean
  readonly expirationDate?: number
}

/**
 * Execute arbitrary JavaScript in the session's page context. This is the
 * primary interaction path — DOM-referenced, not screen-coordinate-based:
 * focus/input/click go through the page's own JS (native setters for
 * framework-controlled inputs), matching how a human-driven agent operates.
 */
export interface BrowserExecuteRequest {
  /** The JavaScript expression to evaluate in the page context. */
  readonly script: string
  /** Optional arguments injected into the script scope as `arguments[0..n]`. */
  readonly args?: readonly unknown[]
  /** Evaluation budget in ms; a wedged page rejects with a timeout. Default 30000. */
  readonly timeoutMs?: number
}

/**
 * Result of an execute. Mirrors CDP `Runtime.evaluate` semantics: either a
 * value (by value, not by reference) or the exception thrown.
 */
export type BrowserExecuteResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly exception: string }

/**
 * One interactive element in a snapshot, with a stable reference number the
 * tool layer (and the model) can cite to target the element.
 */
export interface BrowserSnapshotElement {
  /** 1-based reference number, stable for the lifetime of one snapshot. */
  readonly ref: number
  /** Element kind: 'input' | 'button' | 'link' | 'textarea' | 'select' | 'checkbox' | 'other'. */
  readonly kind: string
  /** Text content or placeholder/label, truncated for the snapshot. */
  readonly label: string
  /** Best-effort CSS selector; may be empty when none is derivable. */
  readonly selector: string
  /** Best-effort locator for re-targeting (id/name/aria-label/text). */
  readonly loc: string
  /** Viewport-relative center, for coordinate fallbacks. */
  readonly x: number
  readonly y: number
}

/**
 * AI-friendly page snapshot: a compact, numbered inventory of interactive
 * elements plus page facts. Not raw HTML — the model dialogues with this.
 */
export interface BrowserSnapshotResult {
  /** Opaque id that binds the element references to this exact page snapshot. */
  readonly snapshotId: string
  /** Final page URL. */
  readonly url: string
  /** Page title, if any. */
  readonly title?: string
  /** Numbered interactive elements. */
  readonly elements: readonly BrowserSnapshotElement[]
  /** True when the snapshot was truncated (element cap reached). */
  readonly truncated: boolean
  /** Human-verification challenge blocking the page, when one is detected. */
  readonly challenge?: BrowserChallenge
  /** True when a human interacted with the page within the last minute. */
  readonly userControlling?: boolean
}

/**
 * A detected human-verification (bot-detection / CAPTCHA) challenge blocking
 * the page. Detection is best-effort and marker-based; a clean result is not a
 * guarantee that no challenge exists.
 */
export interface BrowserChallenge {
  /** Whether a challenge currently blocks the page. */
  readonly blocked: boolean
  /** Machine-readable kind: cloudflare | hcaptcha | recaptcha | turnstile | generic. */
  readonly kind?: string
  /** Short human-readable description, e.g. 'Cloudflare "Just a moment" interstitial'. */
  readonly reason?: string
}

/**
 * Content fetch formats. `html` is the raw DOM; `markdown` is a structured
 * reading view; `txt` is plain text (smallest); `json` is structured data.
 */
export type BrowserContentFormat = 'html' | 'markdown' | 'txt' | 'json'

/** Content fetch request: format, optional selector scoping, and caps. */
export interface BrowserContentRequest {
  /** Desired format. */
  readonly format: BrowserContentFormat
  /** Optional CSS selector limiting the fetch to one region (e.g. `#main`). */
  readonly selector?: string
  /** Maximum characters of the returned content. */
  readonly maxChars?: number
  /** Evaluation timeout in ms; the fetch aborts after this. Default 30000. */
  readonly timeoutMs?: number
}

/** A fetched page content in the requested format. */
export interface BrowserContentResult {
  /** The content in the requested format, capped at `maxChars`. */
  readonly content: string
  /** True when the content was truncated. */
  readonly truncated: boolean
}

/**
 * A tab inside a browser session. Tabs share the session's profile/cookies
 * and are switchable without losing state.
 */
export interface BrowserTab {
  /** Stable tab id within the session. */
  readonly id: string
  /** Current URL, or empty for a blank tab. */
  readonly url: string
  /** Page title, if any. */
  readonly title?: string
  /** Whether this tab is the active one. */
  readonly active: boolean
}

/** Request to open a URL: into the active tab or a new tab. */
export interface BrowserOpenRequest {
  /** The URL to open. */
  readonly url: string
  /** Open in a new tab (parallel). Default false (reuse the active tab). */
  readonly newTab?: boolean
}

/** Options for opening or recovering a browser task session. */
export interface BrowserOpenOptions {
  /** Stable browser-task key; keyed providers may recover the existing session for this task. */
  readonly key?: string
  /** Optional display name shown in the task manager and active window title. */
  readonly label?: string
}

/** One browser task represented in the shared visible window. */
export interface BrowserSpaceInfo {
  /** Stable browser-task key. */
  readonly key: string
  /** Task display label, or '' for unlabeled. */
  readonly label: string
}

/** Visible activity state for a browser task. */
export type BrowserTaskStatus = 'idle' | 'running' | 'waiting-user' | 'failed'

/** Which collaborator currently owns page-changing actions. */
export type BrowserControlOwner = 'agent' | 'human'

/** Intentional Agent-to-human handoff mode. */
export type BrowserHandoffState = 'waiting-user' | 'agent'

/** Compact task information shared by browser tools and the visible workspace. */
export interface BrowserTaskInfo extends BrowserSpaceInfo {
  /** Whether this task is currently visible in the shared browser window. */
  readonly active: boolean
  /** Number of tabs in the task's session. */
  readonly tabs: number
  /** Current visible activity state. */
  readonly status: BrowserTaskStatus
  /** Who currently owns page-changing actions. */
  readonly control: BrowserControlOwner
  /** Latest completed or in-progress operation, when known. */
  readonly latestAction?: string
  /** Epoch milliseconds of the last task-state change. */
  readonly updatedAt: number
  /** Short display-safe failure detail, when the task failed. */
  readonly error?: string
}

/** Partial task-state update produced by the tool and provider layers. */
export interface BrowserTaskUpdate {
  readonly status?: BrowserTaskStatus
  readonly control?: BrowserControlOwner
  readonly latestAction?: string
  readonly error?: string
}

/**
 * A browser-capable backend. Registered with `ctx.browser.registerBrowserProvider`.
 * `id` is a stable string, unique across the seam.
 */
export interface BrowserProvider {
  readonly id: string
  /** Cheap local usability check; must not make network calls. */
  available(): boolean
  /**
   * Open or recover a session. The provider mints the session id and prepares its
   * backing surface (a view, a headless page, and so on); keyed providers may return
   * the existing session for the same stable task key. Sessions are isolated from
   * each other; a session must not be visible to any other session's caller.
   */
  open(options?: BrowserOpenOptions): Promise<BrowserSessionId>
  /** Open a URL, optionally in a new tab. Honor `signal` for cancellation. */
  openUrl(session: BrowserSessionId, request: BrowserOpenRequest, signal?: AbortSignal): Promise<void>
  /** List the session's tabs. */
  listTabs(session: BrowserSessionId): Promise<readonly BrowserTab[]>
  /** Switch to a tab by id. Unknown id -> `BROWSER_TAB_UNKNOWN`. */
  switchTab(session: BrowserSessionId, tabId: string): Promise<void>
  /** Close one tab. Closing the active tab activates the next. */
  closeTab(session: BrowserSessionId, tabId: string): Promise<void>
  /** Close every tab and reset the session's state. */
  reset(session: BrowserSessionId): Promise<void>
  /** Navigate the active tab. Honor `signal` for cancellation. */
  navigate(session: BrowserSessionId, request: BrowserNavigateRequest, signal?: AbortSignal): Promise<void>
  /** Navigate to the previous history entry when one exists. */
  back(session: BrowserSessionId, signal?: AbortSignal): Promise<boolean>
  /** Navigate to the next history entry when one exists. */
  forward(session: BrowserSessionId, signal?: AbortSignal): Promise<boolean>
  /** Reload the active page. */
  reload(session: BrowserSessionId, signal?: AbortSignal): Promise<void>
  /** Stop loading the active page. */
  stopLoading(session: BrowserSessionId, signal?: AbortSignal): Promise<void>
  /** Execute JS in the active tab's page context. */
  execute(session: BrowserSessionId, request: BrowserExecuteRequest, signal?: AbortSignal): Promise<BrowserExecuteResult>
  /** Produce an AI-friendly snapshot of the active tab. */
  snapshot(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserSnapshotResult>
  /** Click one element referenced by an exact snapshot. */
  clickRef(session: BrowserSessionId, request: BrowserRefRequest, signal?: AbortSignal): Promise<void>
  /** Scroll one element referenced by an exact snapshot into view. */
  scrollIntoView(session: BrowserSessionId, request: BrowserScrollIntoViewRequest, signal?: AbortSignal): Promise<BrowserScrollResult>
  /** Check whether a human-verification challenge is blocking the active tab. */
  detectChallenge(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserChallenge>
  /** Fetch page content in a requested format. */
  content(session: BrowserSessionId, request: BrowserContentRequest, signal?: AbortSignal): Promise<BrowserContentResult>
  /** Click at viewport coordinates (fallback path; execute is preferred). Honor `signal` for cancellation. */
  click(session: BrowserSessionId, request: BrowserClickRequest, signal?: AbortSignal): Promise<void>
  /** Type into the focused element (fallback path). Honor `signal` for cancellation. */
  type(session: BrowserSessionId, request: BrowserTypeRequest, signal?: AbortSignal): Promise<void>
  /** Press a key (keyDown + keyUp) into the active tab. Honor `signal` for cancellation. */
  pressKey(session: BrowserSessionId, request: BrowserPressKeyRequest, signal?: AbortSignal): Promise<void>
  /** Double-click at viewport coordinates. Honor `signal` for cancellation. */
  doubleClick(session: BrowserSessionId, request: BrowserDoubleClickRequest, signal?: AbortSignal): Promise<void>
  /** Move the pointer to viewport coordinates (hover). Honor `signal` for cancellation. */
  hover(session: BrowserSessionId, request: BrowserHoverRequest, signal?: AbortSignal): Promise<void>
  /** Scroll the active page by CSS-pixel deltas. */
  scroll(session: BrowserSessionId, request: BrowserScrollRequest, signal?: AbortSignal): Promise<BrowserScrollResult>
  /** Attach a local file to a file input. Honor `signal` for cancellation. */
  uploadFile(session: BrowserSessionId, request: BrowserUploadFileRequest, signal?: AbortSignal): Promise<BrowserUploadFileResult>
  /** Wait until an element matching the selector exists (and optionally is visible). Honor `signal` for cancellation. */
  waitForElement(session: BrowserSessionId, request: BrowserWaitForRequest, signal?: AbortSignal): Promise<BrowserWaitForResult>
  /** Fill a form's fields in one batch. Honor `signal` for cancellation. */
  fillForm(session: BrowserSessionId, request: BrowserFillRequest, signal?: AbortSignal): Promise<BrowserFillResult>
  /** Capture the current page. Honor `signal` for cancellation. */
  screenshot(session: BrowserSessionId, request?: BrowserScreenshotRequest, signal?: AbortSignal): Promise<BrowserScreenshotResult>
  /** Download a URL to a local file. Honor `signal` for cancellation. */
  download(session: BrowserSessionId, request: BrowserDownloadRequest, signal?: AbortSignal): Promise<{ readonly path: string }>
  /** Export the session's cookies (login state). */
  flushAuth(session: BrowserSessionId): Promise<readonly ExportedCookie[]>
  /** Import cookies into the session (restore login state); returns the number of cookies restored. */
  restoreAuth(session: BrowserSessionId, cookies: readonly ExportedCookie[]): Promise<number>
  /** Return the session's chronological operation log. */
  history(session: BrowserSessionId): Promise<readonly BrowserHistoryEntry[]>
  /** Replay one recorded operation by sequence number. */
  replay(session: BrowserSessionId, seq: number): Promise<void>
  /** Set the browser task label for a session; selected task controls the shared title. */
  setSpace(session: BrowserSessionId, label: string): Promise<void>
  /** List browser tasks (legacy spaces) with their labels. */
  listSpaces(): Promise<readonly BrowserSpaceInfo[]>
  /** List browser tasks with live collaboration status. */
  listTasks(): Promise<readonly BrowserTaskInfo[]>
  /** Read the collaboration state of this session's task. */
  getTask(session: BrowserSessionId): Promise<BrowserTaskInfo>
  /** Apply a visible activity/control update to this session's task. */
  updateTask(session: BrowserSessionId, update: BrowserTaskUpdate): Promise<BrowserTaskInfo>
  /** Mark this task as waiting for the user or returned to Agent control. */
  setHandoff(session: BrowserSessionId, state: BrowserHandoffState): Promise<BrowserTaskInfo>
  /** Close the session and destroy its backing surface. Idempotent. */
  close(session: BrowserSessionId): Promise<void>
}

/** One recorded browser operation, in chronological order (seq 1, 2, 3…). */
export interface BrowserHistoryEntry {
  /** Monotonic sequence number within the session. */
  readonly seq: number
  /** The operation name. Replayable: navigate | execute | click | type |
   *  pressKey. Also recorded but not replayable: fill | download |
   *  flushAuth | restoreAuth | setSpace | doubleClick | hover | uploadFile |
   *  waitForElement. */
  readonly action: string
  /** The operation's arguments. */
  readonly params: Record<string, unknown>
  /** Whether the operation succeeded. */
  readonly ok: boolean
  /** Truncated result text, when the operation returned one. */
  readonly result?: string
  /** Error text, when the operation failed. */
  readonly error?: string
  /** Epoch millis of the operation. */
  readonly at: number
}

/**
 * Typed browser error with a machine-routable, open-string `code` and chained
 * `cause`. Consumers must tolerate provider-specific codes. Shared codes cover
 * unavailable, missing, unusable, ambiguous, or duplicate providers, unknown
 * or closed sessions, cancellation, and provider failure; a provider adds its
 * own (e.g. `BROWSER_CDP_ATTACH_FAILED`).
 */
export class BrowserError extends HarnessError {}

