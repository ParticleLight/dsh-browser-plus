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
/**
 * Build a self-contained CDP page-start script.
 *
 * @param bindingToken - per-view secret echoed back on every chrome control
 *   message. It is captured in the injected IIFE's closure, so page scripts can
 *   call the CDP binding but cannot read the token back out. Omit it for hosts
 *   that do not authenticate page-emitted controls (see {@link PAGE_CHROME_SCRIPT}).
 */
export type ChromeSurface = 'full' | 'frame' | 'page';
export declare function buildPageChromeScript(bindingToken?: string, surface?: ChromeSurface): string;
