/**
 * Self-hosted Electron browser host (child side): the Electron main process
 * spawned by {@link RemoteElectronViewHost}. Owns one `BrowserWindow` per
 * session key plus
 * `WebContentsView`s and their `webContents.debugger` (CDP), and answers
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
 * @module dsh-browser/browser-electron/host-main
 */

import { app, BrowserWindow, WebContentsView } from 'electron'
import { createInterface } from 'node:readline'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { buildPageChromeScript } from './page-chrome.js'

// Isolate this host's profile from the DSH app's default Electron userData:
// several Electron instances sharing Roaming\Electron fight over the GPU
// cache/session locks, which can leave the window without a display surface
// (capturePage then fails). A dedicated userData also persists cookies across
// host restarts (on top of browser_auth). Must run before app is ready.
try {
  const base = process.env.DSH_HOME ?? app.getPath('appData')
  app.setPath('userData', join(base, 'dsh-browser-plus-host'))
} catch (error) {
  process.stderr.write(`[dsh-browser host] userData setup failed: ${String(error)}\n`)
}

/** CDP protocol version attached to every view's debugger. */
const CDP_VERSION = '1.3'

/** Download cap: the body is shipped base64 as one JSON line; bound the memory. */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024

/** One view: the Electron object plus its CDP-backed surface. */
interface HostView {
  readonly webContentsView: WebContentsView
  /** The window this view lives in (one per session key). */
  readonly window: BrowserWindow
  /** The window group key the view belongs to. */
  readonly windowKey: string
}

/** Views by the id the parent assigned at createView time. */
const views = new Map<string, HostView>()

/** Operation trail per view, newest last, bounded. */
const traces = new Map<string, unknown[]>()

/** Latest unread JS dialog per view (auto-accepted; read by drainDialog). */
const dialogLogs = new Map<string, unknown>()

/** Default window (key 'default'), created lazily. */
let defaultWindow: BrowserWindow | undefined
/** Per-session windows by their key. */
const windowsByKey = new Map<string, BrowserWindow>()
/** Most recent label per window key (for listWindows). */
const windowLabels = new Map<string, string>()

function makeWindow(title: string): BrowserWindow {
  const win = new BrowserWindow({ width: 1400, height: 900, show: true, title })
  win.setMenu(null)
  win.on('resize', () => layoutWindow(win))
  return win
}

function windowFor(key: string, label?: string): BrowserWindow {
  if (key === 'default') {
    if (defaultWindow === undefined) defaultWindow = makeWindow(label !== undefined ? `dsh-browser — ${label}` : 'dsh-browser')
    return defaultWindow
  }
  let win = windowsByKey.get(key)
  if (win === undefined) {
    win = makeWindow(label !== undefined ? `dsh-browser — ${label}` : 'dsh-browser')
    windowsByKey.set(key, win)
    win.on('closed', () => { windowsByKey.delete(key); windowLabels.delete(key) })
  }
  return win
}

/** The RPC socket to the parent; set when the connection is established. */
let rpcSocket: import('node:net').Socket | undefined

/** Keep all views of one window aligned with its content surface. */
function layoutWindow(win: BrowserWindow): void {
  const [width, height] = win.getContentSize()
  for (const entry of views.values()) {
    if (entry.window !== win) continue
    try {
      entry.webContentsView.setBounds({ x: 0, y: 0, width: width ?? 0, height: height ?? 0 })
    } catch { /* destroyed */ }
  }
}

/** Install human browser chrome without creating or reparenting a child view. */
function installPageChrome(view: WebContentsView, viewId: string): void {
  const source = buildPageChromeScript()
  // Electron's native executeJavaScript waits for a committed document, unlike
  // a CDP evaluate issued before commit, which can hang. Re-run on every
  // committed navigation so the toolbar follows each document.
  const apply = (): void => {
    try {
      const trail = JSON.stringify(traces.get(viewId) ?? [])
      void view.webContents.executeJavaScript('window.__dshTrail = ' + trail + ';' + source).catch(() => undefined)
    } catch {
      // Chrome is cosmetic; never fail a page for it.
    }
  }
  view.webContents.on('did-navigate', apply)
  view.webContents.on('did-navigate-in-page', apply)
  apply()
}

/** Reply to the parent over the RPC socket. */
function reply(id: number, payload: Record<string, unknown>): void {
  if (rpcSocket === undefined) {
    process.stderr.write(`[dsh-browser host] reply without socket (id=${id})\n`)
    return
  }
  rpcSocket.write(JSON.stringify({ id, ...payload }) + '\n')
}

