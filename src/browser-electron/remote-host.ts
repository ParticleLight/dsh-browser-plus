/**
 * Self-hosted Electron browser host (parent side): an
 * {@link ElectronBrowserViewHost} implementation that spawns the plugin's own
 * Electron child process (host-main.js) and drives it over line-delimited
 * JSON-RPC on a loopback TCP socket. This is what makes the plugin work on
 * surfaces without a desktop shell's electronViewHost (plain dsh web):
 * installing the plugin is enough — the browser window appears on first use.
 *
 * Protocol (one JSON object per line, both directions):
 *   -> { id, op: 'createView' } | { id, op: 'destroyView', viewId } |
 *      { id, op: 'showView', viewId } | { id, op: 'command', viewId, method, params }
 *   <- { id, ok: true, result? } | { id, ok: false, err }
 *
 * The child is Electron's main process; host-main.js owns the BrowserWindow,
 * WebContentsViews, and webContents.debugger (CDP).
 * @module dsh-browser-plus/browser-electron/remote-host
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { ChromeHostEvent, ElectronBrowserViewHost, ElectronViewHandle } from './provider.ts'
import { BrowserError } from '../browser/types.ts'
import type { BrowserTaskInfo, BrowserTaskUpdate, ExportedCookie } from '../browser/types.ts'

/** How long to wait for the child to signal readiness before failing. */
const READY_TIMEOUT_MS = 20_000

/**
 * Safety cap on a single RPC reply line (base64 downloads are the big ones).
 *
 * Derived from the child's download cap (host-main.ts MAX_DOWNLOAD_BYTES,
 * lowered to 64 MiB = 67,108,864 bytes by T1): the child ships the body as
 * base64 inside ONE JSON line, which inflates it by 4/3 —
 *   64 MiB * 4 / 3 = 67,108,864 * 4 / 3 = 89,478,485 bytes ≈ 85.33 MiB
 * — plus the JSON envelope and room for a base64 capture PNG. 128 MiB =
 * Downloads no longer cross this channel — the child writes them and reports a
 * byte count — so the largest replies left are screenshot payloads. The cap
 * still bounds what a pathological child can make the parent buffer.
 */
const MAX_RPC_BUFFER_BYTES = 128 * 1024 * 1024
/** Bounded RPC budgets prevent a dead child from wedging model-facing tools. */
const RPC_QUERY_TIMEOUT_MS = 8_000
const RPC_COMMAND_TIMEOUT_MS = 35_000
const RPC_TRANSFER_TIMEOUT_MS = 120_000

/**
 * A recycled Electron child can report document-ready before its compositor
 * owns a paintable surface. Delay only the first capture after self-healing.
 */
const RECOVERY_CAPTURE_SETTLE_MS = 3_000

/** Electron 43.x is known to trigger compositor faults in this host. */
const SUPPORTED_ELECTRON_VERSION = '42.9.3'

/**
 * CDP methods that must NOT be replayed onto a freshly materialized view. Input
 * dispatched at a blank document does nothing yet still resolves, so retrying it
 * after a host death reported success for a click that never happened.
 */
const UNREPLAYABLE_METHOD_PREFIX = 'Input.'

/**
 * Locate the one supported Electron binary. Candidates may come from the
 * plugin, DSH anchors, an explicit override, or pnpm stores, but only the
 * pinned version is admitted. A newer binary is not a safe substitute.
 */
