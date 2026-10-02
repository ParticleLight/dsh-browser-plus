/**
 * Self-hosted Electron browser host (child side): the Electron main process
 * spawned by {@link RemoteElectronViewHost}. Owns one shared `BrowserWindow`
 * containing task-scoped `WebContentsView`s and their `webContents.debugger`
 * (CDP), and answers
 * line-delimited JSON-RPC on stdio.
 *
 * Protocol (one JSON object per line, both directions):
 *   <- { id, op: 'ping' } | { id, op: 'createView', viewId, key?, label? } |
 *      { id, op: 'destroyView', viewId } | { id, op: 'showView', viewId } |
 *      { id, op: 'label', viewId, label } | { id, op: 'listWindows' } |
 *      { id, op: 'command', viewId, method, params }
 *   -> { id, ok: true, result? } | { id, ok: false, err }
 *
 * The parent never parses stderr, so diagnostics may go there freely.
 * @module dsh-browser-plus/browser-electron/host-main
 */

import { app, BrowserWindow, session, WebContentsView } from 'electron'
import { createInterface } from 'node:readline'
import { createConnection } from 'node:net'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acceptLanguagesFor, chromeMajor, clientHintPlatform, secChUa, stripElectronToken } from './fingerprint.js'
import { buildPageChromeScript } from './page-chrome.js'
import { taskSummaryUrl } from './task-summary.js'
import { taskThumbnailDataUrl, type ThumbnailImage } from './task-thumbnail.js'
import { exportCookiesForAuth, selectCookiesForClear } from './auth-cookies.js'
import { resolveBrowserIconPath } from './icon.js'
import { createBootstrap, createPatch, type ChromeBookmark, type ChromePatchOperation, type ChromeTabSummary, type ChromeTaskSummary, type ChromeTrailEntry, type ChromeWorkspaceState } from './chrome-state.js'

// Isolate this host's profile from the DSH app's default Electron userData:
// several Electron instances sharing Roaming\Electron fight over the GPU
// cache/session locks, which can leave the window without a display surface
// (capturePage then fails). A dedicated userData also persists cookies across
// host restarts (on top of browser_auth). Must run before app is ready.
//
// DSH_BROWSER_PLUS_USER_DATA overrides it. Chromium takes a singleton lock on a
// profile, so a second host cannot start while one is already running on the
// same directory — a verification run needs its own profile, and so does anyone
// who wants two independent browsers side by side.
try {
  const override = process.env.DSH_BROWSER_PLUS_USER_DATA
  const base = process.env.DSH_HOME ?? app.getPath('appData')
  app.setPath('userData', override !== undefined && override.trim() !== ''
    ? override
    : join(base, 'dsh-browser-plus-host'))
} catch (error) {
  process.stderr.write(`[dsh-browser-plus host] userData setup failed: ${String(error)}\n`)
}

/** CDP protocol version attached to every view's debugger. */
const CDP_VERSION = '1.3'

/**
 * Download cap. The body is fetched inside the page, shipped as one base64 JSON
 * line and decoded again here, so one download peaks at several times its size
 * in memory; 64 MiB keeps that bounded while covering ordinary files.
 */
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024

/** Bound the in-page fetch independently of the parent's RPC transfer budget. */
const DOWNLOAD_FETCH_TIMEOUT_MS = 60_000

/** capturePage can hang on a wedged compositor; bound it like every other call. */
const THUMBNAIL_CAPTURE_TIMEOUT_MS = 5_000

/**
 * Height of the injected tab strip, in CSS pixels.
 *
 * The window is frameless (see makeWindow), so this is also the height of the
 * caption-button overlay and the room the chrome must leave free at the end of
 * the strip. Keep it in step with `#tabstrip { height:40px }` in page-chrome.ts.
 */
const TABSTRIP_HEIGHT = 40

/**
 * Whether this platform can draw the caption buttons over the content area.
 *
 * Windows and macOS both support `titleBarOverlay`; Linux does not, so it keeps
 * its native frame rather than ending up with a window that cannot be closed.
 */
const USES_OVERLAY_FRAME = process.platform === 'win32' || process.platform === 'darwin'

/** One task-scoped page view in the shared browser window. */
interface HostView {
  readonly webContentsView: WebContentsView
  readonly taskKey: string
}

/** Views by the id the parent assigned at createView time. */
const views = new Map<string, HostView>()

/**
 * Per-view secret authenticating page-emitted chrome control messages.
 * `Runtime.addBinding` exposes the callback to every page script, so a payload
 * is trusted only when it echoes the token that `buildPageChromeScript`
 * captured in the injected chrome's closure.
 */
const chromeTokens = new WeakMap<WebContentsView, string>()

/**
 * Which world the injected chrome lives in. 'main' is the proven default; the
 * child is told to use an isolated world via --chrome-world.
 */
const CHROME_WORLD: 'main' | 'isolated' = (() => {
  const index = process.argv.indexOf('--chrome-world')
  return index >= 0 && process.argv[index + 1] === 'isolated' ? 'isolated' : 'main'
})()

/** Name of the isolated world that owns the chrome in isolated mode. */
const CHROME_WORLD_NAME = 'dshChrome'

/** Isolated-world execution context for a view's current document. */
const chromeContexts = new WeakMap<WebContentsView, number>()

/**
 * Resolve the view's chrome context, creating the isolated world on demand. The
 * context belongs to one document, so navigation drops it (see installPageChrome).
 */
async function ensureChromeContext(view: WebContentsView): Promise<number | undefined> {
  const cached = chromeContexts.get(view)
  if (cached !== undefined) return cached
  const tree = await view.webContents.debugger.sendCommand('Page.getFrameTree')
  const frameId = (tree as { frameTree?: { frame?: { id?: string } } }).frameTree?.frame?.id
  if (frameId === undefined) return undefined
  const world = await view.webContents.debugger.sendCommand('Page.createIsolatedWorld', { frameId, worldName: CHROME_WORLD_NAME })
  const contextId = (world as { executionContextId?: number }).executionContextId
  if (typeof contextId !== 'number') return undefined
  chromeContexts.set(view, contextId)
  // Scoped to this world, so page script never holds a callable it could forge
  // task actions through.
  await view.webContents.debugger.sendCommand('Runtime.addBinding', { name: '__dshBrowserTaskAction', executionContextName: CHROME_WORLD_NAME }).catch(() => undefined)
  return contextId
}

/**
 * Run one chrome snippet in whichever world the chrome lives in. In isolated
 * mode nothing the chrome stores — task labels, the trail, the binding token —
 * is reachable from the page's own JavaScript context.
 */
function runChromeScript(view: WebContentsView, snippet: string): void {
  if (CHROME_WORLD === 'main') {
    // CDP evaluate, not webContents.executeJavaScript.
    //
    // Electron defers executeJavaScript until the page has finished LOADING,
    // not merely committed. The chrome is injected from did-navigate (the
    // commit), so with the native call the toolbar and tab strip were missing
    // for the whole of every load — measured against a page whose body took 6s:
    // a screenshot taken 2.5s in showed the page and no chrome at all. A CDP
    // evaluate runs as soon as the committed context exists, so the frame stays
    // on screen (and can show its loading state) while the page streams.
    //
    // The native call stays as the fallback for the one case CDP is worse at: a
    // context that is not ready yet, where an evaluate can hang rather than fail.
    void (async () => {
      try {
        await view.webContents.debugger.sendCommand('Runtime.evaluate', { expression: snippet, returnByValue: true })
      } catch {
        try { void view.webContents.executeJavaScript(snippet).catch(() => undefined) } catch { /* closing */ }
      }
    })()
    return
  }
  void (async () => {
    try {
      const contextId = await ensureChromeContext(view)
      if (contextId === undefined) return
      await view.webContents.debugger.sendCommand('Runtime.evaluate', { expression: snippet, contextId, returnByValue: true })
    } catch { /* chrome is cosmetic */ }
  })()
}

/**
 * Favicons by view id, already re-encoded as data: URLs.
 *
 * A favicon is read once per navigation: Chromium reports the page's own icon
 * URLs, this host fetches the first acceptable one through the view's session
 * (so cookies and any proxy configuration apply, exactly as the page's own
 * request would), and the bytes are capped before they ever reach the chrome.
 * A tab that navigates loses its icon until the new document reports one, which
 * is what Chrome does too.
 */
const viewFavicons = new Map<string, string>()

/**
 * Views whose document is still loading.
 *
 * Chromium reports this per view; the strip shows it as a spinner where the
 * favicon goes and as reload-into-stop in the toolbar, exactly like Chrome.
 */
const loadingViews = new Set<string>()

/**
 * Saved pages, for the whole profile.
 *
 * These used to live in the page's localStorage, which is per ORIGIN: a bookmark
 * saved on one site never appeared on another. The host owns them now and pushes
 * them to every chrome (bootstrap and bookmarks.set), persisting to the profile
 * directory so they survive a restart.
 */
let chromeBookmarks: ChromeBookmark[] = []

/** Where the bookmark list lives. Set once the profile directory is known. */
let bookmarksFile: string | undefined

