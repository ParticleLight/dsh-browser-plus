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
import type { ChromeHostEvent, ElectronBrowserViewHost, ElectronViewHandle } from './provider.ts';
import type { BrowserTaskInfo, BrowserTaskUpdate } from '../browser/types.ts';
/**
 * Whether a usable Electron binary can be located right now. Cheap and local:
 * it only probes package metadata and the filesystem (no spawn, no network).
 * Exported with an injectable resolver so the failure branch stays testable
 * without uninstalling Electron.
 * @param resolve - the locator to probe; defaults to {@link resolveElectronPath}.
 */
export declare function probeElectronAvailability(resolve?: () => string): boolean;
/** Select the one Electron version this plugin supports; exported for behavior tests. */
export declare function selectSupportedElectronPath(candidates: ReadonlyArray<{
    version: string;
    path: string;
}>): string;
/**
 * Stable `error.code` for every rejection caused by the Electron child being
 * gone. DeferredRemoteView.withView retries on this code instead of
 * pattern-matching message text: a child can die in several ways — spawn
 * failure, exit, socket close, or a call made after it already died — and each
 * produces a different message.
 */
export declare const BROWSER_HOST_DEAD_CODE = "BROWSER_HOST_DEAD";
/**
 * True when an error means the child is gone and ONE self-heal retry is
 * allowed. The stable code is authoritative; the message check is a legacy
 * backstop for errors raised outside ElectronChildClient (an externally
 * supplied host shim, or an older `Error` that only carries the old text), so
 * the pre-existing "browser host is not running" retry contract keeps working.
 */
export declare function isBrowserHostDead(error: unknown): boolean;
/**
 * Self-hosted view host: spawns the plugin's Electron child on first use and
 * keeps it alive until dispose(). Fallback when no desktop shell provides
 * ctx.electronViewHost.
 */
export declare class RemoteElectronViewHost implements ElectronBrowserViewHost {
    private readonly hostMainPath;
    private readonly options;
    private client;
    private server;
    private pendingSocket;
    private readonly views;
    private readyPromise;
    private disposed;
    /** Cached local-backend probe; locating Electron walks the filesystem. */
    private availableProbe;
    /** Chrome listener; re-attached to every child this host spawns. */
    private chromeEventListener;
    /**
     * @param hostMainPath - the child entry script.
     * @param options - `chromeWorld: 'isolated'` runs the injected chrome in its
     *   own JavaScript world, so visited pages cannot read its state or its
     *   binding token. `maskAutomation: false` leaves Electron's own User-Agent
     *   alone, and `userAgent` replaces it outright. Defaults to the proven
     *   main-world path with the automation fingerprint masked.
     */
    constructor(hostMainPath: string, options?: {
        readonly chromeWorld?: 'main' | 'isolated';
        readonly userAgent?: string;
        readonly maskAutomation?: boolean;
    });
    /**
     * Cheap local usability probe, consulted by the provider's `available()`.
     * Without it the provider reports itself usable unconditionally, so a missing
     * Electron binary would surface only on the first browser tool call instead of
     * at provider-selection time.
     */
    isAvailable(): boolean;
    /**
     * Forward the child's chrome tab requests to the provider.
     *
     * The child is respawned after a crash, so the listener is kept here and
     * re-attached to each new client rather than handed to one client instance.
     */
    onChromeEvent(listener: (event: ChromeHostEvent) => void): void;
    /**
     * Validate one child-raised action before it reaches the provider.
     *
     * The child is trusted (it is our own process), but a malformed or truncated
     * line must still not reach the tab model as a half-built request.
     */
    private dispatchChromeEvent;
    /** Ensure the child is up and ready (lazy on first use; restarts after a crash). */
    private ready;
    private start;
    /** The child died: tear down so the next use starts a fresh child. */
    private onChildExit;
    createView(key?: string, label?: string): ElectronViewHandle;
    private ensureView;
    /**
     * Send a CDP `Input.*` command to the host's chrome frame view.
     *
     * The frame is not a tab, so it has no view handle: this is a direct channel to
     * it, used to drive the toolbar (the click tests, and anything that needs to
     * exercise the chrome the way a human does).
     */
    chromeInput(method: string, params?: Record<string, unknown>): Promise<void>;
    /**
     * Evaluate an expression inside the chrome frame's document and return its value.
     *
     * The frame is not a tab, so nothing that targets the page can read it — without
     * this, the toolbar's own animations could only be inferred from whatever the
     * page's copy of the chrome logged. Used to assert the frame's motion directly.
     */
    chromeEval(expression: string): Promise<unknown>;
    showView(handle: ElectronViewHandle): void;
    destroyView(handle: ElectronViewHandle): void;
    /** Append one operation to the child's per-view trail. */
    trace(viewId: string, entry: unknown): void;
    /** List browser task keys with labels (legacy RPC name retained for compatibility). */
    listWindows(): Promise<Array<{
        key: string;
        label: string;
    }>>;
    /** List task summaries from the self-hosted visible workspace. */
    listTasks(): Promise<readonly BrowserTaskInfo[]>;
    /** Read one task summary from the self-hosted visible workspace. */
    getTask(key: string): Promise<BrowserTaskInfo | undefined>;
    /** Update one task summary in the self-hosted visible workspace. */
    updateTask(key: string, task: BrowserTaskUpdate): Promise<BrowserTaskInfo | undefined>;
    /** Shut the child and the RPC server down. */
    dispose(): void;
}
/** Default host-main path relative to this module's build output. */
export declare function defaultHostMainPath(): string;
