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

import { app, BrowserWindow, WebContentsView } from 'electron'
import { createInterface } from 'node:readline'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { buildPageChromeScript } from './page-chrome.js'
import { taskSummaryUrl } from './task-summary.js'
import { taskThumbnailDataUrl } from './task-thumbnail.js'
import { exportCookiesForAuth } from './auth-cookies.js'
import { resolveBrowserIconPath } from './icon.js'
import { createBootstrap, createPatch, type ChromePatchOperation, type ChromeTaskSummary, type ChromeTrailEntry, type ChromeWorkspaceState } from './chrome-state.js'

// Isolate this host's profile from the DSH app's default Electron userData:
// several Electron instances sharing Roaming\Electron fight over the GPU
// cache/session locks, which can leave the window without a display surface
// (capturePage then fails). A dedicated userData also persists cookies across
// host restarts (on top of browser_auth). Must run before app is ready.
try {
  const base = process.env.DSH_HOME ?? app.getPath('appData')
  app.setPath('userData', join(base, 'dsh-browser-plus-host'))
} catch (error) {
  process.stderr.write(`[dsh-browser-plus host] userData setup failed: ${String(error)}\n`)
}

/** CDP protocol version attached to every view's debugger. */
const CDP_VERSION = '1.3'

/** Download cap: the body is shipped base64 as one JSON line; bound the memory. */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024

/** One task-scoped page view in the shared browser window. */
interface HostView {
  readonly webContentsView: WebContentsView
  readonly taskKey: string
}

/** Views by the id the parent assigned at createView time. */
const views = new Map<string, HostView>()

/** Operation trail per view, newest last, bounded. */
const traces = new Map<string, unknown[]>()

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
    ...(icon === undefined ? {} : { icon }),
  })
  win.setMenu(null)
  win.on('resize', layoutViews)
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
      void entry.webContentsView.webContents.executeJavaScript(';window.__dshChromeActive = ' + String(active) + ';try { window.__dshChromeSetActive?.(' + String(active) + ') } catch {}').catch(() => undefined)
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
  readonly thumbnail?: string
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
  return [...activeViewByTask.entries()].flatMap(([key, viewId]) => {
    const activeView = views.get(viewId)
    if (activeView === undefined) return []
    const latest = summarizeLatestTrace((traces.get(viewId) ?? []).at(-1))
    const thumbnail = taskThumbnails.get(key)
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
      ...(thumbnail === undefined ? {} : { thumbnail: thumbnail }),
      thumbnailVersion: taskThumbnailVersions.get(key) ?? 0,
    }]
  })
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
      ...typeof record.params === 'object' && record.params !== null && !Array.isArray(record.params) ? { params: record.params as Record<string, unknown> } : {},
      ...typeof record.ok === 'boolean' ? { ok: record.ok } : {},
      at: record.at,
    }]
  })
}

function chromeWorkspaceState(selectedTaskKey = visibleTaskKey): ChromeWorkspaceState {
  return {
    epoch: chromeEpoch,
    revision: chromeRevision,
    ...selectedTaskKey !== undefined ? { selectedTaskKey } : {},
    panels: workspacePanels,
    tasks: taskSummaries() as ChromeTaskSummary[],
    trail: activeTraceForTask(selectedTaskKey),
  }
}

function chromeBootstrapScript(selectedTaskKey = visibleTaskKey): string {
  const bootstrap = createBootstrap(chromeWorkspaceState(selectedTaskKey))
  const json = JSON.stringify(bootstrap)
  return ';window.__dshChromeBootstrap = ' + json
    + ';window.__dshTrail = window.__dshChromeBootstrap.trail'
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
  try {
    void target.webContents.executeJavaScript(chromeBootstrapScript(selectedTaskKey)).catch(() => undefined)
  } catch { /* closing */ }
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
  try {
    void target.webContentsView.webContents.executeJavaScript(chromePatchScript(operations)).catch(() => undefined)
  } catch { /* closing */ }
}

function queueChromePatch(...operations: ChromePatchOperation[]): void {
  pendingChromeOperations.push(...operations)
  if (chromePatchTimer !== undefined) return
  chromePatchTimer = setTimeout(flushChromePatches, 24)
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

async function refreshVisibleTaskThumbnail(taskKey: string): Promise<void> {
  if (taskKey !== visibleTaskKey || !workspacePanels.tasks || thumbnailCaptureInFlight) return
  const viewId = activeViewByTask.get(taskKey)
  const entry = viewId === undefined ? undefined : views.get(viewId)
  if (entry === undefined) return
  thumbnailCaptureInFlight = true
  try {
    const image = await entry.webContentsView.webContents.capturePage()
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
    if (thumbnailDirty.has(taskKey) && taskKey === visibleTaskKey && workspacePanels.tasks) {
      scheduleVisibleTaskThumbnail(taskKey, 200)
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
  scheduleVisibleTaskThumbnail(taskKey, 550)
}
/** The RPC socket to the parent; set when the connection is established. */
let rpcSocket: import('node:net').Socket | undefined

/** Install human browser chrome without creating or reparenting a child view. */
function installPageChrome(view: WebContentsView, viewId: string): void {
  const source = buildPageChromeScript()
  // Electron's native executeJavaScript waits for a committed document, unlike
  // a CDP evaluate issued before commit, which can hang. Re-run on every
  // committed navigation so the toolbar follows each document.
  const apply = (): void => {
    try {
      const pageTaskKey = views.get(viewId)?.taskKey
      const active = pageTaskKey !== undefined && pageTaskKey === visibleTaskKey
      if (active) resetChromeDelivery()
      void view.webContents.executeJavaScript(source + ';window.__dshChromeActive = ' + String(active) + ';try { window.__dshChromeSetActive?.(' + String(active) + ') } catch {};' + chromeBootstrapScript()).catch(() => undefined)
    } catch {
      // Chrome is cosmetic; never fail a page for it.
    }
    const taskKey = views.get(viewId)?.taskKey
    if (taskKey !== undefined && taskKey === visibleTaskKey) scheduleVisibleTaskThumbnail(taskKey, 550)
  }
  view.webContents.on('did-navigate', apply)
  view.webContents.on('did-navigate-in-page', apply)
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

/** Handle one command. */
async function handle(op: string, msg: { id: number; viewId?: string; method?: string; params?: Record<string, unknown>; url?: string; savePath?: string; cookies?: unknown[]; entry?: unknown; key?: string; label?: string; task?: Record<string, unknown> }): Promise<void> {
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
                const action = JSON.parse(binding.payload) as { type?: unknown; taskKey?: unknown; tasks?: unknown; trail?: unknown; control?: unknown }
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
        try { void view.webContents.debugger.sendCommand('Runtime.addBinding', { name: '__dshBrowserTaskAction' }).catch(() => undefined) } catch { /* closed */ }
        // Keep window.open / target=_blank navigations inside this shared view
        // instead of spawning a second native window. Only HTTP(S) targets are admitted.
        view.webContents.setWindowOpenHandler(({ url }) => {
          try {
            if (/^https?:\/\//i.test(url)) view.webContents.loadURL(url)
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
        pushVisibleChromeState()
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
    let msg: { id: number; op?: string; viewId?: string; method?: string; params?: Record<string, unknown>; url?: string; savePath?: string; cookies?: unknown[]; key?: string; label?: string; task?: Record<string, unknown> }
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
