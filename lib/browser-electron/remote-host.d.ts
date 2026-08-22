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
import type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.ts';
import type { ExportedCookie } from '../browser/types.ts';
/**
 * Line-delimited JSON-RPC client over a local TCP socket. Electron's main
 * process on Windows does not receive piped stdin, so the parent listens on a
 * loopback port and passes it to the child via `--rpc-port`; the child
 * connects back and speaks the same one-JSON-per-line protocol.
 */
declare class ElectronChildClient {
    private readonly hostMainPath;
    private readonly port;
    private readonly onExit?;
    private readonly child;
    private readonly pending;
    private nextId;
    private buffer;
    private socket;
    private connected;
    private outbox;
    /** Set once the child has exited; further calls fail fast instead of queueing. */
    private dead;
    constructor(hostMainPath: string, port: number, onExit?: (() => void) | undefined);
    /** Reject everything in flight, mark the client dead, and notify the host. */
    private fail;
    /** Accept the child's connection (called by the server). */
    attach(socket: import('node:net').Socket): void;
    private onData;
    /** Send one command and await the reply. */
    call<T = unknown>(op: string, payload?: Record<string, unknown>): Promise<T>;
    /** Terminate the child. */
    kill(): void;
}
/** One view in the child: its id, used for every command. */
declare class RemoteView implements ElectronViewHandle {
    readonly id: string;
    private readonly client;
    constructor(id: string, client: ElectronChildClient);
    sendCommand(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
    /** Ask the child to download a URL to a local file (keeps cookies/login). */
    download(url: string, savePath: string): Promise<void>;
    /** Native capturePage snapshot of the view (PNG base64 + size). */
    capture(): Promise<{
        base64: string;
        width: number;
        height: number;
    }>;
    /** Export the session's cookies (login state). */
    flushAuth(): Promise<ExportedCookie[]>;
    /** Import cookies into the session (restore login state). */
    restoreAuth(cookies: ExportedCookie[]): Promise<number>;
    /** Read (and clear) the most recent auto-accepted JS dialog for the view. */
    clearDialog(): Promise<unknown>;
    /** Set this view's browser-task label; selected task controls the shared title. */
    label(label: string): Promise<void>;
}
/**
 * Self-hosted view host: spawns the plugin's Electron child on first use and
 * keeps it alive until dispose(). Fallback when no desktop shell provides
 * ctx.electronViewHost.
 */
export declare class RemoteElectronViewHost implements ElectronBrowserViewHost {
    private readonly hostMainPath;
    private client;
    private server;
    private pendingSocket;
    private readonly views;
    private readyPromise;
    private disposed;
    constructor(hostMainPath: string);
    /** Ensure the child is up and ready (lazy on first use; restarts after a crash). */
    private ready;
    private start;
    /** The child died: tear down so the next use starts a fresh child. */
    private onChildExit;
    createView(key?: string, label?: string): ElectronViewHandle;
    private ensureView;
    showView(handle: ElectronViewHandle): void;
    destroyView(handle: ElectronViewHandle): void;
    /** Append one operation to the child's per-view trail. */
    trace(viewId: string, entry: unknown): void;
    /** List browser task keys with labels (legacy RPC name retained for compatibility). */
    listWindows(): Promise<Array<{
        key: string;
        label: string;
    }>>;
    /** Shut the child and the RPC server down. */
    dispose(): void;
}
/** @internal Deferred view recovery handle; exported for focused behavior tests. */
export declare class DeferredRemoteView implements ElectronViewHandle {
    readonly id: string;
    private readonly materialize;
    private materialized;
    private recoveryCompositorSettle;
    private taskLabel;
    private labelRevision;
    constructor(id: string, label: string | undefined, materialize: (label: string | undefined) => Promise<RemoteView>);
    /**
     * Materialize once and cache: every sendCommand on the same handle must
     * target the SAME child view (re-materializing would re-run createView and
     * duplicate the view). A FAILED materialization is reset so a later call
     * (e.g. after the host restarted) can retry instead of being poisoned.
     */
    private materializeOnce;
    private scheduleRecoveredCompositorSettle;
    /** Wait for a recovered child to acquire a paintable compositor surface. */
    private settleRecoveredCompositorForCapture;
    /**
     * Run an operation against the materialized view, with ONE self-heal
     * retry: if the child died while this handle was cached (host restart or a
     * recycle), dropping the cached materialization and re-materializing
     * creates a fresh child view for the same session handle, so a session
     * survives a host crash/recycle without a manual reset.
     */
    private withView;
    sendCommand(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
    download(url: string, savePath: string): Promise<void>;
    capture(): Promise<{
        base64: string;
        width: number;
        height: number;
    }>;
    flushAuth(): Promise<ExportedCookie[]>;
    restoreAuth(cookies: ExportedCookie[]): Promise<number>;
    clearDialog(): Promise<unknown>;
    label(label: string): Promise<void>;
}
/** Default host-main path relative to this module's build output. */
export declare function defaultHostMainPath(): string;
export {};