function loadBookmarksFromDisk(): void {
  try {
    bookmarksFile = join(app.getPath('userData'), 'bookmarks.json')
    const raw = readFileSync(bookmarksFile, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return
    chromeBookmarks = parsed
      .filter((item): item is { url: string; title?: unknown } =>
        typeof item === 'object' && item !== null && typeof (item as { url?: unknown }).url === 'string')
      .map(item => ({ url: item.url, title: typeof item.title === 'string' ? item.title : item.url }))
      .slice(0, 500)
  } catch { /* first run, or an unreadable file */ }
}

function saveBookmarksToDisk(): void {
  if (bookmarksFile === undefined) return
  try { writeFileSync(bookmarksFile, JSON.stringify(chromeBookmarks, null, 2), 'utf8') } catch { /* read-only profile */ }
}

/**
 * Chrome's bookmark bar. Off by default, like a fresh Chrome profile.
 *
 * It lives here rather than in the page because every other kind of chrome state
 * has to survive navigation, and localStorage is per origin — a toggle kept there
 * would silently reset the moment the user visited another site.
 */
let chromeBookmarkBar = false

let chromePrefsFile: string | undefined

function loadPrefsFromDisk(): void {
  try {
    chromePrefsFile = join(app.getPath('userData'), 'chrome-prefs.json')
    const parsed: unknown = JSON.parse(readFileSync(chromePrefsFile, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return
    chromeBookmarkBar = (parsed as { bookmarkBar?: unknown }).bookmarkBar === true
  } catch { /* first run, or an unreadable file */ }
}

function savePrefsToDisk(): void {
  if (chromePrefsFile === undefined) return
  try { writeFileSync(chromePrefsFile, JSON.stringify({ bookmarkBar: chromeBookmarkBar }, null, 2), 'utf8') } catch { /* read-only profile */ }
}

/** Only these raster types are admitted; anything else keeps the letter fallback. */
const FAVICON_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]

/** Cap on the fetched icon. Real favicons are 1-20 KB; 64 KB is already generous. */
const FAVICON_MAX_BYTES = 64 * 1024

/** A slow or hanging icon host must never delay the tab strip. */
const FAVICON_FETCH_TIMEOUT_MS = 4_000

/** Operation trail per view, newest last, bounded. */
const traces = new Map<string, unknown[]>()

/** Last active flag pushed to each view's chrome, so unchanged views skip the IPC. */
const chromeActiveApplied = new WeakMap<WebContentsView, boolean>()

/**
 * The empty state a fresh view shows before its first navigation. A
 * WebContentsView with no committed document paints white AND leaves CDP with
 * no frame to evaluate against, so an un-navigated window was both unpleasant
 * and unusable — every browser_* call timed out on it.
 */
const START_PAGE_HTML = [
  '<!doctype html><meta charset="utf-8"><title></title>',
  '<style>',
  'html,body{height:100%;margin:0}',
  'body{display:flex;align-items:center;justify-content:center;text-align:center;',
  'background:radial-gradient(120% 90% at 50% 0%,#182030 0%,#0e1218 62%,#0b0e13 100%);',
  'color:#8b97a9;font:13px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;',
  '-webkit-user-select:none;user-select:none}',
  '.mark{font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;',
  'letter-spacing:.32em;color:#3f4a5c;margin-bottom:14px}',
  '.sub{margin-top:6px;color:#5b6675;font-size:12px}',
  '</style>',
  '<div><div class="mark">DSH BROWSER</div>',
  '<div>等待打开页面</div>',
  '<div class="sub">在上方地址栏输入网址，或让 Agent 打开一个页面</div></div>',
].join('')

/** data: URL for that empty state; its opaque origin simply has no bookmarks. */
const START_PAGE_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(START_PAGE_HTML)

/**
 * Electron advertises itself in the User-Agent ("Electron/42.9.3"), which is one
 * of the loudest automation signals a page or server can read. It also sends no
 * client hints at all even though its own navigator.userAgentData reports
 * Chromium, so a request claiming Chrome arrived with none of the sec-ch-ua
 * headers Chrome always sends. Both are aligned with what the engine really is.
 */
/** `--no-mask-automation` leaves the engine's own fingerprint alone. */
const MASK_AUTOMATION = !process.argv.includes('--no-mask-automation')

/** `--user-agent <ua>` replaces the derived one verbatim. */
const USER_AGENT_OVERRIDE = (() => {
  const index = process.argv.indexOf('--user-agent')
  return index >= 0 ? process.argv[index + 1] : undefined
})()

/** Align the UA, the client-hint headers and Accept-Language with each other. */
function installRequestFingerprint(): void {
  const browserSession = session.defaultSession
  if (!MASK_AUTOMATION) {
    if (USER_AGENT_OVERRIDE !== undefined) {
      app.userAgentFallback = USER_AGENT_OVERRIDE
      browserSession.setUserAgent(USER_AGENT_OVERRIDE)
    }
    return
  }
  const clean = stripElectronToken(USER_AGENT_OVERRIDE ?? app.userAgentFallback)
  // session.setUserAgent alone did not reach the views: a WebContentsView takes
  // its UA from the app-wide fallback, so that is what has to change.
  app.userAgentFallback = clean
  browserSession.setUserAgent(clean, acceptLanguagesFor(app.getLocale() || 'en-US'))

  const major = chromeMajor(clean)
  const hints: Record<string, string> = {
    // Mirrors the brands this engine reports through navigator.userAgentData, so
    // the header and the JS API tell the same story.
    ...(major === undefined ? {} : { 'sec-ch-ua': secChUa([{ brand: 'Chromium', version: major }, { brand: 'Not/A)Brand', version: '99' }]) }),
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': clientHintPlatform(),
  }
  browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers: Record<string, string> = { ...details.requestHeaders }
    const existing = new Set(Object.keys(headers).map(key => key.toLowerCase()))
    for (const [key, value] of Object.entries(hints)) {
      // Never fight Chromium for a header it already decided to send.
      if (!existing.has(key)) headers[key] = value
    }
    callback({ requestHeaders: headers })
  })
}

/** Latest unread JS dialog per view (auto-accepted; read by drainDialog). */
const dialogLogs = new Map<string, unknown>()

/** Display label and current tab for each isolated browser task. */
const taskLabels = new Map<string, string>()
const activeViewByTask = new Map<string, string>()
const taskViewIds = new Map<string, Set<string>>()
const taskThumbnails = new Map<string, string>()
const taskThumbnailVersions = new Map<string, number>()
const taskStates = new Map<string, HostTaskState>()
const thumbnailTimers = new Map<string, ReturnType<typeof setTimeout>>()
const thumbnailDirty = new Set<string>()
let thumbnailCaptureInFlight = false
const thumbnailLastCapturedAt = new Map<string, number>()

/** The task the human currently sees in the one shared native window. */
let visibleTaskKey: string | undefined
/** Current open state of the left task and right trail glass panels. */
let workspacePanels: { tasks: boolean; trail: boolean } = { tasks: false, trail: false }
let window: BrowserWindow | undefined

function taskTitle(taskKey: string): string {
  const label = taskLabels.get(taskKey) ?? ''
  return label === '' ? 'dsh-browser-plus' : 'dsh-browser-plus — ' + label
}

function makeWindow(): BrowserWindow {
  const icon = resolveBrowserIconPath()
  if (process.platform === 'darwin' && icon !== undefined) {
    try {
      app.dock?.setIcon(icon)
    } catch {
      // The dock icon is cosmetic; a failure must never block window creation.
    }
  }
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: true,
    title: 'dsh-browser-plus',
    // Matches the chrome's palette: the window frame and any not-yet-painted
    // area are dark instead of the default white.
    backgroundColor: '#0e1218',
    // Chrome-like frame: no OS title bar. The tab strip becomes the window's
    // first row and the caption buttons are drawn over its right end, in the
    // strip's own colour so the overlay reads as part of the chrome (the strip
    // reserves that room — see page-chrome.ts).
    ...USES_OVERLAY_FRAME
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#202124', symbolColor: '#e8eaed', height: TABSTRIP_HEIGHT },
        }
      : {},
    ...(icon === undefined ? {} : { icon }),
  })
  win.setMenu(null)
  win.on('resize', layoutViews)
  // A minimised window reports a content size of 0, so any view created while it
  // is minimised is laid out 0x0 and stays that way -- restoring the window does
  // not fire 'resize'. Measured: a view created while minimised still reported
  // innerWidth 0 after ShowWindow(SW_RESTORE), while one created afterwards
  // reported 1388. Re-layout on the events that make the window visible again.
  win.on('restore', layoutViews)
  win.on('show', layoutViews)
  win.on('maximize', layoutViews)
  win.on('unmaximize', layoutViews)
  win.on('closed', () => {
    window = undefined
    visibleTaskKey = undefined
    for (const timer of thumbnailTimers.values()) clearTimeout(timer)
    thumbnailTimers.clear()
    taskThumbnails.clear()
    taskThumbnailVersions.clear()
    thumbnailDirty.clear()
    thumbnailLastCapturedAt.clear()
    thumbnailCaptureInFlight = false
    activeViewByTask.clear()
    taskViewIds.clear()
    taskStates.clear()
    taskLabels.clear()
    views.clear()
    viewFavicons.clear()
    loadingViews.clear()
    traces.clear()
    dialogLogs.clear()
    workspacePanels = { tasks: false, trail: false }
  })
  return win
}

function ensureWindow(): BrowserWindow {
  if (window !== undefined && !window.isDestroyed()) return window
  window = makeWindow()
  return window
}

/** Keep every task view aligned with the one shared content surface. */
function layoutViews(): void {
  const win = window
  if (win === undefined || win.isDestroyed()) return
  const [width, height] = win.getContentSize()
  for (const entry of views.values()) {
    try {
      entry.webContentsView.setBounds({ x: 0, y: 0, width: width ?? 0, height: height ?? 0 })
    } catch { /* destroyed */ }
  }
}

