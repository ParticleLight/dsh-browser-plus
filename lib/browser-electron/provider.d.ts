/**
 * Electron-backed browser provider: `WebContentsView` sessions driven over
 * `webContents.debugger` (CDP). The provider itself does not import Electron — it operates through the {@link ElectronBrowserViewHost} seam, which the
 * desktop shell implements with real Electron objects. That keeps this
 * package testable under plain Node and leaves the Electron dependency to the
 * shell that owns the `BrowserWindow`.
 * @module dsh-browser-plus/browser-electron
 */
import type { BrowserChallenge, BrowserContentRequest, BrowserContentResult, BrowserDoubleClickRequest, BrowserExecuteRequest, BrowserExecuteResult, BrowserFillRequest, BrowserFillResult, BrowserHistoryEntry, BrowserHoverRequest, BrowserOpenOptions, BrowserOpenRequest, BrowserPressKeyRequest, BrowserProvider, BrowserSessionId, BrowserSnapshotResult, BrowserSpaceInfo, BrowserTab, BrowserUploadFileRequest, BrowserUploadFileResult, BrowserWaitForRequest, BrowserWaitForResult, ExportedCookie } from '../browser/types.ts';
/** Stable provider id registered with `ctx.browser`. */
export declare const ELECTRON_BROWSER_PROVIDER_ID = "electron";
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
    createView(key?: string, label?: string): ElectronViewHandle;
    /**
     * Destroy a view created by this host. Called on session close; idempotent
     * for an already-destroyed view.
     * @param handle - the handle returned by {@link createView}.
     */
    destroyView(handle: ElectronViewHandle): void;
    /**
     * Notify the host that this session selected a tab. In the shared-window
     * host, a background task updates its active view without changing the
     * human-selected visible task. Optional for headless/probe hosts.
     * @param handle - the handle selected by its session.
     */
    showView?(handle: ElectronViewHandle): void;
    /**
     * Append one operation to the human-facing trail for a view. Optional.
     * @param viewId - the view to attribute the operation to.
     * @param entry - the trail entry ({ action, params, ok, at }).
     */
    trace?(viewId: string, entry: unknown): void;
    /** List browser tasks with their labels. Legacy method name retained for compatibility. */
    listWindows?(): Promise<Array<{
        key: string;
        label: string;
    }>>;
}
/**
 * A CDP-capable view handle. This is the subset of Electron's
 * `WebContents`/`WebContentsView` the provider drives; the shell's real
 * implementation adapts `webContents.debugger` to it.
 */
