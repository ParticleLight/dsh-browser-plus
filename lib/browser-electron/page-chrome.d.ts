/**
 * Human-facing browser chrome injected into the top-level page document.
 * Keeping this UI in the page renderer avoids a second Electron
 * WebContentsView and leaves the host composition tree stable.
 */
export declare const PAGE_CHROME_HOST_ID = "__dsh_browser_chrome_host__";
export declare const PAGE_CHROME_ATTRIBUTE = "data-dsh-browser-chrome";
/** Generated once; stable across documents and reused by the provider. */
export declare const PAGE_CHROME_SCRIPT: string;
/** Convert human address-bar text into an allowed HTTP(S) navigation target. */
export declare function normalizeBrowserAddress(raw: string): string;
/** Build a self-contained CDP page-start script. */
export declare function buildPageChromeScript(): string;