/** Restore the one visible task after any operation that touched child views. */
function syncVisibleTaskVisibility(): void {
  const viewId = visibleTaskKey === undefined ? undefined : activeViewByTask.get(visibleTaskKey)
  const target = viewId === undefined ? undefined : views.get(viewId)
  for (const entry of views.values()) {
    try {
      const active = entry === target
      if (active) entry.webContentsView.setVisible(true)
      else entry.webContentsView.setVisible(false)
      // Only notify a renderer whose state actually changed: this loop runs for
      // every view on each task switch, and the IPC is the expensive part.
      if (chromeActiveApplied.get(entry.webContentsView) === active) continue
      chromeActiveApplied.set(entry.webContentsView, active)
      runChromeScript(entry.webContentsView, ';window.__dshChromeActive = ' + String(active) + ';try { window.__dshChromeSetActive?.(' + String(active) + ') } catch {}')
    } catch { /* destroyed */ }
  }
}
interface TaskTraceSummary {
  readonly action: string
  readonly at: number
}

interface HostTaskState {
  status: 'idle' | 'running' | 'waiting-user' | 'failed'
  control: 'agent' | 'human'
  latestAction?: string
  error?: string
  updatedAt: number
}

interface TaskSummary {
  readonly key: string
  readonly label: string
  readonly active: boolean
  readonly background: boolean
  readonly url: string
  readonly tabs: number
  readonly status: 'idle' | 'running' | 'waiting-user' | 'failed'
  readonly control: 'agent' | 'human'
  readonly updatedAt: number
  readonly latest?: TaskTraceSummary
  readonly error?: string
  /**
   * Bumped when a new image arrives through the 'task.thumbnail' patch. The
   * image itself is never part of a summary: summaries reach every page.
   */
  readonly thumbnailVersion: number
}

function ensureTaskState(key: string): HostTaskState {
  const existing = taskStates.get(key)
  if (existing !== undefined) return existing
  const state: HostTaskState = { status: 'idle', control: 'agent', updatedAt: Date.now() }
  taskStates.set(key, state)
  return state
}

function updateTaskState(key: string, update: { status?: unknown; control?: unknown; latestAction?: unknown; error?: unknown }): HostTaskState {
  const state = ensureTaskState(key)
  if (update.status === 'idle' || update.status === 'running' || update.status === 'waiting-user' || update.status === 'failed') state.status = update.status
  if (update.control === 'agent' || update.control === 'human') state.control = update.control
  if (typeof update.latestAction === 'string') state.latestAction = update.latestAction.slice(0, 120)
  if (typeof update.error === 'string') state.error = update.error.slice(0, 180)
  else if (state.status !== 'failed') delete state.error
  state.updatedAt = Date.now()
  return state
}

function summarizeLatestTrace(entry: unknown): TaskTraceSummary | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  const action = typeof record.action === 'string' ? record.action : undefined
  const at = typeof record.at === 'number' ? record.at : undefined
  return action === undefined || at === undefined ? undefined : { action, at }
}

function taskSummaries(): TaskSummary[] {
  // Thumbnails are deliberately absent: these summaries are injected into every
  // visited page's main world, and shipping the JPEG here let any page read the
  // visible task's screen content. The image travels only through the targeted
  // 'task.thumbnail' patch, which is queued for the visible task alone.
  return [...activeViewByTask.entries()].flatMap(([key, viewId]) => {
    const activeView = views.get(viewId)
    if (activeView === undefined) return []
    const latest = summarizeLatestTrace((traces.get(viewId) ?? []).at(-1))
    const state = ensureTaskState(key)
    let url = ''
    try { url = activeView.webContentsView.webContents.getURL() } catch { /* closing */ }
    return [{
      key,
      label: taskLabels.get(key) ?? '',
      active: key === visibleTaskKey,
      background: key !== visibleTaskKey,
      url: taskSummaryUrl(url),
      tabs: taskViewIds.get(key)?.size ?? 0,
      status: state.status,
      control: state.control,
      updatedAt: state.updatedAt,
      ...(latest === undefined ? {} : { latest: latest }),
      ...(state.error !== undefined ? { error: state.error } : {}),
      thumbnailVersion: taskThumbnailVersions.get(key) ?? 0,
    }]
  })
}

/**
 * Fetch one page-reported icon and remember it as a data: URL.
 *
 * The fetch runs on the view's own session, so an icon behind a login resolves
 * exactly as the page's own `<link rel=icon>` request would. Everything about it
 * is bounded: the content type must be an admitted raster type, the body must
 * stay under {@link FAVICON_MAX_BYTES}, and the whole read is abandoned after
 * {@link FAVICON_FETCH_TIMEOUT_MS}. A rejected icon simply leaves the letter
 * fallback in place — the tab strip is never worth a stalled navigation.
 */
function rememberFavicon(view: WebContentsView, viewId: string, rawUrl: string): void {
  if (!/^https?:/i.test(rawUrl)) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FAVICON_FETCH_TIMEOUT_MS)
  void (async () => {
    try {
      const response = await view.webContents.session.fetch(rawUrl, { signal: controller.signal })
      if (!response.ok) return
      const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      if (!FAVICON_TYPES.includes(type)) return
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (Number.isFinite(declared) && declared > FAVICON_MAX_BYTES) return
      const body = Buffer.from(await response.arrayBuffer())
      if (body.length === 0 || body.length > FAVICON_MAX_BYTES) return
      // A late icon must not overwrite the one belonging to a newer document.
      if (!views.has(viewId)) return
      viewFavicons.set(viewId, `data:${type};base64,${body.toString('base64')}`)
      const taskKey = views.get(viewId)?.taskKey
      if (taskKey !== undefined && taskKey === visibleTaskKey) queueTabsSet()
    } catch {
      // Offline, aborted, opaque response, or a session torn down mid-read.
    } finally {
      clearTimeout(timer)
    }
  })()
}

/**
 * Tabs of one task, as the injected tab strip renders them.
 *
 * A tab IS a host view, so this is the task's view list in creation order
 * (taskViewIds is a Set, whose insertion order is stable across activations);
 * `active` marks the view currently shown for that task. Title and URL are read
 * live from the view, so the next push reflects a navigation.
 *
 * The URL is reduced to its origin by taskSummaryUrl(), exactly like the task
 * summaries: this state is injected into the page being displayed (and the strip
 * puts it in the button's title attribute), so a query string or an in-URL token
 * must never reach the page. The strip itself renders only the title.
 */
function tabSummaries(taskKey: string | undefined): ChromeTabSummary[] {
  if (taskKey === undefined) return []
  const viewIds = taskViewIds.get(taskKey)
  if (viewIds === undefined) return []
  const activeViewId = activeViewByTask.get(taskKey)
  const tabs: ChromeTabSummary[] = []
  for (const viewId of viewIds) {
    const entry = views.get(viewId)
    if (entry === undefined) continue
    let title = ''
    let url = ''
    let rawUrl = ''
    try {
      title = entry.webContentsView.webContents.getTitle()
      rawUrl = entry.webContentsView.webContents.getURL()
      // Origin only: the tab strip renders titles, and this value reaches the
      // page (the chrome lives in the page), so a full URL would hand the page
      // the query string and any token in it. Same redaction taskSummaries uses.
      url = taskSummaryUrl(rawUrl)
    } catch { /* closing */ }
    // The host's own start page is a data: URL, and Chromium falls back to that
    // URL as the title — a screenful of escaped markup in a tab. Chrome calls
    // this document "新标签页" and so does the strip.
    const internal = rawUrl === '' || rawUrl.startsWith('data:') || rawUrl.startsWith('about:')
    const favicon = viewFavicons.get(viewId)
    tabs.push({
      id: viewId,
      title: internal || title === '' ? '新标签页' : title,
      url: url ?? '',
      active: viewId === activeViewId,
      ...favicon === undefined ? {} : { favicon },
      ...loadingViews.has(viewId) ? { loading: true } : {},
    })
  }
  return tabs
}

let chromeEpoch = 1
let chromeRevision = 0
let pendingChromeOperations: ChromePatchOperation[] = []
let chromePatchTimer: ReturnType<typeof setTimeout> | undefined

function activeTraceForTask(taskKey: string | undefined): ChromeTrailEntry[] {
  const viewId = taskKey === undefined ? undefined : activeViewByTask.get(taskKey)
  const entries = viewId === undefined ? [] : traces.get(viewId) ?? []
  return entries.flatMap(entry => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const record = entry as Record<string, unknown>
    if (typeof record.action !== 'string' || typeof record.at !== 'number') return []
    return [{
      action: record.action,
      // The only funnel into the page-visible trail: the bootstrap and the
      // `trail.append` patch both read it back, so redaction belongs here.
      ...typeof record.params === 'object' && record.params !== null && !Array.isArray(record.params)
        ? { params: redactTraceParams(record.action, record.params as Record<string, unknown>) }
        : {},
      ...typeof record.ok === 'boolean' ? { ok: record.ok } : {},
      at: record.at,
    }]
  })
}

/**
 * Reduce one recorded action's params to what the in-page trail may show.
 *
 * The provider records replay-grade detail (full typed text, full executed
 * scripts, full URLs, upload and download paths). Every visited page can read
 * the injected trail, so a page could otherwise harvest what was typed on an
 * earlier site in the same task. Only the keys a human-readable description
 * needs survive; URLs and paths collapse to origin and basename, and typed text
 * to a character count.
 */
