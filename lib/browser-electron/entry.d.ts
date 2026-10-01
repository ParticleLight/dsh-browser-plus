/**
 * Electron browser provider plugin entry: registers the Electron-backed
 * `BrowserProvider` with `ctx.browser`. The provider needs a view host (real
 * Electron `WebContentsView` objects). When a desktop shell supplies
 * `ctx.electronViewHost`, that host is used (embedded, human-machine shared
 * view). Otherwise the plugin self-hosts: it spawns its own Electron child
 * (`host-main.js`) and drives it over a local TCP JSON-RPC socket, so
 * installing the plugin is enough for `browser_*` tools to work on any
 * surface.
 * @module dsh-browser-plus/browser-electron
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { BrowserRuntime } from '../browser/runtime.ts';
import type { ElectronBrowserViewHost } from './provider.ts';
export { ELECTRON_BROWSER_PROVIDER_ID, ElectronBrowserProvider, } from './provider.ts';
export type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.ts';
export { RemoteElectronViewHost, defaultHostMainPath } from './remote-host.ts';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "browser-electron";
/** The browser seam this provider registers into. */
export declare const inject: string[];
/** Plugin config: an optional externally-supplied view host. */
export interface Config {
    /** View host supplied by a desktop shell; absent -> self-host. */
    readonly viewHost?: ElectronBrowserViewHost;
    /** Allow navigation only to HTTP(S) URLs. Default true. */
    readonly httpOnly?: boolean;
    /**
     * Absolute directories `browser_screenshot` and `browser_download` may
     * write into. Absent -> the workspace and the OS temp directory. An explicit
     * empty list denies every write.
     */
    readonly writeRoots?: string[];
    /**
     * Absolute directories `browser_upload_file` may read from. Absent -> the
     * same default as writeRoots (the workspace and the OS temp directory).
     */
    readonly readRoots?: string[];
    /**
     * Which JavaScript world the injected page chrome lives in. `main` (default)
     * is the proven path; `isolated` keeps the chrome's task state and its
     * binding token out of the page's own context, at the cost of an extra CDP
     * context per document. Opt in only after confirming the toolbar in a real
     * window (see docs/SOAK-CHECKLIST.md).
     */
    readonly chromeWorld?: 'main' | 'isolated';
}
export declare const Config: z<Config>;
/** Register the Electron browser provider with `ctx.browser`. */
export declare function apply(ctx: Context & {
    browser: BrowserRuntime;
}, config: Config): void;
