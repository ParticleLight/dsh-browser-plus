/**
 * Electron-backed browser provider: `WebContentsView` sessions driven over
 * `webContents.debugger` (CDP). The provider itself does not import Electron — it operates through the {@link ElectronBrowserViewHost} seam, which the
 * desktop shell implements with real Electron objects. That keeps this
 * package testable under plain Node and leaves the Electron dependency to the
 * shell that owns the `BrowserWindow`.
 * @module dsh-browser-plus/browser-electron
 */
import type { BrowserChallenge, BrowserClearAuthRequest, BrowserClearAuthResult, BrowserContentRequest, BrowserContentResult, BrowserPointerResult, BrowserPointerTarget, BrowserExecuteRequest, BrowserExecuteResult, BrowserFillRequest, BrowserFillResult, BrowserHandoffState, BrowserHistoryEntry, BrowserOpenOptions, BrowserOpenRequest, BrowserPressKeyRequest, BrowserProvider, BrowserRefRequest, BrowserScrapeRequest, BrowserScrapeStatus, BrowserScrollIntoViewRequest, BrowserScrollRequest, BrowserScrollResult, BrowserSessionId, BrowserSnapshotResult, BrowserSpaceInfo, BrowserTab, BrowserTaskInfo, BrowserTaskUpdate, BrowserUploadFileRequest, BrowserUploadFileResult, BrowserWaitForRequest, BrowserWaitForResult, ExportedCookie } from '../browser/types.ts';
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
    /**
     * Cheap local usability probe for this host. MUST NOT make network calls and
     * MUST NOT throw (a throw is reported as unavailable). Optional: a host that
     * omits it is assumed usable, which keeps a desktop shell's shell-owned
     * viewHost and test fakes working. A self-hosted host reports false when the
     * pinned Electron binary cannot be resolved, so the seam can pick another
     * provider (BROWSER_PROVIDER_UNAVAILABLE / BROWSER_PROVIDER_AMBIGUOUS)
     * instead of failing later on the first open().
     */
    isAvailable?(): boolean;
    /** List browser tasks with their labels. Legacy method name retained for compatibility. */
    listWindows?(): Promise<Array<{
        key: string;
        label: string;
    }>>;
    /** List task summaries when the host exposes a visible workspace. */
    listTasks?(): Promise<readonly BrowserTaskInfo[]>;
    /** Read one task summary from the visible workspace. */
    getTask?(key: string): Promise<BrowserTaskInfo | undefined>;
    /** Apply a task status/control update to the visible workspace. */
    updateTask?(key: string, update: BrowserTaskUpdate): Promise<BrowserTaskInfo | undefined>;
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
    /**
     * Remove cookies matching a domain/name filter. Optional: hosts without a
     * deletable cookie store omit it.
     */
    clearCookies?(filter: {
        readonly domain?: string;
        readonly name?: string;
        readonly all?: boolean;
    }): Promise<{
        readonly removed: number;
        readonly names: readonly string[];
    }>;
    /** Set this view's browser task label; it titles the shared window only when selected. Optional. */
    label?(label: string): Promise<void>;
    /**
     * Re-apply the host's own page chrome to the current document. Optional: a host
     * that does not own the chrome omits it, and the provider then injects its own
     * tokenless copy as a fallback.
     */
    reinstallChrome?(): Promise<void>;
}
/** Provider config: navigation admission defaults and snapshot caps. */
export interface ElectronBrowserProviderConfig {
    /** Allow navigation only to HTTP(S) URLs; reject anything else. Default true. */
    readonly httpOnly?: boolean;
    /** Maximum snapshot elements before truncation. Default 60. */
    readonly snapshotMaxElements?: number;
    /** Maximum content characters before truncation when no maxChars is given. Default 100_000. */
    readonly contentMaxChars?: number;
    /**
     * Absolute directories a screenshot or download may write into. Defaults to
     * the workspace and the OS temp directory ({@link defaultWriteRoots}); an
     * empty list denies every write.
     */
    readonly writeRoots?: readonly string[];
    /**
     * Absolute directories `browser_upload_file` may read from. Defaults to the
     * same roots as {@link writeRoots}; an empty list denies every upload.
     */
    readonly readRoots?: readonly string[];
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
    readonly type: 'mousePressed' | 'mouseReleased' | 'mouseMoved';
    readonly x: number;
    readonly y: number;
    readonly button: 'left' | 'right' | 'middle' | 'none';
    readonly clickCount?: number;
    /** CDP modifier bitmask (Alt 1, Ctrl 2, Meta 4, Shift 8); see modifierMask. */
    readonly modifiers?: number;
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
/** CDP methods used by native browser navigation controls. */
export declare const CDP_PAGE_GET_NAVIGATION_HISTORY = "Page.getNavigationHistory";
export declare const CDP_PAGE_NAVIGATE_TO_HISTORY_ENTRY = "Page.navigateToHistoryEntry";
export declare const CDP_PAGE_RELOAD = "Page.reload";
export declare const CDP_PAGE_STOP_LOADING = "Page.stopLoading";
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
    /** Stable task-key index so callers can recover a session after tool-layer state loss. */
    private readonly sessionsByTask;
    private readonly taskStates;
    private readonly httpOnly;
    private readonly snapshotMaxElements;
    private readonly contentMaxChars;
    private readonly writeRoots;
    private readonly readRoots;
    /** Background scrape batches, keyed by id; rows live on disk, not here. */
    private readonly scrapes;
    constructor(host: ElectronBrowserViewHost, config?: ElectronBrowserProviderConfig);
    /**
     * Usable whenever the host can create views. A host that exposes a local
     * {@link ElectronBrowserViewHost.isAvailable} probe is believed; a host that
     * omits it (a desktop shell's known-good viewHost, or a test fake) is assumed
     * usable. The probe is cheap and local, so this stays callable from the seam's
     * provider-selection path; the host owns any caching it needs.
     */
    available(): boolean;
    /**
     * Open or recover the browser session for a task key. The tool layer normally
     * caches this id, but the Provider is authoritative so a scoped tool reload or
     * a lost cache cannot create a second task session with a different tab set.
     * Sessions keep isolated tabs, active tab, and history while the host keeps one
     * human-selected task view visible in the shared BrowserWindow.
     */
    open(options?: BrowserOpenOptions): Promise<BrowserSessionId>;
    /** Open a URL in the active tab (default) or a new tab. */
    openUrl(session: BrowserSessionId, request: BrowserOpenRequest, signal?: AbortSignal): Promise<void>;
    /** List the session's tabs with their titles. */
    listTabs(session: BrowserSessionId): Promise<readonly BrowserTab[]>;
    /** Switch to a tab by id; background task tabs stay hidden until user-selected. */
    switchTab(session: BrowserSessionId, tabId: string): Promise<void>;
    /**
     * Close one tab; closing the active tab activates the next. Resolves false when
     * the id is not open in this session, so a miss is distinguishable from a close.
     */
    closeTab(session: BrowserSessionId, tabId: string): Promise<boolean>;
    /** Close every tab and reset to one blank tab. */
    reset(session: BrowserSessionId): Promise<void>;
    /**
     * Dispatch one input command under the same hang guard as the CDP reads. A
     * renderer blocked in synchronous JS never acknowledges, so an unbounded await
     * here would hang the tool call until the caller's budget expired.
     * @param handle - the view to dispatch into.
     * @param method - the CDP input method.
     * @param params - its parameters.
     * @param signal - optional caller signal.
     */
    private dispatchInput;
    /**
     * Admit one URL for a provider-driven fetch (navigation or download).
     * The whole check is gated by `httpOnly`: when it is disabled, callers are
     * trusted with any scheme. When it is enabled, only HTTP(S) is admitted and
     * URL-embedded credentials are refused, so a target can never be reached
     * with in-URL auth.
     * @param url - the candidate URL.
     * @param subject - the operation name used in the error text.
     */
    private admitUrl;
    /** Navigate the active tab's view to a URL, honoring HTTP(S)-only admission. */
    navigate(session: BrowserSessionId, request: {
        readonly url: string;
    }, signal?: AbortSignal): Promise<void>;
    /**
     * Navigate one tab. A scrape worker passes its own tab so a batch never races
     * a tool call for the session's active tab.
     * @param show - bring the tab to the front; a background worker passes false.
     * @param settleMs - post-ready paint delay; a DOM-only reader passes 0.
     */
    private navigateTab;
    /** Navigate to the previous history entry when one exists. */
    back(session: BrowserSessionId, signal?: AbortSignal): Promise<boolean>;
    /** Navigate to the next history entry when one exists. */
    forward(session: BrowserSessionId, signal?: AbortSignal): Promise<boolean>;
    /** Reload the active page and restore the browser chrome afterwards. */
    reload(session: BrowserSessionId, signal?: AbortSignal): Promise<void>;
    /** Stop loading the active page. */
    stopLoading(session: BrowserSessionId, signal?: AbortSignal): Promise<void>;
    /** Execute JS in the active tab's page context. */
    execute(session: BrowserSessionId, request: BrowserExecuteRequest, signal?: AbortSignal): Promise<BrowserExecuteResult>;
    /** Evaluate in one tab's page context. */
    private executeTab;
    /** Produce an AI-friendly snapshot of the active tab. */
    snapshot(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserSnapshotResult>;
    /** Click one element that belongs to a retained exact page snapshot. */
    clickRef(session: BrowserSessionId, request: BrowserRefRequest, signal?: AbortSignal): Promise<void>;
    /** Scroll one element that belongs to a retained exact page snapshot into view. */
    scrollIntoView(session: BrowserSessionId, request: BrowserScrollIntoViewRequest, signal?: AbortSignal): Promise<BrowserScrollResult>;
    /** Check whether a human-verification challenge is blocking the active tab. */
    detectChallenge(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserChallenge>;
    /** Fetch page content in a requested format. */
    content(session: BrowserSessionId, request: BrowserContentRequest, signal?: AbortSignal): Promise<BrowserContentResult>;
    /** Click at viewport coordinates (CDP mousePressed + mouseReleased). */
    click(session: BrowserSessionId, target: BrowserPointerTarget, signal?: AbortSignal): Promise<BrowserPointerResult>;
    /** Double-click a target (physical input; clickCount 2). */
    doubleClick(session: BrowserSessionId, target: BrowserPointerTarget, signal?: AbortSignal): Promise<BrowserPointerResult>;
    /** Move the pointer over a target (no click). */
    hover(session: BrowserSessionId, target: BrowserPointerTarget, signal?: AbortSignal): Promise<BrowserPointerResult>;
    /** Scroll the active page by CSS-pixel deltas and return the final position. */
    scroll(session: BrowserSessionId, request: BrowserScrollRequest, signal?: AbortSignal): Promise<BrowserScrollResult>;
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
    /** Poll one tab until the selector matches. */
    private waitForElementTab;
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
    /**
     * Remove cookies for one site scope. Challenge cookies that rotate their names
     * (WAF challenges) otherwise pile up generation after generation, and two live
     * generations in one request can be rejected by the site. Self-hosted only.
     */
    clearAuth(session: BrowserSessionId, request: BrowserClearAuthRequest): Promise<BrowserClearAuthResult>;
    /**
     * Import cookies from a JSON export on disk.
     *
     * The path is read-guarded exactly like browser_upload_file: a prompt-injected
     * path must not turn this into a way to read a file the operator never allowed.
     * A browser cookie export cannot be produced automatically — Chrome and Edge
     * 127+ encrypt cookie values with App-Bound Encryption, so a copied profile
     * yields nothing — which is why this takes a file the user exported.
     */
    importAuth(session: BrowserSessionId, path: string): Promise<{
        restored: number;
        failed: number;
    }>;
    /** Import cookies into the session (restore login state). Self-hosted only. */
    restoreAuth(session: BrowserSessionId, cookies: readonly ExportedCookie[]): Promise<number>;
    /**
     * Start a background scrape batch.
     *
     * It runs detached on purpose: one tool call has a ~60s budget while a large
     * batch takes minutes. Progress is polled with scrapeStatus, and each row is
     * appended the moment it is produced, so a stopped or interrupted batch keeps
     * everything it managed. `outPath` is write-guarded like any other browser
     * write, and truncated up front so a re-run never mixes two batches.
     */
    startScrape(session: BrowserSessionId, request: BrowserScrapeRequest): Promise<BrowserScrapeStatus>;
    /** Progress of one batch. */
    scrapeStatus(id: string): Promise<BrowserScrapeStatus>;
    /** Ask a running batch to stop; rows already written stay. */
    stopScrape(id: string): Promise<BrowserScrapeStatus>;
    /** Every batch this process knows about, oldest first. */
    listScrapes(): Promise<readonly BrowserScrapeStatus[]>;
    private scrapeJob;
    /**
     * Visit each URL once, appending one JSONL row per page.
     *
     * Workers pull from one shared index, so `concurrency` sets the throughput
     * without changing the work. Rows therefore land in completion order; each row
     * carries its URL's index as `seq` so the caller can restore the original.
     */
    private runScrape;
    /** Drop a batch's private tabs (and their views) once the batch is over. */
    private destroyScrapeTabs;
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
    /** List browser tasks with live collaboration status. */
    listTasks(): Promise<readonly BrowserTaskInfo[]>;
    /** Read the collaboration state for one session's task. */
    getTask(session: BrowserSessionId): Promise<BrowserTaskInfo>;
    /** Apply one visible task state update and mirror it to a supporting host. */
    updateTask(session: BrowserSessionId, update: BrowserTaskUpdate): Promise<BrowserTaskInfo>;
    /** Hand control to the user or return it to Agent-driven actions. */
    setHandoff(session: BrowserSessionId, state: BrowserHandoffState): Promise<BrowserTaskInfo>;
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
    /** Recover the live session associated with a stable task key. */
    private sessionForTask;
    /** Look up a session or throw the unknown-session error. */
    private session;
    /** The active tab of a session. */
    private activeTab;
    /** Navigate through the browser history while preserving page readiness behavior. */
    private navigateHistory;
    /** Drop every reference that was captured before a document transition. */
    private invalidateSnapshots;
    /** Resolve one exact snapshot reference, rejecting any changed or missing target. */
    private resolveSnapshotTarget;
    /** Sync provider fallback cache from the host's authoritative workspace state. */
    private rememberHostedTask;
    /** Build the provider-side task summary when a host has no richer workspace. */
    private localTaskInfo;
    /** Create a tab with its short-lived snapshot reference store. */
    private createTab;
    /** Append a fresh tab and make it active. */
    private newTab;
    /** Notify the host of the active tab; it preserves the human-selected task view. */
    private showActive;
    /** Read the current URL of a view through CDP. */
    private currentUrl;
}
/**
 * The in-page half of {@link resolvePointerTarget}: resolve the element, scroll
 * it into view, and return its centre.
 *
 * Exported so it can be exercised. The matching rule — the innermost visible
 * element whose label contains the text wins — is the part most likely to be
 * wrong, and Node has no DOM to check it against.
 */
export declare function pointerTargetScript(selector: string | undefined, text: string | undefined): string;
/**
 * Minimal DOM shape {@link renderMarkdown} reads; a real DOM node fits it.
 */
export interface MarkdownNode {
    readonly nodeType?: number;
    readonly tagName?: string | null;
    readonly textContent?: string | null;
    readonly childNodes?: ArrayLike<MarkdownNode> | null;
    readonly href?: string | null;
    readonly src?: string | null;
    readonly alt?: string | null;
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
export declare function renderMarkdown(root: MarkdownNode): string;