export interface ElectronViewHandle {
    /** Unique id of the backing view, used for diagnostics. */
    readonly id: string;
    /**
     * Send one CDP command and resolve with its result. Rejects when the
     * debugger is not attached or the command fails.
     * @param method - CDP method, e.g. `Page.navigate`.
     * @param params - CDP command parameters.
     * @returns the CDP `result` object.
     */
    sendCommand(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
    /**
     * Read the most recent auto-accepted JS dialog for this view (and clear it).
     * Optional: hosts without JS-dialog supervision omit it.
     * @returns the dialog detail ({ type, message, prompt? }) or null.
     */
    clearDialog?(): Promise<unknown>;
    /** Set this view's browser task label; it titles the shared window only when selected. Optional. */
    label?(label: string): Promise<void>;
}
/** Provider config: navigation admission defaults and snapshot caps. */
export interface ElectronBrowserProviderConfig {
    /** Allow navigation only to HTTP(S) URLs; reject anything else. Default true. */
    readonly httpOnly?: boolean;
    /** Maximum snapshot elements before truncation. Default 60. */
    readonly snapshotMaxElements?: number;
    /** Maximum content characters before truncation when no maxChars is given. Default 100_000. */
    readonly contentMaxChars?: number;
}
/**
 * CDP method/params for `Page.navigate`, as sent to {@link ElectronViewHandle.sendCommand}.
 */
export interface CdpNavigateParams {
    readonly url: string;
}
/**
 * CDP method/params for `Input.dispatchMouseEvent` (a click press+release pair).
 */
export interface CdpMouseParams {
    readonly type: 'mousePressed' | 'mouseReleased';
    readonly x: number;
    readonly y: number;
    readonly button: 'left';
    readonly clickCount: number;
}
/** CDP method/params for `Input.insertText`. */
export interface CdpInsertTextParams {
    readonly text: string;
}
/** CDP method/params for `Runtime.evaluate`. */
export interface CdpEvaluateParams {
    readonly expression: string;
    readonly returnByValue: boolean;
    readonly awaitPromise?: boolean;
}
/** CDP method for a full-page screenshot capture. */
export declare const CDP_PAGE_CAPTURE_SCREENSHOT = "Page.captureScreenshot";
/** CDP method for runtime evaluation (the execute path). */
export declare const CDP_RUNTIME_EVALUATE = "Runtime.evaluate";
/** CDP method for keyboard input. */
export declare const CDP_INPUT_DISPATCH_KEY_EVENT = "Input.dispatchKeyEvent";
/** CDP method for navigation. */
export declare const CDP_PAGE_NAVIGATE = "Page.navigate";
/**
 * Browser provider over Electron views. Sessions hold an ordered list of
 * tabs; each tab is one view created by the host. The active tab receives
 * every operation; switching tabs calls the host's optional `showView` and
 * never loses state. Navigation is admitted only for HTTP(S) targets unless
 * {@link ElectronBrowserProviderConfig.httpOnly} is disabled.
 */
export declare class ElectronBrowserProvider implements BrowserProvider {
    private readonly host;
    readonly id = "electron";
    private readonly sessions;
    private readonly httpOnly;
    private readonly snapshotMaxElements;
    private readonly contentMaxChars;
    constructor(host: ElectronBrowserViewHost, config?: ElectronBrowserProviderConfig);
    /** Usable whenever the host can create views (always in the desktop shell). */
    available(): boolean;
    /**
     * Open a NEW browser session with its own backing view. Every call mints a
     * fresh session id; per-task reuse is owned by the caller (the tool layer
     * caches one session per DSH task). Sessions keep isolated tabs, active tab,
     * and history while the host keeps one human-selected task view visible in
     * the shared BrowserWindow.
     */
    open(options?: BrowserOpenOptions): Promise<BrowserSessionId>;
    /** Open a URL in the active tab (default) or a new tab. */
    openUrl(session: BrowserSessionId, request: BrowserOpenRequest, signal?: AbortSignal): Promise<void>;
    /** List the session's tabs with their titles. */
    listTabs(session: BrowserSessionId): Promise<readonly BrowserTab[]>;
    /** Switch to a tab by id; background task tabs stay hidden until user-selected. */
    switchTab(session: BrowserSessionId, tabId: string): Promise<void>;
    /** Close one tab; closing the active tab activates the next. */
    closeTab(session: BrowserSessionId, tabId: string): Promise<void>;
    /** Close every tab and reset to one blank tab. */
    reset(session: BrowserSessionId): Promise<void>;
    /** Navigate the active tab's view to a URL, honoring HTTP(S)-only admission. */
    navigate(session: BrowserSessionId, request: {
        readonly url: string;
    }, signal?: AbortSignal): Promise<void>;
    /** Execute JS in the active tab's page context. */
    execute(session: BrowserSessionId, request: BrowserExecuteRequest, signal?: AbortSignal): Promise<BrowserExecuteResult>;
    /** Produce an AI-friendly snapshot of the active tab. */
    snapshot(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserSnapshotResult>;
    /** Check whether a human-verification challenge is blocking the active tab. */
    detectChallenge(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserChallenge>;
    /** Fetch page content in a requested format. */
    content(session: BrowserSessionId, request: BrowserContentRequest, signal?: AbortSignal): Promise<BrowserContentResult>;
    /** Click at viewport coordinates (CDP mousePressed + mouseReleased). */
    click(session: BrowserSessionId, request: {
        readonly x: number;
        readonly y: number;
    }, signal?: AbortSignal): Promise<void>;
    /** Double-click at viewport coordinates (physical input; clickCount 2). */
    doubleClick(session: BrowserSessionId, request: BrowserDoubleClickRequest, signal?: AbortSignal): Promise<void>;
    /** Move the pointer to viewport coordinates (hover; no click). */
    hover(session: BrowserSessionId, request: BrowserHoverRequest, signal?: AbortSignal): Promise<void>;
    /**
     * Attach a local file to the first matching file input. Uses the CDP DOM
     * domain (nodeId path), which — unlike a synthetic change event — makes the
     * input's files list true (real file selection), so pages that read
     * input.files or upload on change behave exactly like a real pick.
     */
    uploadFile(session: BrowserSessionId, request: BrowserUploadFileRequest, signal?: AbortSignal): Promise<BrowserUploadFileResult>;
    /**
     * Poll until an element matching the selector exists (and is visible).
     * Bounds the total wait; a timeout surfaces as BROWSER_WAIT_TIMEOUT.
     */
    waitForElement(session: BrowserSessionId, request: BrowserWaitForRequest, signal?: AbortSignal): Promise<BrowserWaitForResult>;
    /** Type into the focused element. */
    type(session: BrowserSessionId, request: {
        readonly text: string;
    }, signal?: AbortSignal): Promise<void>;
    /** Press a key into the page (keyDown + keyUp), as a physical-input path
     * for shortcuts and keyboard-driven UI. */
    pressKey(session: BrowserSessionId, request: BrowserPressKeyRequest, signal?: AbortSignal): Promise<void>;
    /**
     * Fill a form's fields in one batch. Runs one page-context script that
     * resolves each field (selector, or name/label/placeholder among visible
     * controls), sets its value with the native prototype setter (React/Vue
     * controlled inputs included) plus input/change events, handles
     * select/checkbox/radio/contenteditable, and optionally submits the form.
     */
    fillForm(session: BrowserSessionId, request: BrowserFillRequest, signal?: AbortSignal): Promise<BrowserFillResult>;
    /**
     * Download a URL to a local file, keeping the session's cookies/login.
     * Requires the self-hosted host (which implements view-level download); the
     * desktop shell's embedded views delegate downloads to the real browser UI.
     */
    download(session: BrowserSessionId, request: {
        readonly url: string;
        readonly savePath: string;
    }, signal?: AbortSignal): Promise<{
        readonly path: string;
    }>;
    /**
     * Export the session's cookies (login state) as serializable objects.
     * Self-hosted only; the desktop shell's embedded views use the real profile.
     */
    flushAuth(session: BrowserSessionId): Promise<readonly ExportedCookie[]>;
    /** Import cookies into the session (restore login state). Self-hosted only. */
    restoreAuth(session: BrowserSessionId, cookies: readonly ExportedCookie[]): Promise<number>;
    /** Capture the current page, optionally full-page. PNG only (CDP JPEG hangs on Electron 43). */
    screenshot(session: BrowserSessionId, request?: {
        readonly fullPage?: boolean;
        readonly savePath?: string;
    }, signal?: AbortSignal): Promise<{
        readonly dataUrl: string;
        readonly path?: string;
    }>;
    /** Build the data URL and optionally write the PNG to disk. */
    private saveScreenshot;
    /**
     * Pick up (and forget) any JS dialog the host auto-accepted, so the
     * operation trail shows the human/agent what the page asked. Best-effort.
     */
    private drainDialog;
    /** Name this browser task (space). */
    setSpace(session: BrowserSessionId, label: string): Promise<void>;
    /** List every browser task (space) with its label. */
    listSpaces(): Promise<readonly BrowserSpaceInfo[]>;
    /** Append one operation to the session's history. */
    private record;
    /** Return the session's chronological operation log (newest last). */
    history(session: BrowserSessionId): Promise<readonly BrowserHistoryEntry[]>;
    /**
     * Replay one recorded operation by sequence number. Navigate/click/type are
     * re-issued against the current page; execute re-runs its script. The
     * replayed step is appended to history as a new entry.
     * @param session - the session id.
     * @param seq - the recorded entry's sequence number to replay.
     */
    replay(session: BrowserSessionId, seq: number): Promise<void>;
    /** Close the session and destroy all its views. Idempotent. */
    close(session: BrowserSessionId): Promise<void>;
    /** Look up a session or throw the unknown-session error. */
    private session;
    /** The active tab of a session. */
    private activeTab;
    /** Append a fresh tab and make it active. */
    private newTab;
    /** Notify the host of the active tab; it preserves the human-selected task view. */
    private showActive;
    /** Read the current URL of a view through CDP. */
    private currentUrl;
}