function redactTraceParams(action: string, params: Record<string, unknown>): Record<string, unknown> {
  const pageSafeKeys: Record<string, readonly string[]> = {
    navigate: ['url'],
    back: ['navigated'],
    forward: ['navigated'],
    reload: [],
    stop: [],
    execute: [],
    snapshot: [],
    // `target` is the description of the element the page itself matched, so it
    // carries nothing the page does not already know.
    click: ['x', 'y', 'target', 'button', 'modifiers'],
    doubleClick: ['x', 'y', 'target', 'button', 'modifiers'],
    hover: ['x', 'y', 'target'],
    scroll: ['deltaX', 'deltaY'],
    clickRef: ['snapshotId', 'ref'],
    scrollIntoView: ['snapshotId', 'ref', 'block'],
    fill: ['fields', 'submit'],
    type: ['chars'],
    pressKey: ['modifiers'],
    screenshot: ['fullPage'],
    content: ['selector'],
    waitForElement: ['selector', 'timeoutMs', 'visible'],
    uploadFile: ['selector'],
    download: ['url', 'savePath'],
    flushAuth: [],
    restoreAuth: ['count'],
    importAuth: ['count'],
    setSpace: ['label'],
    dialog: ['type', 'message'],
    replay: ['seq', 'of', 'chars', 'x', 'y'],
  }
  const keys = pageSafeKeys[action] ?? []
  const safe: Record<string, unknown> = {}
  for (const key of keys) {
    const value = params[key]
    if (value === undefined) continue
    if (key === 'url') {
      if (typeof value === 'string') safe.url = taskSummaryUrl(value)
      continue
    }
    if (key === 'savePath') {
      if (typeof value === 'string') safe.savePath = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
      continue
    }
    safe[key] = value
  }
  if (keys.includes('chars') && typeof params.text === 'string') safe.chars = params.text.length
  return safe
}

function chromeWorkspaceState(selectedTaskKey = visibleTaskKey): ChromeWorkspaceState {
  return {
    epoch: chromeEpoch,
    revision: chromeRevision,
    ...selectedTaskKey !== undefined ? { selectedTaskKey } : {},
    panels: workspacePanels,
    tasks: taskSummaries() as ChromeTaskSummary[],
    tabs: tabSummaries(selectedTaskKey),
    trail: activeTraceForTask(selectedTaskKey),
    bookmarks: chromeBookmarks,
    bookmarkBar: chromeBookmarkBar,
  }
}

function chromeBootstrapScript(selectedTaskKey = visibleTaskKey): string {
  const bootstrap = createBootstrap(chromeWorkspaceState(selectedTaskKey))
  const json = JSON.stringify(bootstrap)
  return ';window.__dshChromeBootstrap = ' + json
    + ';window.__dshTrail = window.__dshChromeBootstrap.trail'
    + ';window.__dshBookmarks = window.__dshChromeBootstrap.bookmarks'
    + ';window.__dshTasks = window.__dshChromeBootstrap.tasks'
    + ';window.__dshWorkspacePanels = window.__dshChromeBootstrap.panels'
    + ';try { window.__dshChromeApply?.(window.__dshChromeBootstrap) } catch {}'
    + ';try { window.__dshTrailRender?.() } catch {}'
    + ';try { window.__dshTaskRender?.() } catch {}'
    + ';try { window.__dshWorkspaceRender?.() } catch {}'
}

function chromePatchScript(operations: readonly ChromePatchOperation[]): string {
  const patch = createPatch(chromeEpoch, ++chromeRevision, operations)
  return ';window.__dshChromePatch = ' + JSON.stringify(patch)
    + ';try { window.__dshChromeApply?.(window.__dshChromePatch) } catch {}'
}

function pushChromeBootstrap(target: WebContentsView, selectedTaskKey = visibleTaskKey): void {
  runChromeScript(target, chromeBootstrapScript(selectedTaskKey))
}

function resetChromeDelivery(): void {
  chromeEpoch += 1
  chromeRevision = 0
  pendingChromeOperations = []
  if (chromePatchTimer !== undefined) {
    clearTimeout(chromePatchTimer)
    chromePatchTimer = undefined
  }
}

function pushVisibleChromeState(): void {
  resetChromeDelivery()
  const viewId = visibleTaskKey === undefined ? undefined : activeViewByTask.get(visibleTaskKey)
  const target = viewId === undefined ? undefined : views.get(viewId)
  if (target !== undefined) pushChromeBootstrap(target.webContentsView, visibleTaskKey)
}

function flushChromePatches(): void {
  chromePatchTimer = undefined
  const operations = pendingChromeOperations
  pendingChromeOperations = []
  if (operations.length === 0) return
  const viewId = visibleTaskKey === undefined ? undefined : activeViewByTask.get(visibleTaskKey)
  const target = viewId === undefined ? undefined : views.get(viewId)
  if (target === undefined) return
  runChromeScript(target.webContentsView, chromePatchScript(operations))
}

function queueChromePatch(...operations: ChromePatchOperation[]): void {
  pendingChromeOperations.push(...operations)
  if (chromePatchTimer !== undefined) return
  chromePatchTimer = setTimeout(flushChromePatches, 24)
}

/**
 * Push the visible task's tab list to the chrome.
 *
 * Only the visible task is ever pushed: a patch is delivered to the visible
 * view alone (flushChromePatches), so a background task's tabs would repaint
 * the on-screen tab strip with another task's tabs. A background task's choice
 * is instead carried by the next bootstrap, which always includes tabs.
 */
function queueTabsSet(): void {
  queueChromePatch({ op: 'tabs.set', tabs: tabSummaries(visibleTaskKey) })
}

function scheduleVisibleTaskThumbnail(taskKey: string, delayMs = 360): void {
  if (taskKey !== visibleTaskKey) return
  thumbnailDirty.add(taskKey)
  // A closed task panel does not need fresh pixels. Keep a dirty marker so the
  // next panel open or task switch refreshes just the selected task.
  if (!workspacePanels.tasks) return
  const existing = thumbnailTimers.get(taskKey)
  if (existing !== undefined) clearTimeout(existing)
  const sinceLast = Date.now() - (thumbnailLastCapturedAt.get(taskKey) ?? 0)
  const effectiveDelay = Math.max(delayMs, Math.max(0, 2_000 - sinceLast))
  const timer = setTimeout(() => {
    thumbnailTimers.delete(taskKey)
    void refreshVisibleTaskThumbnail(taskKey)
  }, effectiveDelay)
  thumbnailTimers.set(taskKey, timer)
}