function resolveElectronPath(): string {
  const require = createRequire(import.meta.url)
  const candidates: Array<{ version: string; path: string }> = []
  const add = (version: string | undefined, path: string | undefined): void => {
    if (version === undefined || path === undefined) return
    candidates.push({ version, path })
  }
  const addResolvedModule = (resolved: string): void => {
    const packageJson = join(dirname(resolved), 'package.json')
    add(packageVersion(packageJson) ?? versionOf(resolved), electronExeBeside(resolved))
  }

  // Prefer the package-local optional dependency when it is installed.
  try { addResolvedModule(require.resolve('electron')) } catch { /* continue probing */ }

  // An explicit path is admitted only after its package metadata verifies 42.9.3.
  const override = process.env.ELECTRON_PATH
  if (typeof override === 'string' && override.length > 0 && existsSync(override)) {
    add(versionOfElectronExecutable(override), override)
  }

  const anchors: string[] = []
  const globalPrefix = process.env.npm_config_prefix ?? process.env.PREFIX
  if (globalPrefix !== undefined) {
    anchors.push(join(globalPrefix, 'node_modules'))
    anchors.push(join(globalPrefix, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
  }
  if (process.env.DSH_HOME !== undefined) anchors.push(join(process.env.DSH_HOME, 'profiles', 'node_modules'))
  for (const anchor of anchors) {
    try { addResolvedModule(require.resolve('electron', { paths: [anchor] })) } catch { /* keep probing */ }
  }

  const roots = new Set<string>([
    fileURLToPath(new URL('.', import.meta.url)),
    process.cwd(),
    dirname(process.execPath),
  ])
  for (const root of roots) {
    let dir = root
    for (let depth = 0; depth < 8; depth++) {
      const store = join(dir, 'node_modules', '.pnpm')
      if (existsSync(store)) {
        for (const entry of readdirSync(store)) {
          if (!entry.startsWith('electron@')) continue
          const exe = electronDistExe(join(store, entry, 'node_modules', 'electron'))
          add(entry.slice('electron@'.length), exe)
        }
      }
      const parent = join(dir, '..')
      if (parent === dir) break
      dir = parent
    }
  }

  return selectSupportedElectronPath(candidates)
}

/**
 * Whether a usable Electron binary can be located right now. Cheap and local:
 * it only probes package metadata and the filesystem (no spawn, no network).
 * Exported with an injectable resolver so the failure branch stays testable
 * without uninstalling Electron.
 * @param resolve - the locator to probe; defaults to {@link resolveElectronPath}.
 */
export function probeElectronAvailability(resolve: () => string = resolveElectronPath): boolean {
  try {
    resolve()
    return true
  } catch {
    return false
  }
}

/** Select the one Electron version this plugin supports; exported for behavior tests. */
export function selectSupportedElectronPath(candidates: ReadonlyArray<{ version: string; path: string }>): string {
  const supported = candidates.find(candidate => candidate.version === SUPPORTED_ELECTRON_VERSION)
  if (supported !== undefined) return supported.path
  const available = [...new Set(candidates.map(candidate => candidate.version))].join(', ') || 'none'
  throw new Error(
    'dsh-browser-plus requires Electron ' + SUPPORTED_ELECTRON_VERSION +
    ' because Electron 43.x has a compositor fault; found: ' + available +
    '. Install the plugin optional dependency electron@' + SUPPORTED_ELECTRON_VERSION + ' or set ELECTRON_PATH to that binary.',
  )
}

function packageVersion(packageJson: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

function versionOfElectronExecutable(executable: string): string | undefined {
  return packageVersion(join(dirname(dirname(executable)), 'package.json')) ?? versionOf(executable)
}

/** Extract an electron version like "42.9.3" from a pnpm path. */
function versionOf(path: string): string | undefined {
  const match = /electron@(\d+\.\d+\.\d+)/.exec(path)
  return match?.[1]
}
/** From an electron package entry file, find the dist executable beside it. */
function electronExeBeside(entry: string): string | undefined {
  const candidates = [
    join(dirname(entry), 'dist', 'electron.exe'),
    join(dirname(entry), 'dist', 'electron'),
    join(dirname(entry), '..', 'dist', 'electron.exe'),
    join(dirname(entry), '..', 'dist', 'electron'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** From an electron package root, find its dist executable. */
function electronDistExe(pkgRoot: string): string | undefined {
  for (const candidate of [join(pkgRoot, 'dist', 'electron.exe'), join(pkgRoot, 'dist', 'electron')]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** dirname without importing node:path's dirname separately. */
function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  const j = p.lastIndexOf('\\')
  const k = Math.max(i, j)
  return k < 0 ? p : p.slice(0, k)
}

/**
 * Stable `error.code` for every rejection caused by the Electron child being
 * gone. DeferredRemoteView.withView retries on this code instead of
 * pattern-matching message text: a child can die in several ways — spawn
 * failure, exit, socket close, or a call made after it already died — and each
 * produces a different message.
 */
export const BROWSER_HOST_DEAD_CODE = 'BROWSER_HOST_DEAD'

/** Tag an error with {@link BROWSER_HOST_DEAD_CODE} without touching its message. */
function markBrowserHostDead<T extends Error>(error: T): T {
  const tagged = error as Error & { code?: string }
  tagged.code = BROWSER_HOST_DEAD_CODE
  return error
}

/** Build a dead-host error carrying the stable code. */
function browserHostDeadError(message: string): Error {
  return markBrowserHostDead(new Error(message))
}

/**
 * True when an error means the child is gone and ONE self-heal retry is
 * allowed. The stable code is authoritative; the message check is a legacy
 * backstop for errors raised outside ElectronChildClient (an externally
 * supplied host shim, or an older `Error` that only carries the old text), so
 * the pre-existing "browser host is not running" retry contract keeps working.
 */
export function isBrowserHostDead(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if ((error as { code?: unknown }).code === BROWSER_HOST_DEAD_CODE) return true
  return error.message.includes('browser host is not running')
}

/** One RPC round-trip with the child. */
interface Pending {
  resolve(result: unknown): void
  reject(err: Error): void
  readonly timer: ReturnType<typeof setTimeout>
}

/** Spawn arguments for the User-Agent masking options. */
function fingerprintArgs(options: { readonly userAgent?: string; readonly maskAutomation?: boolean }): string[] {
  return [
    ...options.maskAutomation === false ? ['--no-mask-automation'] : [],
    ...options.userAgent === undefined ? [] : ['--user-agent', options.userAgent],
  ]
}

/**
 * Line-delimited JSON-RPC client over a local TCP socket. Electron's main
 * process on Windows does not receive piped stdin, so the parent listens on a
 * loopback port and passes it to the child via `--rpc-port`; the child
 * connects back and speaks the same one-JSON-per-line protocol.
 */
class ElectronChildClient {
  private readonly child: ChildProcessByStdio<null, import('node:stream').Readable, import('node:stream').Readable>
  private readonly pending = new Map<number, Pending>()
  private readonly chromeWorld: 'main' | 'isolated' | undefined
  private readonly fingerprintArgs: readonly string[]
  /**
   * Receives messages the child sends without a request id. Today that is only
   * the chrome's own tab requests, raised when a human clicks the injected
   * toolbar; a reply always carries the id of the call it answers.
   */
  private onEvent: ((event: unknown) => void) | undefined
  private nextId = 1
  private buffer = ''
  private socket: import('node:net').Socket | undefined
  private connected = false
  private outbox: string[] = []
  /** Set once the child has exited; further calls fail fast instead of queueing. */
  private dead = false

  constructor(
    private readonly hostMainPath: string,
    private readonly port: number,
    private readonly onExit?: () => void,
    chromeWorld?: 'main' | 'isolated',
    fingerprintArgs: readonly string[] = [],
  ) {
    this.chromeWorld = chromeWorld
    this.fingerprintArgs = fingerprintArgs
    const electron = resolveElectronPath()
    process.stderr.write(`[dsh-browser-plus host] spawning electron: ${electron}\n`)
    // ELECTRON_RUN_AS_NODE (even an empty string) makes Electron run as plain
    // Node, breaking require('electron'); NODE_OPTIONS can inject flags that
    // break the child. Rebuild the env without either.
    const env: Record<string, string | undefined> = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    // The chrome's world is the child's choice, so it travels as an argument.
    const childArgs = [
      ...this.chromeWorld === 'isolated' ? ['--chrome-world', 'isolated'] : [],
      ...this.fingerprintArgs,
    ]
    this.child = spawn(electron, [hostMainPath, '--rpc-port', String(port), ...childArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
      env,
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => {
      // Diagnostics only; never parse stderr as protocol.
      process.stderr.write(`[dsh-browser-plus host] ${String(chunk)}`)
    })
    // A failed spawn (bad/corrupt binary) emits 'error' — without a listener
    // that would crash the whole DSH process.
    this.child.on('error', error => {
      process.stderr.write(`[dsh-browser-plus host] spawn error: ${String(error)}\n`)
      this.fail(new Error(`dsh-browser-plus: browser host failed to start: ${String(error)}`))
    })
    this.child.on('exit', (code, signal) => {
      this.fail(new Error(`dsh-browser-plus: browser host exited (code=${String(code)} signal=${String(signal)})`))
    })
  }

  /** Route unsolicited child messages (see {@link onEvent}). */
  setEventListener(listener: (event: unknown) => void): void {
    this.onEvent = listener
  }

  /** Reject everything in flight, mark the client dead, and notify the host. */
  private fail(err: Error): void {
    if (this.dead) return
    this.dead = true
    this.connected = false
    // Everything rejected from here on means "this child is gone": tag it with
    // the stable code so withView can self-heal without matching message text.
    // Covers all three death paths that funnel through fail(): child 'exit',
    // child 'error' (spawn failure), and socket 'close'.
    markBrowserHostDead(err)
    for (const pending of this.pending.values()) pending.reject(err)
    this.pending.clear()
    this.outbox = []
    this.onExit?.()
  }

  /** Accept the child's connection (called by the server). */
  attach(socket: import('node:net').Socket): void {
    this.socket = socket
    this.connected = true
    socket.setEncoding('utf8')
    // Without an 'error' listener a remote reset (ECONNRESET/EPIPE) throws an
    // uncaught 'error' event and crashes the whole DSH process; 'close' below
    // does the cleanup.
    socket.on('error', error => {
      process.stderr.write(`[dsh-browser-plus host] socket error: ${String(error)}\n`)
    })
    socket.on('data', chunk => this.onData(chunk))
    socket.on('close', () => {
      this.connected = false
      if (!this.dead) {
        this.fail(new Error('dsh-browser-plus: browser host connection closed'))
      }
    })
    // Flush anything queued while disconnected.
    if (this.outbox.length > 0) {
      for (const line of this.outbox) socket.write(line + '\n')
      this.outbox = []
    }
  }

  private onData(chunk: string | Buffer): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    // Safety net: a pathological child (or a reply larger than expected)
    // must not grow the parent's memory without bound. The child caps
    // downloads at 64 MiB (see MAX_RPC_BUFFER_BYTES), so a healthy stream
    // never approaches this.
    if (this.buffer.length > MAX_RPC_BUFFER_BYTES) {
      this.buffer = ''
      this.fail(new Error(`dsh-browser-plus: RPC reply exceeded ${MAX_RPC_BUFFER_BYTES} bytes`))
      return
    }
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (line === '') continue
      let msg: { id?: number; ok?: boolean; result?: unknown; err?: string; event?: unknown; action?: unknown }
      try {
        msg = JSON.parse(line) as typeof msg
      } catch {
        // Non-protocol line; ignore.
        continue
      }
      if (typeof msg.id !== 'number') {
        // The child speaks first only for chrome-originated tab requests. A
        // listener that throws must not kill the socket, and an unknown event
        // name is ignored like any other non-protocol line.
        if (msg.event === 'chrome' && this.onEvent !== undefined) {
          try {
            this.onEvent(msg.action)
          } catch { /* listener's problem, not the stream's */ }
        }
        continue
      }
      const pending = this.pending.get(msg.id)
      if (pending === undefined) continue
      this.pending.delete(msg.id)
      if (msg.ok === true) pending.resolve(msg.result)
      else pending.reject(new Error(msg.err ?? 'browser host command failed'))
    }
  }

  /** Send one bounded command and await the reply. */
  call<T = unknown>(op: string, payload: Record<string, unknown> = {}, timeoutMs = RPC_COMMAND_TIMEOUT_MS): Promise<T> {
    if (this.dead) {
      // Death path 1: called after the child already died. Message kept for
      // diagnostics; the code is what withView keys on.
      return Promise.reject(browserHostDeadError('dsh-browser-plus: browser host is not running'))
    }
    const id = this.nextId++
    const line = JSON.stringify({ id, op, ...payload })
    return new Promise<T>((resolve, reject) => {
      const settle = <TValue>(callback: (value: TValue) => void, value: TValue): void => {
        clearTimeout(timer)
        callback(value)
      }
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (pending === undefined) return
        this.pending.delete(id)
        this.outbox = this.outbox.filter(queued => queued !== line)
        const error = new Error('dsh-browser-plus: RPC ' + op + ' timed out after ' + String(timeoutMs) + 'ms')
        pending.reject(error)
        // A child that stopped answering cannot safely serve later operations.
        // Tear it down so the next call follows the existing self-heal path.
        // fail() tags `error` with the dead code, so the timed-out call is
        // retried once against the freshly started child (the provider's own
        // deadlines bound the worst case) and the other in-flight calls, which
        // never got to run, recover the same way.
        this.fail(error)
        try { this.child.kill() } catch { /* already exited */ }
      }, timeoutMs)
      this.pending.set(id, {
        timer,
        resolve: result => settle(resolve, result as T),
        reject: error => settle(reject, error),
      })
      if (this.connected && this.socket !== undefined) {
        this.socket.write(line + '\n')
      } else {
        // Not connected yet: queue; attach() flushes on the child's arrival.
        this.outbox.push(line)
      }
    })
  }

  /** Terminate the child and its loopback connection. */
  kill(): void {
    try { this.socket?.destroy() } catch { /* already closed */ }
    try { this.child.kill() } catch { /* already exited */ }
  }
}

/** One view in the child: its id, used for every command. */
class RemoteView implements ElectronViewHandle {
  constructor(readonly id: string, private readonly client: ElectronChildClient) {}

  sendCommand(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.client.call<Record<string, unknown>>('command', {
      viewId: this.id,
      method,
      params: params ?? {},
    }, RPC_COMMAND_TIMEOUT_MS)
  }

  /** Ask the child to download a URL to a local file (keeps cookies/login). */
  async download(url: string, savePath: string): Promise<void> {
    // The child writes the file and reports its size, so the body never crosses
    // the RPC socket.
    await this.client.call<{ bytes: number }>('download', { viewId: this.id, url, savePath }, RPC_TRANSFER_TIMEOUT_MS)
  }

  /** Native capturePage snapshot of the view (PNG base64 + size). */
  capture(): Promise<{ base64: string; width: number; height: number }> {
    return this.client.call<{ base64: string; width: number; height: number }>('capture', { viewId: this.id }, RPC_TRANSFER_TIMEOUT_MS)
  }

  /** Export the session's cookies (login state). */
  flushAuth(): Promise<ExportedCookie[]> {
    return this.client.call<{ cookies: ExportedCookie[] }>('flushAuth', { viewId: this.id }, RPC_COMMAND_TIMEOUT_MS).then(r => r.cookies)
  }

  /** Import cookies into the session (restore login state). */
  restoreAuth(cookies: ExportedCookie[]): Promise<number> {
    return this.client.call<{ restored: number }>('restoreAuth', { viewId: this.id, cookies }, RPC_COMMAND_TIMEOUT_MS).then(r => r.restored)
  }

  /** Remove cookies matching a site scope (stale challenge generations, logout). */
  clearCookies(filter: { domain?: string; name?: string; all?: boolean }): Promise<{ removed: number; names: string[] }> {
    return this.client.call<{ removed: number; names: string[] }>('clearCookies', {
      viewId: this.id,
      ...filter.domain !== undefined ? { domain: filter.domain } : {},
      ...filter.name !== undefined ? { name: filter.name } : {},
      ...filter.all === true ? { all: true } : {},
    }, RPC_COMMAND_TIMEOUT_MS)
  }

  /** Read (and clear) the most recent auto-accepted JS dialog for the view. */
  async clearDialog(): Promise<unknown> {
    // client.call resolves the host's reply result directly (no wrapper), so
    // the dialog object arrives as-is; a null reply means nothing was raised.
    return this.client.call<unknown>('drainDialog', { viewId: this.id }, RPC_QUERY_TIMEOUT_MS)
  }

  /** Tell the child how to answer the next JS dialog on this view. */
  async setDialogPolicy(policy: { behavior: 'accept' | 'dismiss'; promptText?: string }): Promise<unknown> {
    return this.client.call<unknown>('setDialogPolicy', {
      viewId: this.id,
      behavior: policy.behavior,
      ...policy.promptText === undefined ? {} : { promptText: policy.promptText },
    }, RPC_QUERY_TIMEOUT_MS)
  }

  /** Ask the child to re-apply its token-aware chrome to the current document. */
  async reinstallChrome(): Promise<void> {
    await this.client.call('reinstallChrome', { viewId: this.id }, RPC_COMMAND_TIMEOUT_MS)
  }

  /** Set this view's browser-task label; selected task controls the shared title. */
  async label(label: string): Promise<void> {
    await this.client.call('label', { viewId: this.id, label }, RPC_COMMAND_TIMEOUT_MS)
  }
}

/**
 * Self-hosted view host: spawns the plugin's Electron child on first use and
 * keeps it alive until dispose(). Fallback when no desktop shell provides
 * ctx.electronViewHost.
 */
export class RemoteElectronViewHost implements ElectronBrowserViewHost {
  private client: ElectronChildClient | undefined
  private server: Server | undefined
  private pendingSocket: Socket | undefined
  private readonly views = new Map<string, ElectronViewHandle>()
  private readyPromise: Promise<void> | undefined
  private disposed = false
  /** Cached local-backend probe; locating Electron walks the filesystem. */
  private availableProbe: boolean | undefined
  /** Chrome listener; re-attached to every child this host spawns. */
  private chromeEventListener: ((event: ChromeHostEvent) => void) | undefined

  /**
   * @param hostMainPath - the child entry script.
   * @param options - `chromeWorld: 'isolated'` runs the injected chrome in its
   *   own JavaScript world, so visited pages cannot read its state or its
   *   binding token. `maskAutomation: false` leaves Electron's own User-Agent
   *   alone, and `userAgent` replaces it outright. Defaults to the proven
   *   main-world path with the automation fingerprint masked.
   */
  constructor(
    private readonly hostMainPath: string,
    private readonly options: {
      readonly chromeWorld?: 'main' | 'isolated'
      readonly userAgent?: string
      readonly maskAutomation?: boolean
    } = {},
  ) {}

  /**
   * Cheap local usability probe, consulted by the provider's `available()`.
   * Without it the provider reports itself usable unconditionally, so a missing
   * Electron binary would surface only on the first browser tool call instead of
   * at provider-selection time.
   */
  isAvailable(): boolean {
    this.availableProbe ??= probeElectronAvailability()
    return this.availableProbe
  }

  /**
   * Forward the child's chrome tab requests to the provider.
   *
   * The child is respawned after a crash, so the listener is kept here and
   * re-attached to each new client rather than handed to one client instance.
   */
  onChromeEvent(listener: (event: ChromeHostEvent) => void): void {
    this.chromeEventListener = listener
    this.client?.setEventListener(event => this.dispatchChromeEvent(event))
  }

  /**
   * Validate one child-raised action before it reaches the provider.
   *
   * The child is trusted (it is our own process), but a malformed or truncated
   * line must still not reach the tab model as a half-built request.
   */
  private dispatchChromeEvent(event: unknown): void {
    const listener = this.chromeEventListener
    if (listener === undefined) return
    if (typeof event !== 'object' || event === null || Array.isArray(event)) return
    const record = event as { type?: unknown; taskKey?: unknown; tabId?: unknown; toIndex?: unknown; url?: unknown }
    const type = record.type
    if (type !== 'new-tab' && type !== 'close-tab' && type !== 'activate-tab' && type !== 'move-tab') return
    if (typeof record.taskKey !== 'string' || record.taskKey === '') return
    listener({
      type,
      taskKey: record.taskKey,
      ...typeof record.tabId === 'string' ? { tabId: record.tabId } : {},
      // Drag-to-reorder: the index the tab was dropped at, after removal.
      ...type === 'move-tab' && typeof record.toIndex === 'number' ? { toIndex: record.toIndex } : {},
      // 点收藏来的新标签带着 url：这里也是**重建**事件的地方，漏一个字段它就被静默丢掉。
      ...type === 'new-tab' && typeof record.url === 'string' && /^https?:[/][/]/i.test(record.url) ? { url: record.url } : {},
    })
  }

  /** Ensure the child is up and ready (lazy on first use; restarts after a crash). */
  private ready(): Promise<void> {
    // The one case that must NOT self-heal: a disposed host is shutting down
    // with its fiber, so respawning here (a late call, or a withView retry)
    // would leave an orphaned Electron process. This error carries no dead
    // code on purpose.
    if (this.disposed) {
      return Promise.reject(new Error('dsh-browser-plus: browser host is disposed'))
    }
    if (this.readyPromise !== undefined) return this.readyPromise
    const started = this.start()
    const wrapped = started.catch(error => {
      // A failed startup must not poison the host forever: tear down whatever
      // was half-created and let the next call retry from scratch.
      if (this.readyPromise === wrapped) {
        this.readyPromise = undefined
        this.client?.kill()
        this.client = undefined
        this.server?.close()
        this.server = undefined
        this.pendingSocket = undefined
      }
      throw error
    })
    this.readyPromise = wrapped
    return wrapped
  }

  private async start(): Promise<void> {
    // Listen on an ephemeral loopback port; the child connects back.
    const server = createServer(socket => {
      if (this.client !== undefined) this.client.attach(socket)
      else this.pendingSocket = socket
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    // A later server error (rare on a loopback ephemeral port) must not crash
    // the process; the client's fail path handles the actual recovery.
    server.on('error', error => {
      process.stderr.write(`[dsh-browser-plus host] rpc server error: ${String(error)}\n`)
    })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    this.server = server
    this.client = new ElectronChildClient(
      this.hostMainPath,
      port,
      () => this.onChildExit(),
      this.options.chromeWorld,
      fingerprintArgs(this.options),
    )
    this.client.setEventListener(event => this.dispatchChromeEvent(event))
    if (this.pendingSocket !== undefined) {
      this.client.attach(this.pendingSocket)
      this.pendingSocket = undefined
    }
    // Wait for the child's connection + readiness ping.
    await withTimeout(this.client.call('ping', {}, RPC_QUERY_TIMEOUT_MS), READY_TIMEOUT_MS, 'browser host did not become ready')
  }

  /** The child died: tear down so the next use starts a fresh child. */
  private onChildExit(): void {
    if (this.disposed) return
    this.client = undefined
    this.server?.close()
    this.server = undefined
    this.pendingSocket = undefined
    this.readyPromise = undefined
    // Keep the views map: handles still resolve to ids; a fresh child simply
    // has no such views yet, and reset_session reopens clean sessions.
  }

  createView(key?: string, label?: string): ElectronViewHandle {
    // The seam is synchronous; the provider uses the handle immediately, so
    // commands are deferred until the child is up and the view materialized.
    const id = `view:${Math.random().toString(36).slice(2, 10)}`
    const view = new DeferredRemoteView(id, label, currentLabel => this.ensureView(id, key, currentLabel))
    this.views.set(id, view)
    return view
  }

  private async ensureView(id: string, key?: string, label?: string): Promise<RemoteView> {
    await this.ready()
    const client = this.client
    // Death path 5: ready() resolved but the child died before this read (a
    // narrow race) — or the host was disposed, which ready() above already
    // rejects. Tag it dead so withView retries once against a fresh child;
    // materialization itself is safe to repeat because createView never ran.
    if (client === undefined) throw browserHostDeadError('browser host unavailable')
    await client.call('createView', {
      viewId: id,
      ...key !== undefined ? { key } : {},
      ...label !== undefined ? { label } : {},
    })
    // If the view was destroyed while the createView RPC was in flight, do
    // not re-insert a stale entry that would resurrect a dead child view.
    if (this.views.get(id) === undefined) {
      throw new Error('browser: view destroyed while starting')
    }
    const view = new RemoteView(id, client)
    this.views.set(id, view)
    return view
  }

  /**
   * Send a CDP `Input.*` command to the host's chrome frame view.
   *
   * The frame is not a tab, so it has no view handle: this is a direct channel to
   * it, used to drive the toolbar (the click tests, and anything that needs to
   * exercise the chrome the way a human does).
   */
  async chromeInput(method: string, params: Record<string, unknown> = {}): Promise<void> {
    await this.ready()
    await this.client?.call('chromeInput', { method, params })
  }

  /**
   * Evaluate an expression inside the chrome frame's document and return its value.
   *
   * The frame is not a tab, so nothing that targets the page can read it — without
   * this, the toolbar's own animations could only be inferred from whatever the
   * page's copy of the chrome logged. Used to assert the frame's motion directly.
   */
  async chromeEval(expression: string): Promise<unknown> {
    await this.ready()
    // call() already unwraps the reply's `result` field.
    return await this.client?.call('chromeEval', { expression })
  }

  showView(handle: ElectronViewHandle): void {
    // Fire-and-forget by design (visibility is best-effort), but a rejected
    // promise must not become an unhandled rejection (crash on Node >= 15).
    //
    // Materialize BEFORE showing. createView is what tells the child the view
    // exists, and it is sent lazily on first use; showView used to race ahead
    // of it, so the child threw "unknown view", this catch swallowed it, and a
    // brand-new tab's view was never made visible -- while createView had
    // already marked it active. The result was a tab that could not be shown
    // and, through the activeViewChanged guard, could not be switched to.
    void this.ready()
      .then(async () => {
        if (handle instanceof DeferredRemoteView) await handle.materializeForShow()
        await this.client?.call('showView', { viewId: handle.id })
      })
      .catch(() => { /* host unavailable */ })
  }

  destroyView(handle: ElectronViewHandle): void {
    const view = this.views.get(handle.id)
    if (view === undefined) return
    this.views.delete(handle.id)
    void this.ready()
      .then(() => this.client?.call('destroyView', { viewId: handle.id }))
      .catch(() => { /* child already gone */ })
  }
  /** Append one operation to the child's per-view trail. */
  trace(viewId: string, entry: unknown): void {
    void this.ready()
      .then(() => this.client?.call('trace', { viewId, entry }))
      .catch(() => { /* child gone */ })
  }

  /** List browser task keys with labels (legacy RPC name retained for compatibility). */
  async listWindows(): Promise<Array<{ key: string; label: string }>> {
    await this.ready()
    const client = this.client
    if (client === undefined) throw new Error('browser host unavailable')
    const r = await client.call<{ windows: Array<{ key: string; label: string }> }>('listWindows', {}, RPC_QUERY_TIMEOUT_MS)
    return r.windows
  }

  /** List task summaries from the self-hosted visible workspace. */
  async listTasks(): Promise<readonly BrowserTaskInfo[]> {
    await this.ready()
    const client = this.client
    if (client === undefined) throw new Error('browser host unavailable')
    const result = await client.call<{ tasks: BrowserTaskInfo[] }>('listTasks', {}, RPC_QUERY_TIMEOUT_MS)
    return result.tasks
  }

  /** Read one task summary from the self-hosted visible workspace. */
  async getTask(key: string): Promise<BrowserTaskInfo | undefined> {
    await this.ready()
    const client = this.client
    if (client === undefined) throw new Error('browser host unavailable')
    const result = await client.call<{ task: BrowserTaskInfo | null }>('getTask', { key }, RPC_QUERY_TIMEOUT_MS)
    return result.task ?? undefined
  }

  /** Update one task summary in the self-hosted visible workspace. */
  async updateTask(key: string, task: BrowserTaskUpdate): Promise<BrowserTaskInfo | undefined> {
    await this.ready()
    const client = this.client
    if (client === undefined) throw new Error('browser host unavailable')
    const result = await client.call<{ task: BrowserTaskInfo | null }>('updateTask', { key, task }, RPC_QUERY_TIMEOUT_MS)
    return result.task ?? undefined
  }

  /** Shut the child and the RPC server down. */
  dispose(): void {
    this.disposed = true
    this.client?.kill()
    this.client = undefined
    this.server?.close()
    this.server = undefined
    this.readyPromise = undefined
    this.views.clear()
  }
}

/** @internal Deferred view recovery handle; exported for focused behavior tests. */
export class DeferredRemoteView implements ElectronViewHandle {
  private materialized: Promise<RemoteView> | undefined
  private recoveryCompositorSettle: Promise<void> | undefined
  private taskLabel: string | undefined
  private labelRevision = 0

  constructor(
    readonly id: string,
    label: string | undefined,
    private readonly materialize: (label: string | undefined) => Promise<RemoteView>,
  ) {
    this.taskLabel = label
  }

  /**
   * Materialize once and cache: every sendCommand on the same handle must
   * target the SAME child view (re-materializing would re-run createView and
   * duplicate the view). A FAILED materialization is reset so a later call
   * (e.g. after the host restarted) can retry instead of being poisoned.
   */
    /**
     * Make sure the child knows this view exists. showView needs this: without
     * it the showView RPC can reach the child before createView does, and the
     * child then throws "unknown view" while the caller swallows the error.
     */
    async materializeForShow(): Promise<void> { await this.materializeOnce() }

  private materializeOnce(): Promise<RemoteView> {
    if (this.materialized === undefined) {
      const pending = this.materialize(this.taskLabel)
      this.materialized = pending.catch(error => {
        if (this.materialized === pending) this.materialized = undefined
        throw error
      })
    }
    return this.materialized
  }

  private scheduleRecoveredCompositorSettle(): void {
    this.recoveryCompositorSettle = new Promise<void>(resolve => {
      setTimeout(resolve, RECOVERY_CAPTURE_SETTLE_MS)
    })
  }

  /** Wait for a recovered child to acquire a paintable compositor surface. */
  private async settleRecoveredCompositorForCapture(): Promise<void> {
    // A second recovery can happen while a prior settle delay is resolving.
    while (this.recoveryCompositorSettle !== undefined) {
      const settle = this.recoveryCompositorSettle
      await settle
      if (this.recoveryCompositorSettle === settle) {
        this.recoveryCompositorSettle = undefined
        return
      }
    }
  }

  /**
   * Run an operation against the materialized view, with ONE self-heal
   * retry: if the child died while this handle was cached (host restart or a
   * recycle), dropping the cached materialization and re-materializing
   * creates a fresh child view for the same session handle, so a session
   * survives a host crash/recycle without a manual reset.
   */
  private async withView<T>(
    run: (view: RemoteView) => Promise<T>,
    afterRecovery?: () => Promise<void>,
    method?: string,
  ): Promise<T> {
    try {
      return await run(await this.materializeOnce())
    } catch (error) {
      // Judge by the stable code (see isBrowserHostDead), not by message text:
      // a mid-call exit, spawn failure, or socket close used to escape this
      // check because their messages differ from the dead early-exit's.
      if (!isBrowserHostDead(error)) throw error
      if (method !== undefined && method.startsWith(UNREPLAYABLE_METHOD_PREFIX)) {
        // Re-materializing yields an about:blank view, so replaying input would
        // act on an empty document and still report success. Name the loss.
        throw new BrowserError(
          `browser: the browser host restarted and the page was lost before ${method}; reopen the page and retry`,
          'BROWSER_HOST_RESTARTED',
        )
      }
      // Stale child: forget the cached view, then re-create a fresh pair.
      this.materialized = undefined
      const view = await this.materializeOnce()
      this.scheduleRecoveredCompositorSettle()
      await afterRecovery?.()
      return run(view)
    }
  }

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const settle = method === 'Page.captureScreenshot'
      ? () => this.settleRecoveredCompositorForCapture()
      : undefined
    await settle?.()
    return this.withView(view => view.sendCommand(method, params), settle, method)
  }

  async download(url: string, savePath: string): Promise<void> {
    return this.withView(view => view.download(url, savePath))
  }

  async capture(): Promise<{ base64: string; width: number; height: number }> {
    await this.settleRecoveredCompositorForCapture()
    return this.withView(view => view.capture(), () => this.settleRecoveredCompositorForCapture())
  }

  async flushAuth(): Promise<ExportedCookie[]> {
    return this.withView(view => view.flushAuth())
  }

  async restoreAuth(cookies: ExportedCookie[]): Promise<number> {
    return this.withView(view => view.restoreAuth(cookies))
  }

  async clearCookies(filter: { domain?: string; name?: string; all?: boolean }): Promise<{ removed: number; names: string[] }> {
    return this.withView(view => view.clearCookies(filter))
  }

  async clearDialog(): Promise<unknown> {
    return this.withView(view => view.clearDialog())
  }

  async setDialogPolicy(policy: { behavior: 'accept' | 'dismiss'; promptText?: string }): Promise<unknown> {
    return this.withView(view => view.setDialogPolicy(policy))
  }

  async reinstallChrome(): Promise<void> {
    return this.withView(view => view.reinstallChrome())
  }

  async label(label: string): Promise<void> {
    const previousLabel = this.taskLabel
    const revision = ++this.labelRevision
    this.taskLabel = label
    try {
      await this.withView(view => view.label(label))
    } catch (error) {
      if (this.labelRevision === revision) this.taskLabel = previousLabel
      throw error
    }
  }
}

/** Reject a promise if it does not settle within the budget. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${message} (${ms}ms)`)), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/** Default host-main path relative to this module's build output. */
export function defaultHostMainPath(): string {
  return fileURLToPath(new URL('./host-main.js', import.meta.url))
}
