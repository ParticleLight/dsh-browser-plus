/**
 * dsh-browser-plus plugin entry: aggregates the shared-browser capability
 * pieces. The cordis.patch.yml rows reference subpath exports:
 *   - `dsh-browser-plus/browser`          -> the ctx.browser seam (Service)
 *   - `dsh-browser-plus/browser-electron` -> the Electron CDP provider
 *   - `dsh-browser-plus/tool-browser`     -> the model-facing browser_* tools
 * This root entry only re-exports for programmatic use; the loader rows are
 * the composition surface.
 *
 * It IS also mounted as a row of its own — an empty one — because the client
 * module system only scans Loader rows whose specifier is an exact package root
 * (`exactPackageSpecifier` in `@deepseek-ai/dsh-client-modules` returns
 * undefined for a subpath). Without a root row the package's `dsh.client`
 * declaration is never read and the browser panel never reaches the GUI, no
 * matter how many subpath rows the bundle patch adds.
 * @module dsh-browser-plus
 */
/** Plugin name for the root row. */
export const name = 'browser-plus';
/** The root row has no behaviour of its own; it exists to carry the package identity. */
export function apply() { }
export { BrowserError } from "./browser/types.js";
export { BrowserRuntime } from "./browser/runtime.js";
export { ElectronBrowserProvider } from "./browser-electron/provider.js";
export { RemoteElectronViewHost, defaultHostMainPath } from "./browser-electron/remote-host.js";