/** A capturePage that never settles would leave the single-flight flag set forever. */
function capturePageWithTimeout(view: WebContentsView): Promise<ThumbnailImage> {
  return new Promise<ThumbnailImage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('thumbnail capture timed out')), THUMBNAIL_CAPTURE_TIMEOUT_MS)
    view.webContents.capturePage().then(
      image => { clearTimeout(timer); resolve(image) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

async function refreshVisibleTaskThumbnail(taskKey: string): Promise<void> {
  if (taskKey !== visibleTaskKey || !workspacePanels.tasks || thumbnailCaptureInFlight) return
  const viewId = activeViewByTask.get(taskKey)
  const entry = viewId === undefined ? undefined : views.get(viewId)
  if (entry === undefined) return
  thumbnailCaptureInFlight = true
  let produced = false
  try {
    const image = await capturePageWithTimeout(entry.webContentsView)
    if (taskKey !== visibleTaskKey || activeViewByTask.get(taskKey) !== viewId || !workspacePanels.tasks) return
    const thumbnail = taskThumbnailDataUrl(image)
    if (thumbnail === undefined) return
    thumbnailLastCapturedAt.set(taskKey, Date.now())
    thumbnailDirty.delete(taskKey)
    if (taskThumbnails.get(taskKey) === thumbnail) return
    taskThumbnails.delete(taskKey)
    taskThumbnails.set(taskKey, thumbnail)
    const version = (taskThumbnailVersions.get(taskKey) ?? 0) + 1
    taskThumbnailVersions.set(taskKey, version)
    produced = true
    while (taskThumbnails.size > 32) {
      const oldest = [...taskThumbnails.keys()].find(key => key !== visibleTaskKey)
      if (oldest === undefined) break
      taskThumbnails.delete(oldest)
      taskThumbnailVersions.delete(oldest)
    }
    const task = taskSummaries().find(candidate => candidate.key === taskKey)
    const operations: ChromePatchOperation[] = [{ op: 'task.thumbnail', key: taskKey, version, dataUrl: thumbnail }]
    if (task !== undefined) operations.push({ op: 'task.upsert', task })
    queueChromePatch(...operations)
  } catch {
    // Thumbnails are cosmetic; capture or JPEG encoding failures are ignored.
  } finally {
    thumbnailCaptureInFlight = false
    if (produced) {
      if (thumbnailDirty.has(taskKey) && taskKey === visibleTaskKey && workspacePanels.tasks) {
        scheduleVisibleTaskThumbnail(taskKey, 200)
      }
    } else {
      // A capture that produced nothing (or threw) must not re-arm the retry:
      // leaving the dirty flag set re-captured a window that cannot paint at
      // 5Hz for as long as the task panel stayed open.
      thumbnailDirty.delete(taskKey)
    }
  }
}

/** Select a task for the human without reparenting any page view. */
function switchVisibleTask(taskKey: string): void {
  const viewId = activeViewByTask.get(taskKey)
  const target = viewId === undefined ? undefined : views.get(viewId)
  if (target === undefined) throw new Error(`switch task: unknown task ${taskKey}`)
  const win = ensureWindow()
  visibleTaskKey = taskKey
  syncVisibleTaskVisibility()
  try { win.setTitle(taskTitle(taskKey)) } catch { /* closing */ }
  pushVisibleChromeState()
  // The visible task changed, so its tab strip (and which tab is marked active)
  // changed with it. Queued after the bootstrap: resetChromeDelivery() inside
  // pushVisibleChromeState() drops anything queued before it.
  queueTabsSet()
  scheduleVisibleTaskThumbnail(taskKey, 550)
}
/** The RPC socket to the parent; set when the connection is established. */
let rpcSocket: import('node:net').Socket | undefined

/**
 * Make sure the chrome's callback exists in this document.
 *
 * `Runtime.addBinding` is bound to the execution context that is current when it
 * is issued: a binding installed while the start page was loading is gone once
 * the first real navigation commits (measured — `typeof
 * window.__dshBrowserTaskAction` is 'function' on the start page and 'undefined'
 * on the next document). Without this every chrome control silently does
 * nothing on every real site: switch-task, handoff, workspace panels, tab
 * switching and the bootstrap resync all go through this one callable.
 *
 * In isolated mode the world itself is recreated per document (see
 * ensureChromeContext), which already re-registers the binding against it.
 */
async function ensureChromeBinding(view: WebContentsView): Promise<void> {
  try {
    if (CHROME_WORLD === 'isolated') {
      await ensureChromeContext(view)
      return
    }
    await view.webContents.debugger.sendCommand('Runtime.addBinding', { name: '__dshBrowserTaskAction' })
  } catch {
    // Chrome is cosmetic: a document that cannot host the callback still paints.
  }
}

/**
 * Re-apply the chrome to one view's current document. The script is rebuilt with
 * the view's token, so the copy the page receives can still authenticate its
 * actions; the provider's own fallback injection has no token to offer.
 */
function applyPageChrome(view: WebContentsView, viewId: string): void {
  const source = buildPageChromeScript(chromeTokens.get(view) ?? '')
  try {
    // The ACTIVE VIEW of the visible task, not merely any view belonging to it:
    // a background tab of the visible task must not claim to be on screen.
    const pageTaskKey = views.get(viewId)?.taskKey
    const active = pageTaskKey !== undefined && activeViewByTask.get(pageTaskKey) === viewId
    if (active) resetChromeDelivery()
    // The zoom factor is the host's to know: it is a webContents property, it
    // survives navigation, and the chrome cannot recover it from the page (a
    // fresh document's devicePixelRatio is already scaled, so deriving it there
    // silently stopped compensating after the first navigation).
    let zoom = 1
    try {
      zoom = view.webContents.getZoomFactor()
      // Re-apply rather than merely report it. Chromium keeps zoom per origin and
      // restores it asynchronously, so on the first load after a restart
      // getZoomFactor() already said 0.9 while the document was still rendering
      // at 1.0 — the chrome then over-compensated and drew 11% too small.
      // Setting it forces the value and the rendering to agree.
      if (Number.isFinite(zoom) && zoom > 0) view.webContents.setZoomFactor(zoom)
    } catch { /* closing */ }
    runChromeScript(view, source
      + ';window.__dshZoom = ' + String(Number.isFinite(zoom) && zoom > 0 ? zoom : 1)
      + ';window.__dshChromeActive = ' + String(active)
      + ';try { window.__dshChromeSetActive?.(' + String(active) + ') } catch {};'
      + chromeBootstrapScript())
  } catch {
    // Chrome is cosmetic; never fail a page for it.
  }
  const taskKey = views.get(viewId)?.taskKey
  if (taskKey !== undefined && taskKey === visibleTaskKey) {
    // Navigation completed for a tab of the visible task: its title/url changed,
    // so the strip needs a new list. The bootstrap injected just above already
    // carries tabs; this patch is what the tab-bar contract asks for on
    // navigation, and it also covers a background tab of the visible task
    // (whose own chrome is not on screen but whose title belongs in the strip).
    queueTabsSet()
    scheduleVisibleTaskThumbnail(taskKey, 550)
  }
}

/** Install human browser chrome without creating or reparenting a child view. */
function installPageChrome(view: WebContentsView, viewId: string): void {
  // Electron's native executeJavaScript waits for a committed document, unlike
  // a CDP evaluate issued before commit, which can hang. Re-run on every
  // committed navigation so the toolbar follows each document.
  const apply = (): void => {
    // A committed document has a new execution context, so the chrome's world
    // must be created for it rather than reused from the previous one, and the
    // callback the chrome talks back through must be re-registered for it.
    chromeContexts.delete(view)
    void ensureChromeBinding(view).then(() => applyPageChrome(view, viewId))
  }
  view.webContents.on('did-navigate', apply)
  view.webContents.on('did-navigate-in-page', apply)
  // did-navigate fires on commit, usually before the document's <title> is
  // known, so a tab would read as '新标签页' until the next switch. Re-push the
  // strip when the title actually settles (only for the task on screen).
  view.webContents.on('page-title-updated', () => {
    if (views.get(viewId)?.taskKey === visibleTaskKey) queueTabsSet()
  })
  apply()
}

/** Reply to the parent over the RPC socket. */
function reply(id: number, payload: Record<string, unknown>): void {
  if (rpcSocket === undefined) {
    process.stderr.write(`[dsh-browser-plus host] reply without socket (id=${id})\n`)
    return
  }
  rpcSocket.write(JSON.stringify({ id, ...payload }) + '\n')
}

/**
 * Tell the parent about a tab request the human made in the injected chrome.
 *
 * This is the one message the child sends without being asked: the host can
 * show a different view by itself, but the tab LIST belongs to the provider
 * (DSH process), which owns the session's tabs and active index. Sent as a
 * line with no `id`, which the parent's client routes to the chrome listener.
 */
function emitChromeEvent(action: Record<string, unknown>): void {
  if (rpcSocket === undefined) return
  try {
    rpcSocket.write(JSON.stringify({ event: 'chrome', action }) + '\n')
  } catch {
    // Parent gone; the view state this host already applied still stands.
  }
}

/**
 * True when a page-emitted `__dshBrowserTaskAction` payload carries this view's
 * token. The binding is callable by every page script, so without this check any
 * visited page could switch the visible task or set control to "human" and
 * freeze the Agent. Payloads without a matching token are ignored.
 */
function authorizeChromeAction(action: unknown, token: string): boolean {
  if (typeof action !== 'object' || action === null || Array.isArray(action)) return false
  return (action as { token?: unknown }).token === token
}

/** Handle one command. */
async function handle(op: string, msg: { id: number; viewId?: string; method?: string; params?: Record<string, unknown>; url?: string; savePath?: string; cookies?: unknown[]; entry?: unknown; key?: string; label?: string; task?: Record<string, unknown>; domain?: string; name?: string; all?: boolean }): Promise<void> {
  try {
    switch (op) {
      case 'ping':
        reply(msg.id, { ok: true })
        return
      case 'trace': {
        const viewId = msg.viewId
        const entry = msg.entry
        if (viewId === undefined || entry === undefined) throw new Error('trace missing viewId/entry')
        const list = traces.get(viewId) ?? []
        list.push(entry)
        if (list.length > 500) list.splice(0, list.length - 500)
        traces.set(viewId, list)
        const entryView = views.get(viewId)
        if (entryView !== undefined) {
          const latest = summarizeLatestTrace(entry)
          if (latest !== undefined) updateTaskState(entryView.taskKey, { latestAction: latest.action })
          const task = taskSummaries().find(candidate => candidate.key === entryView.taskKey)
          const operations: ChromePatchOperation[] = []
          if (task !== undefined) operations.push({ op: 'task.upsert', task })
          if (entryView.taskKey === visibleTaskKey && activeViewByTask.get(entryView.taskKey) === viewId) {
            const trail = activeTraceForTask(entryView.taskKey).at(-1)
            if (trail !== undefined) operations.push({ op: 'trail.append', taskKey: entryView.taskKey, entry: trail })
            scheduleVisibleTaskThumbnail(entryView.taskKey)
          }
          if (operations.length > 0) queueChromePatch(...operations)
        }
        reply(msg.id, { ok: true })
        return
      }
      case 'drainDialog': {
        const viewId = msg.viewId
        if (viewId === undefined) throw new Error('drainDialog missing viewId')
        const entry = views.get(viewId)
        if (entry === undefined) throw new Error(`drainDialog: unknown view ${viewId}`)
        const latest = dialogLogs.get(viewId)
        if (latest !== undefined) dialogLogs.delete(viewId)
        reply(msg.id, { ok: true, result: latest ?? null })
        return
      }
      case 'createView': {
        const viewId = msg.viewId
        if (viewId === undefined) throw new Error('createView missing viewId')
        const taskKey = typeof msg.key === 'string' ? msg.key : 'default'
        const label = typeof msg.label === 'string' ? msg.label : undefined
        const win = ensureWindow()
        if (label !== undefined) taskLabels.set(taskKey, label)
        const view = new WebContentsView()
        // Attach the debugger BEFORE the view can be seen: an attach failure
        // then leaves nothing in the window (no visible ghost view).
        view.webContents.debugger.attach(CDP_VERSION)
        // Per-view secret for the page chrome. It belongs to the view rather than
        // to a document, so re-injecting the chrome after a navigation reuses it.
        const chromeToken = randomBytes(24).toString('hex')
        chromeTokens.set(view, chromeToken)
        // Register the listener before enabling domains. Runtime.addBinding
        // exposes a callable function in the page, while Runtime.bindingCalled
        // is the only channel back to this host for workspace controls.
        // JS dialogs (alert/confirm/prompt) would freeze the page until
        // answered. Auto-accept immediately so automation never stalls, and
        // stash the detail for the provider to surface via drainDialog.
        view.webContents.debugger.on('message', (_event, method, params) => {
          if (method === 'Runtime.bindingCalled') {
            const binding = (params ?? {}) as { name?: unknown; payload?: unknown }
            if (binding.name === '__dshBrowserTaskAction' && typeof binding.payload === 'string') {
              try {
                const action = JSON.parse(binding.payload) as { type?: unknown; taskKey?: unknown; tabId?: unknown; tasks?: unknown; trail?: unknown; control?: unknown; factor?: unknown; url?: unknown; title?: unknown; visible?: unknown }
                // Authenticate before acting: only our injected chrome knows this
                // view's token, so a forged payload never reaches the dispatcher.
                if (!authorizeChromeAction(action, chromeToken)) return
                if (action.type === 'switch-task' && typeof action.taskKey === 'string' && activeViewByTask.has(action.taskKey)) {
                  switchVisibleTask(action.taskKey)
                } else if (action.type === 'request-chrome-bootstrap') {
                  if (views.get(viewId)?.taskKey === visibleTaskKey) pushVisibleChromeState()
                } else if (action.type === 'set-workspace-panels'
                  && typeof action.tasks === 'boolean'
                  && typeof action.trail === 'boolean') {
                  workspacePanels = { tasks: action.tasks, trail: action.trail }
                  if (workspacePanels.tasks && visibleTaskKey !== undefined) scheduleVisibleTaskThumbnail(visibleTaskKey)
                  queueChromePatch({ op: 'panels.set', panels: workspacePanels })
                } else if (action.type === 'set-control-owner'
                  && typeof action.taskKey === 'string'
                  && (action.control === 'agent' || action.control === 'human')
                  && activeViewByTask.has(action.taskKey)) {
                  updateTaskState(action.taskKey, action.control === 'human'
                    ? { control: 'human', status: 'waiting-user', latestAction: 'human took control' }
                    : { control: 'agent', status: 'idle', latestAction: 'agent resumed' })
                  const task = taskSummaries().find(candidate => candidate.key === action.taskKey)
                  if (task !== undefined) queueChromePatch({ op: 'task.upsert', task })
                } else if (action.type === 'bookmark-add'
                  && typeof action.url === 'string'
                  && action.url !== '') {
                  // Bookmarks are profile-wide, so the host owns them and pushes the
                  // new list back rather than letting the page keep its own copy in
                  // localStorage (which is per origin).
                  const title = typeof action.title === 'string' && action.title !== '' ? action.title : action.url
                  chromeBookmarks = [{ url: action.url, title }, ...chromeBookmarks.filter(item => item.url !== action.url)].slice(0, 500)
                  saveBookmarksToDisk()
                  queueChromePatch({ op: 'bookmarks.set', bookmarks: chromeBookmarks })
                } else if (action.type === 'bookmark-bar' && typeof action.visible === 'boolean') {
                  // The bar is a profile-wide preference, so the host owns it and the
                  // chrome reads it back from the bootstrap / patch stream.
                  chromeBookmarkBar = action.visible
                  savePrefsToDisk()
                  queueChromePatch({ op: 'bookmarkbar.set', visible: chromeBookmarkBar })
                } else if (action.type === 'bookmark-remove' && typeof action.url === 'string') {
                  chromeBookmarks = chromeBookmarks.filter(item => item.url !== action.url)
                  saveBookmarksToDisk()
                  queueChromePatch({ op: 'bookmarks.set', bookmarks: chromeBookmarks })
                } else if (action.type === 'set-zoom'
                  && typeof action.factor === 'number'
                  && Number.isFinite(action.factor)) {
                  // Page zoom is a webContents property: it re-lays out the page
                  // (so vh and media queries follow), which is exactly why the
                  // chrome cannot fake it in CSS. The chrome compensates for its
                  // own share of the scale — see page-chrome.ts.
                  const factor = Math.min(3, Math.max(0.25, action.factor))
                  try {
                    view.webContents.setZoomFactor(factor)
                    // Echo it back: the chrome polls __dshZoom to correct drift, so
                    // a stale value there would undo the zoom the user just asked
                    // for on the very next tick.
                    runChromeScript(view, ';window.__dshZoom = ' + String(factor)
                      + ';try { window.__dshChromeSetZoom?.(' + String(factor) + ') } catch {}')
                  } catch { /* closing */ }
                } else if (action.type === 'new-tab'
                  && typeof action.taskKey === 'string'
                  && activeViewByTask.has(action.taskKey)) {
                  // The provider creates the view; this host never invents a tab
                  // it does not own, or the strip and the session would diverge.
                  emitChromeEvent({ type: 'new-tab', taskKey: action.taskKey })
                } else if (action.type === 'close-tab'
                  && typeof action.taskKey === 'string'
                  && typeof action.tabId === 'string') {
                  // Only a tab that really belongs to that task may be closed;
                  // the provider destroys the view, which removes the strip entry.
                  const closable = views.get(action.tabId)
                  if (closable !== undefined && closable.taskKey === action.taskKey) {
                    emitChromeEvent({ type: 'close-tab', taskKey: action.taskKey, tabId: action.tabId })
                  }
                } else if (action.type === 'switch-tab'
                  && typeof action.taskKey === 'string'
                  && typeof action.tabId === 'string') {
                  // The host applies the switch immediately (it owns which view
                  // is on screen) and tells the provider so the session's
                  // activeIndex follows: without that, the next browser_* call
                  // would operate on the tab the provider last activated rather
                  // than the one the human just picked.
                  const tabEntry = views.get(action.tabId)
                  // An unknown tabId, or a tab that belongs to another task, is
                  // ignored silently like the other page actions: the chrome must
                  // never be interrupted by a stale tab strip.
                  if (tabEntry !== undefined && tabEntry.taskKey === action.taskKey) {
                    const activeViewChanged = activeViewByTask.get(action.taskKey) !== action.tabId
                    activeViewByTask.set(action.taskKey, action.tabId)
                    // Mirror the choice into the provider's session so its
                    // activeIndex stops disagreeing with what is on screen.
                    emitChromeEvent({ type: 'activate-tab', taskKey: action.taskKey, tabId: action.tabId })
                    if (activeViewChanged) taskThumbnails.delete(action.taskKey)
                    // Only the visible task has a tab strip the human can click. A
                    // background task's choice is remembered and applied when the
                    // human switches to it (switchVisibleTask reads activeViewByTask).
                    if (action.taskKey === visibleTaskKey) {
                      // switchVisibleTask re-syncs visibility and pushes the new
                      // tab list (it is the "visible view switched" push point).
                      switchVisibleTask(action.taskKey)
                    }
                  }
                }
              } catch { /* malformed page action */ }
            }
            return
          }
          if (method !== 'Page.javascriptDialogOpening') return
          const p = (params ?? {}) as { type?: unknown; message?: unknown; defaultPrompt?: unknown }
          const info = {
            type: String(p.type ?? ''),
            message: String(p.message ?? ''),
            ...typeof p.defaultPrompt === 'string' ? { prompt: p.defaultPrompt } : {},
          }
          dialogLogs.set(viewId, info)
          try {
            void view.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined)
          } catch { /* closing */ }
        })
        // Keep protocol-domain setup non-blocking. Electron 42 can leave a
        // later Page.navigate unresolved when domain setup is awaited during
        // WebContentsView creation. Runtime.addBinding itself installs the
        // page callback and emits bindingCalled through Electron's debugger.
        try { void view.webContents.debugger.sendCommand('Page.enable').catch(() => undefined) } catch { /* closed */ }
        try { void view.webContents.debugger.sendCommand('DOM.enable').catch(() => undefined) } catch { /* closed */ }
        // Isolated mode registers the binding against its own world instead.
        if (CHROME_WORLD === 'main') {
          try { void view.webContents.debugger.sendCommand('Runtime.addBinding', { name: '__dshBrowserTaskAction' }).catch(() => undefined) } catch { /* closed */ }
        }
        // Keep window.open / target=_blank navigations inside this shared view
        // instead of spawning a second native window. Only HTTP(S) targets are admitted.
        view.webContents.setWindowOpenHandler(({ url }) => {
          try {
            // loadURL returns a promise; an unhandled rejection here would crash
            // the host, so it is ignored exactly like the domain setup above.
            if (/^https?:\/\//i.test(url)) void view.webContents.loadURL(url).catch(() => undefined)
          } catch { /* closing */ }
          return { action: 'deny' }
        })
        // All later task views remain hidden until the human selects their task.
        view.setVisible(false)
        win.contentView.addChildView(view)
        views.set(viewId, { webContentsView: view, taskKey })
        const viewIds = taskViewIds.get(taskKey) ?? new Set<string>()
        viewIds.add(viewId)
        taskViewIds.set(taskKey, viewIds)
        ensureTaskState(taskKey)
        const activeViewChanged = activeViewByTask.get(taskKey) !== viewId
        activeViewByTask.set(taskKey, viewId)
        if (activeViewChanged) taskThumbnails.delete(taskKey)
        layoutViews()
        if (visibleTaskKey === undefined) switchVisibleTask(taskKey)
        // Fire-and-forget chrome registration: chrome must never block first paint.
        void installPageChrome(view, viewId)
        // Chromium reports the document's own icon URLs; the host does the read
        // so a page can never hand the chrome bytes it did not fetch itself.
        view.webContents.on('page-favicon-updated', (_event, favicons) => {
          const first = Array.isArray(favicons) ? favicons[0] : undefined
          if (typeof first === 'string' && first !== '') rememberFavicon(view, viewId, first)
        })
        // A committed navigation invalidates the previous document's icon. The
        // strip keeps the letter fallback until the new document reports one.
        view.webContents.on('did-navigate', () => {
          if (viewFavicons.delete(viewId) && views.get(viewId)?.taskKey === visibleTaskKey) queueTabsSet()
        })
        // Loading state: the strip turns the favicon into a spinner and the
        // toolbar turns reload into stop, so both ends need the transition.
        const setLoading = (loading: boolean): void => {
          const changed = loading ? !loadingViews.has(viewId) : loadingViews.has(viewId)
          if (loading) loadingViews.add(viewId)
          else loadingViews.delete(viewId)
          if (changed && views.get(viewId)?.taskKey === visibleTaskKey) queueTabsSet()
        }
        view.webContents.on('did-start-loading', () => setLoading(true))
        view.webContents.on('did-stop-loading', () => setLoading(false))
        // Commit a document immediately. Until something is loaded the view has
        // no frame, which is what made the empty window white and made every
        // CDP call hang; the start page is inert (no interactive elements), so a
        // snapshot of it is empty.
        void view.webContents.loadURL(START_PAGE_URL).catch(() => undefined)
        pushVisibleChromeState()
        // A new view is a new tab of its task. Only the visible task's strip is
        // on screen, and patches reach the visible view alone, so a background
        // task's new tab is picked up by the bootstrap when it becomes visible.
        if (taskKey === visibleTaskKey) queueTabsSet()
        reply(msg.id, { ok: true })
        return
      }
      case 'destroyView': {
        const viewId = msg.viewId
        if (viewId === undefined) throw new Error('destroyView missing viewId')
        const entry = views.get(viewId)
        if (entry !== undefined) {
          const wasActive = activeViewByTask.get(entry.taskKey) === viewId
          views.delete(viewId)
          const viewIds = taskViewIds.get(entry.taskKey)
          viewIds?.delete(viewId)
          if (viewIds !== undefined && viewIds.size === 0) taskViewIds.delete(entry.taskKey)
          dialogLogs.delete(viewId)
          traces.delete(viewId)
          viewFavicons.delete(viewId)
          loadingViews.delete(viewId)
          try { window?.contentView.removeChildView(entry.webContentsView) } catch { /* already removed */ }
          try { entry.webContentsView.webContents.debugger.detach() } catch { /* already detached */ }
          entry.webContentsView.webContents.close()
          const replacementView = [...views.entries()].find(([, candidate]) => candidate.taskKey === entry.taskKey)
          if (wasActive) {
            if (replacementView !== undefined) activeViewByTask.set(entry.taskKey, replacementView[0])
            else {
              activeViewByTask.delete(entry.taskKey)
              taskLabels.delete(entry.taskKey)
              taskStates.delete(entry.taskKey)
            }
          }
          if (replacementView === undefined) {
            const thumbnailTimer = thumbnailTimers.get(entry.taskKey)
            if (thumbnailTimer !== undefined) clearTimeout(thumbnailTimer)
            thumbnailTimers.delete(entry.taskKey)
            taskThumbnails.delete(entry.taskKey)
            taskThumbnailVersions.delete(entry.taskKey)
            thumbnailDirty.delete(entry.taskKey)
            thumbnailLastCapturedAt.delete(entry.taskKey)
          }
          if (visibleTaskKey === entry.taskKey) {
            if (activeViewByTask.has(entry.taskKey)) switchVisibleTask(entry.taskKey)
            else {
              const fallbackTask = activeViewByTask.keys().next().value as string | undefined
              if (fallbackTask !== undefined) switchVisibleTask(fallbackTask)
              else {
                visibleTaskKey = undefined
                try { window?.setTitle('dsh-browser-plus') } catch { /* closing */ }
              }
            }
          }
        }
        pushVisibleChromeState()
        // Closing a tab of the visible task shortens its strip. When the task
        // itself is gone, visibleTaskKey has already moved on via
        // switchVisibleTask (which pushed its own list), so this is a no-op there.
        if (entry !== undefined && entry.taskKey === visibleTaskKey) queueTabsSet()
        reply(msg.id, { ok: true })
        return
      }
      case 'showView': {
        const viewId = msg.viewId
        if (viewId === undefined) throw new Error('showView missing viewId')
        const entry = views.get(viewId)
        if (entry === undefined) throw new Error(`showView: unknown view ${viewId}`)
        const activeViewChanged = activeViewByTask.get(entry.taskKey) !== viewId
        activeViewByTask.set(entry.taskKey, viewId)
        if (activeViewChanged) taskThumbnails.delete(entry.taskKey)
        if (visibleTaskKey === undefined) switchVisibleTask(entry.taskKey)
        else if (entry.taskKey !== visibleTaskKey) {
          // Background task tab changes stay in the background.
          pushVisibleChromeState()
          reply(msg.id, { ok: true })
          return
        } else switchVisibleTask(entry.taskKey)
        reply(msg.id, { ok: true })
        return
      }
      case 'label': {
        const viewId = msg.viewId
        const label = msg.label
        if (viewId === undefined || typeof label !== 'string') throw new Error('label missing viewId/label')
        const entry = views.get(viewId)
        if (entry === undefined) throw new Error(`label: unknown view ${viewId}`)
        taskLabels.set(entry.taskKey, label)
        if (entry.taskKey === visibleTaskKey) {
          try { ensureWindow().setTitle(taskTitle(entry.taskKey)) } catch { /* closing */ }
        }
        pushVisibleChromeState()
        reply(msg.id, { ok: true })
        return
      }
      case 'reinstallChrome': {
        const viewId = msg.viewId
        if (viewId === undefined) throw new Error('reinstallChrome missing viewId')
        const entry = views.get(viewId)
        if (entry === undefined) throw new Error(`reinstallChrome: unknown view ${viewId}`)
        applyPageChrome(entry.webContentsView, viewId)
        reply(msg.id, { ok: true })
        return
      }
      case 'listWindows': {
        const windows = [...activeViewByTask.keys()].map(key => ({ key, label: taskLabels.get(key) ?? '' }))
        reply(msg.id, { ok: true, result: { windows } })
        return
      }
      case 'listTasks': {
        reply(msg.id, { ok: true, result: { tasks: taskSummaries() } })
        return
      }
      case 'getTask': {
        const key = msg.key
        if (typeof key !== 'string') throw new Error('getTask missing key')
        const task = taskSummaries().find(candidate => candidate.key === key)
        reply(msg.id, { ok: true, result: { task: task ?? null } })
        return
      }
      case 'updateTask': {
        const key = msg.key
        if (typeof key !== 'string' || msg.task === undefined) throw new Error('updateTask missing key or task')
        updateTaskState(key, msg.task)
        const task = taskSummaries().find(candidate => candidate.key === key)
        if (task !== undefined) queueChromePatch({ op: 'task.upsert', task })
        reply(msg.id, { ok: true, result: { task: task ?? null } })
        return
      }
      case 'command': {
        const viewId = msg.viewId
        if (viewId === undefined) throw new Error('command missing viewId')
        const entry = views.get(viewId)
        if (entry === undefined) throw new Error(`command: unknown view ${viewId}`)
        const method = msg.method
        if (typeof method !== 'string') throw new Error('command missing method')
        const result = await entry.webContentsView.webContents.debugger.sendCommand(method, msg.params ?? {})
        reply(msg.id, { ok: true, result })
        return
      }
      case 'capture': {
        const viewId = msg.viewId
        if (viewId === undefined) throw new Error('capture missing viewId')
        const entry = views.get(viewId)
        if (entry === undefined) throw new Error(`capture: unknown view ${viewId}`)
        const win = ensureWindow()
        // Two complementary paths, because each has a failure mode:
        //  - capturePage: fast and reliable with several WebContentsViews in
        //    the window, but needs a live display surface (fails when the
        //    window is minimized/occluded/unpainted).
        //  - CDP Page.captureScreenshot: works without a display surface, but
        //    can hang when another hidden WebContentsView exists in the window.
        // Try capturePage first (show/focus/restore + one retry), then CDP.
        try { if (!win.isVisible()) win.show() } catch { /* closing */ }
        try { win.restore() } catch { /* not minimized */ }
        try { win.focus() } catch { /* closing */ }
        let base64 = ''
        try {
          let image
          try {
            image = await entry.webContentsView.webContents.capturePage()
          } catch (error) {
            process.stderr.write(`[dsh-browser-plus host] capturePage failed: ${String(error)}\n`)
            await new Promise(resolve => setTimeout(resolve, 400))
            image = await entry.webContentsView.webContents.capturePage()
          }
          const png = image.toPNG()
          if (png.length > 0) base64 = png.toString('base64')
        } catch (error) {
          const state = JSON.stringify({
            win: { visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused() },
          })
          process.stderr.write(`[dsh-browser-plus host] capturePage retry failed: ${String(error)} state=${state}\n`)
          base64 = ''
        }
        if (base64 === '') {
          // CDP fallback. Page.captureScreenshot can hang when OTHER views
          // (especially hidden attach-first ones) are in the window, so
          // temporarily detach the siblings, capture in single-view state,
          // then restore them (target stays on top).
          const siblings = [...views.values()].filter(v => v !== entry)
          for (const v of siblings) {
            try { win.contentView.removeChildView(v.webContentsView) } catch { /* already gone */ }
          }
          try {
            const shot = await entry.webContentsView.webContents.debugger.sendCommand('Page.captureScreenshot', {})
            const data = (shot as { data?: unknown }).data
            if (typeof data === 'string' && data.length > 0) base64 = data
          } finally {
            for (const v of siblings) {
              try { win.contentView.addChildView(v.webContentsView) } catch { /* destroyed */ }
            }
            if (entry.taskKey === visibleTaskKey) {
              try {
                win.contentView.removeChildView(entry.webContentsView)
                win.contentView.addChildView(entry.webContentsView)
              } catch { /* closing */ }
            }
            syncVisibleTaskVisibility()
          }
        }
        if (base64 === '') {
          throw new Error('capture produced no image (view not painted)')
        }
        reply(msg.id, { ok: true, result: { base64, width: 0, height: 0 } })
        return
      }
      case 'download': {
        const viewId = msg.viewId
        const url = msg.url
        const savePath = msg.savePath
        if (viewId === undefined || typeof url !== 'string' || typeof savePath !== 'string') {
          throw new Error('download missing viewId/url/savePath')
        }
        const entry = views.get(viewId)
        if (entry === undefined) throw new Error(`download: unknown view ${viewId}`)
        // Fetch the URL inside the page context (keeps cookies/login), read
        // the body as base64, and return it; the parent writes the file. This
        // avoids Electron's download pipeline entirely (CDP debugger attach
        // can interfere with will-download).
        const result = await entry.webContentsView.webContents.debugger.sendCommand('Runtime.evaluate', {
          // The cap is enforced while streaming: reading the whole body first
          // let an oversized response exhaust the renderer before it was
          // rejected, which made the limit decorative.
          expression: `(async () => {
            const limit = ${String(MAX_DOWNLOAD_BYTES)}
            const r = await fetch(${JSON.stringify(url)}, { credentials: 'include', signal: AbortSignal.timeout(${String(DOWNLOAD_FETCH_TIMEOUT_MS)}) })
            if (!r.ok) throw new Error('HTTP ' + r.status)
            const declared = Number(r.headers.get('content-length'))
            if (Number.isFinite(declared) && declared > limit) throw new Error('download too large (limit ' + limit + ' bytes, declared ' + declared + ')')
            if (!r.body) throw new Error('download has no readable body')
            const reader = r.body.getReader()
            const chunks = []
            let total = 0
            for (;;) {
              const step = await reader.read()
              if (step.done) break
              total += step.value.length
              if (total > limit) {
                try { await reader.cancel() } catch (ignored) { /* already gone */ }
                throw new Error('download too large (limit ' + limit + ' bytes)')
              }
              chunks.push(step.value)
            }
            const bytes = new Uint8Array(total)
            let offset = 0
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
            let bin = ''
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
            return btoa(bin)
          })()`,
          awaitPromise: true,
          returnByValue: true,
        })
        const value = (result as { result?: { value?: unknown } }).result?.value
        if (typeof value !== 'string') {
          const detail = (result as { exceptionDetails?: { exception?: { description?: string } } }).exceptionDetails
          throw new Error(`download failed: ${detail?.exception?.description ?? 'no data'}`)
        }
        // Write here rather than shipping base64 back over the RPC line: the
        // parent then records only a byte count, so a download body never crosses
        // the socket (nor its line buffer) at all.
        const bytes = Buffer.from(value, 'base64')
        writeFileSync(savePath, bytes)
        reply(msg.id, { ok: true, result: { bytes: bytes.length } })
        return
      }
      case 'flushAuth': {
        const viewId = msg.viewId
        if (viewId === undefined) throw new Error('flushAuth missing viewId')
        const entry = views.get(viewId)
        if (entry === undefined) throw new Error(`flushAuth: unknown view ${viewId}`)
        // Export the session's cookies so login state can be saved/restored
        // across browser hosts (or shared with another machine).
        const cookies = await entry.webContentsView.webContents.session.cookies.get({})
        const exported = exportCookiesForAuth(cookies)
        reply(msg.id, { ok: true, result: { cookies: exported } })
        return
      }
      case 'restoreAuth': {
        const viewId = msg.viewId
        const cookies = msg.cookies
        if (viewId === undefined) throw new Error('restoreAuth missing viewId')
        const entry = views.get(viewId)
        if (entry === undefined) throw new Error(`restoreAuth: unknown view ${viewId}`)
        if (!Array.isArray(cookies)) throw new Error('restoreAuth missing cookies array')
        let restored = 0
        let failed = 0
        for (const c of cookies as Array<{ url?: string; name?: string; value?: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; expirationDate?: number; sameSite?: string }>) {
          if (typeof c.url !== 'string' || typeof c.name !== 'string' || typeof c.value !== 'string') { failed += 1; continue }
          try {
            await entry.webContentsView.webContents.session.cookies.set({
              url: c.url,
              name: c.name,
              value: c.value,
              ...typeof c.domain === 'string' ? { domain: c.domain } : {},
              ...typeof c.path === 'string' ? { path: c.path } : {},
              ...typeof c.secure === 'boolean' ? { secure: c.secure } : {},
              ...typeof c.httpOnly === 'boolean' ? { httpOnly: c.httpOnly } : {},
              ...typeof c.expirationDate === 'number' ? { expirationDate: c.expirationDate } : {},
              ...typeof c.sameSite === 'string' ? { sameSite: c.sameSite as 'no_restriction' | 'lax' | 'strict' | 'unspecified' } : {},
            })
            restored += 1
          } catch {
            // One malformed cookie must not discard the rest of the batch, and the
            // caller still learns how many landed.
            failed += 1
          }
        }
        reply(msg.id, { ok: true, result: { restored, failed } })
        return
      }
      case 'clearCookies': {
        const viewId = msg.viewId
        if (viewId === undefined) throw new Error('clearCookies missing viewId')
        const entry = views.get(viewId)
        if (entry === undefined) throw new Error('clearCookies: unknown view ' + viewId)
        // Remove the cookies the caller scoped by domain and/or name. An
        // unscoped request must pass all: true, so a missing filter can never
        // wipe every login in the profile.
        const filter = {
          ...typeof msg.domain === 'string' && msg.domain !== '' ? { domain: msg.domain } : {},
          ...typeof msg.name === 'string' && msg.name !== '' ? { name: msg.name } : {},
          ...msg.all === true ? { all: true } : {},
        }
        const cookies = await entry.webContentsView.webContents.session.cookies.get({})
        const targets = selectCookiesForClear(cookies, filter)
        const names: string[] = []
        for (const target of targets) {
          await entry.webContentsView.webContents.session.cookies.remove(target.url, target.name)
          names.push(target.name)
        }
        reply(msg.id, { ok: true, result: { removed: names.length, names } })
        return
      }
      default:
        throw new Error(`unknown op ${op}`)
    }
  } catch (error) {
    reply(msg.id, { ok: false, err: String(error) })
  }
}

/**
 * Electron entry: connect back to the parent's RPC server (port from
 * `--rpc-port`) and serve line-delimited JSON-RPC. `ELECTRON_RUN_AS_NODE` is
 * cleared by the parent so `require('electron')` works; this file is loaded as
 * the app entry so `app` is available immediately.
 */
void app.whenReady().then(() => {
  installRequestFingerprint()
  loadBookmarksFromDisk()
  loadPrefsFromDisk()
  const portArg = process.argv.indexOf('--rpc-port')
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : NaN
  if (!Number.isFinite(port)) {
    process.stderr.write('[dsh-browser-plus host] missing --rpc-port\n')
    app.exit(1)
    return
  }
  const socket = createConnection({ host: '127.0.0.1', port })
  rpcSocket = socket
  socket.setEncoding('utf8')
  const rl = createInterface({ input: socket })
  rl.on('line', line => {
    const text = line.trim()
    if (text === '') return
    let msg: { id: number; op?: string; viewId?: string; method?: string; params?: Record<string, unknown>; url?: string; savePath?: string; cookies?: unknown[]; key?: string; label?: string; task?: Record<string, unknown>; domain?: string; name?: string; all?: boolean }
    try {
      msg = JSON.parse(text) as typeof msg
    } catch {
      return // non-protocol noise
    }
    if (typeof msg.id !== 'number' || typeof msg.op !== 'string') return
    void handle(msg.op, msg).catch(() => { /* reply already sent inside handle */ })
  })
  socket.on('error', error => {
    process.stderr.write(`[dsh-browser-plus host] socket error: ${String(error)}\n`)
  })
  // The parent owns our lifetime: when it closes the socket (dispose) or dies
  // without cleanup, exit so no zombie Electron window is left behind.
  socket.on('close', () => {
    process.stderr.write('[dsh-browser-plus host] parent connection closed, exiting\n')
    app.exit(0)
  })
  // Keep the process alive until the parent closes the socket or kills us.
})

// Diagnostics go to stderr, which the parent never parses as protocol.
process.on('uncaughtException', error => {
  process.stderr.write(`[dsh-browser-plus host] uncaught: ${String(error)}\n`)
})