/** Handle one command. */
async function handle(op: string, msg: { id: number; viewId?: string; method?: string; params?: Record<string, unknown>; url?: string; savePath?: string; cookies?: unknown[]; entry?: unknown; key?: string; label?: string }): Promise<void> {
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
        // Push the freshest trail into the live page so the panel updates in place.
        const entryView = views.get(viewId)
        if (entryView !== undefined) {
          try {
            void entryView.webContentsView.webContents.executeJavaScript('window.__dshTrail = ' + JSON.stringify(list) + '; try { window.__dshTrailRender && window.__dshTrailRender() } catch {}').catch(() => undefined)
          } catch { /* closing */ }
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
        const windowKey = typeof msg.key === 'string' ? msg.key : 'default'
        const label = typeof msg.label === 'string' ? msg.label : undefined
        const win = windowFor(windowKey, label)
        const view = new WebContentsView()
        // Attach the debugger BEFORE the view can be seen: an attach failure
        // then leaves nothing in the window (no visible ghost view).
        view.webContents.debugger.attach(CDP_VERSION)
        // Enable event domains so JS dialogs are observable; both are
        // fire-and-forget — a failure must never block first paint.
        try { void view.webContents.debugger.sendCommand('Page.enable').catch(() => undefined) } catch { /* closed */ }
        try { void view.webContents.debugger.sendCommand('DOM.enable').catch(() => undefined) } catch { /* closed */ }
        // JS dialogs (alert/confirm/prompt) would freeze the page until
        // answered. Auto-accept immediately so automation never stalls, and
        // stash the detail for the provider to surface via drainDialog.
        view.webContents.debugger.on('message', (_event, method, params) => {
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
        // Keep window.open / target=_blank navigations inside this shared view
        // instead of spawning separate Electron windows (rewards cards, sign-in
        // flows, and most sites use them). Only HTTP(S) targets are admitted.
        view.webContents.setWindowOpenHandler(({ url }) => {
          try {
            if (/^https?:\/\//i.test(url)) view.webContents.loadURL(url)
          } catch { /* closing */ }
          return { action: 'deny' }
        })
        // New views start hidden: with several sessions/tabs only the shown
        // one may be visible (they stack in contentView child order).
        view.setVisible(false)
        const firstView = views.size === 0
        win.contentView.addChildView(view)
        views.set(viewId, { webContentsView: view, window: win, windowKey })
        layoutWindow(win)
        if (firstView) view.setVisible(true)
        // Fire-and-forget chrome registration: CDP calls on a view that is not
        // yet inside the window can hang, and chrome must never block first paint.
        void installPageChrome(view, viewId)
        reply(msg.id, { ok: true })
        return
      }
      case 'destroyView': {
        const viewId = msg.viewId
        if (viewId === undefined) throw new Error('destroyView missing viewId')
        const entry = views.get(viewId)
        if (entry !== undefined) {
          views.delete(viewId)
          try { entry.webContentsView.webContents.debugger.detach() } catch { /* already detached */ }
          entry.webContentsView.webContents.close()
          entry.window.contentView.removeChildView(entry.webContentsView)
        }
        reply(msg.id, { ok: true })
        return
      }
      case 'showView': {
        const viewId = msg.viewId
        if (viewId === undefined) throw new Error('showView missing viewId')
        const entry = views.get(viewId)
        if (entry !== undefined) {
          // Hide every other view, then show and RAISE the target so the
          // human actually sees the active tab/session (topmost child wins).
          for (const v of views.values()) {
            if (v === entry || v.window !== entry.window) continue
            try { v.webContentsView.setVisible(false) } catch { /* destroyed */ }
          }
          entry.webContentsView.setVisible(true)
        }
        reply(msg.id, { ok: true })
        return
      }
      case 'label': {
        const viewId = msg.viewId
        const label = msg.label
        if (viewId === undefined || typeof label !== 'string') throw new Error('label missing viewId/label')
        const entry = views.get(viewId)
        if (entry === undefined) throw new Error(`label: unknown view ${viewId}`)
        try { entry.window.setTitle(`dsh-browser — ${label}`) } catch { /* closing */ }
        windowLabels.set(entry.windowKey, label)
        reply(msg.id, { ok: true })
        return
      }
      case 'listWindows': {
        const windows: Array<{ key: string; label: string }> = []
        if (defaultWindow !== undefined) windows.push({ key: 'default', label: windowLabels.get('default') ?? '' })
        for (const [key, win] of windowsByKey) {
          if (!win.isDestroyed()) windows.push({ key, label: windowLabels.get(key) ?? '' })
        }
        reply(msg.id, { ok: true, result: { windows } })
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
        // Two complementary paths, because each has a failure mode:
        //  - capturePage: fast and reliable with several WebContentsViews in
        //    the window, but needs a live display surface (fails when the
        //    window is minimized/occluded/unpainted).
        //  - CDP Page.captureScreenshot: works without a display surface, but
        //    can hang when another hidden WebContentsView exists in the window.
        // Try capturePage first (show/focus/restore + one retry), then CDP.
        try { if (!entry.window.isVisible()) entry.window.show() } catch { /* closing */ }
        try { entry.window.restore() } catch { /* not minimized */ }
        entry.window.focus()
        let base64 = ''
        try {
          let image
          try {
            image = await entry.webContentsView.webContents.capturePage()
          } catch (error) {
            process.stderr.write(`[dsh-browser host] capturePage failed: ${String(error)}\n`)
            await new Promise(resolve => setTimeout(resolve, 400))
            image = await entry.webContentsView.webContents.capturePage()
          }
          const png = image.toPNG()
          if (png.length > 0) base64 = png.toString('base64')
        } catch (error) {
          const state = JSON.stringify({
            win: { visible: entry.window.isVisible(), minimized: entry.window.isMinimized(), focused: entry.window.isFocused() },
          })
          process.stderr.write(`[dsh-browser host] capturePage retry failed: ${String(error)} state=${state}\n`)
          base64 = ''
        }
        if (base64 === '') {
          // CDP fallback. Page.captureScreenshot can hang when OTHER views
          // (especially hidden attach-first ones) are in the window, so
          // temporarily detach the siblings, capture in single-view state,
          // then restore them (target stays on top).
          const siblings = [...views.values()].filter(v => v !== entry)
          for (const v of siblings) {
            try { entry.window.contentView.removeChildView(v.webContentsView) } catch { /* already gone */ }
          }
          try {
            const shot = await entry.webContentsView.webContents.debugger.sendCommand('Page.captureScreenshot', {})
            const data = (shot as { data?: unknown }).data
            if (typeof data === 'string' && data.length > 0) base64 = data
          } finally {
            for (const v of siblings) {
              try { entry.window.contentView.addChildView(v.webContentsView) } catch { /* destroyed */ }
            }
            try {
              entry.window.contentView.removeChildView(entry.webContentsView)
              entry.window.contentView.addChildView(entry.webContentsView)
            } catch { /* closing */ }
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
          expression: `(async () => {
            const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' })
            if (!r.ok) throw new Error('HTTP ' + r.status)
            const b = await r.arrayBuffer()
            const bytes = new Uint8Array(b)
            if (bytes.length > ${String(MAX_DOWNLOAD_BYTES)}) throw new Error('download too large (limit ' + ${String(MAX_DOWNLOAD_BYTES)} + ' bytes, got ' + bytes.length + ')')
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
        reply(msg.id, { ok: true, result: { base64: value, savePath } })
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
        const exported = cookies.map(c => {
          const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain
          // IPv6 literal domains need brackets in a URL (e.g. http://[::1]/).
          const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
          return {
            url: `http${c.secure ? 's' : ''}://${hostPart}${c.path}`,
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            expirationDate: c.expirationDate,
          }
        })
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
        for (const c of cookies as Array<{ url?: string; name?: string; value?: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; expirationDate?: number }>) {
          if (typeof c.url !== 'string' || typeof c.name !== 'string' || typeof c.value !== 'string') continue
          await entry.webContentsView.webContents.session.cookies.set({
            url: c.url,
            name: c.name,
            value: c.value,
            ...typeof c.domain === 'string' ? { domain: c.domain } : {},
            ...typeof c.path === 'string' ? { path: c.path } : {},
            ...typeof c.secure === 'boolean' ? { secure: c.secure } : {},
            ...typeof c.httpOnly === 'boolean' ? { httpOnly: c.httpOnly } : {},
            ...typeof c.expirationDate === 'number' ? { expirationDate: c.expirationDate } : {},
          })
          restored++
        }
        reply(msg.id, { ok: true, result: { restored } })
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
  const portArg = process.argv.indexOf('--rpc-port')
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : NaN
  if (!Number.isFinite(port)) {
    process.stderr.write('[dsh-browser host] missing --rpc-port\n')
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
    let msg: { id: number; op?: string; viewId?: string; method?: string; params?: Record<string, unknown>; url?: string; savePath?: string; cookies?: unknown[]; key?: string; label?: string }
    try {
      msg = JSON.parse(text) as typeof msg
    } catch {
      return // non-protocol noise
    }
    if (typeof msg.id !== 'number' || typeof msg.op !== 'string') return
    void handle(msg.op, msg).catch(() => { /* reply already sent inside handle */ })
  })
  socket.on('error', error => {
    process.stderr.write(`[dsh-browser host] socket error: ${String(error)}\n`)
  })
  // The parent owns our lifetime: when it closes the socket (dispose) or dies
  // without cleanup, exit so no zombie Electron window is left behind.
  socket.on('close', () => {
    process.stderr.write('[dsh-browser host] parent connection closed, exiting\n')
    app.exit(0)
  })
  // Keep the process alive until the parent closes the socket or kills us.
})

// Diagnostics go to stderr, which the parent never parses as protocol.
process.on('uncaughtException', error => {
  process.stderr.write(`[dsh-browser host] uncaught: ${String(error)}\n`)
})
