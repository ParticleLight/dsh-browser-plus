/**
 * dsh-browser-plus plugin entry: aggregates the shared-browser capability
 * pieces. The cordis.patch.yml rows reference subpath exports:
 *   - `dsh-browser-plus/browser`          -> the ctx.browser seam (Service)
 *   - `dsh-browser-plus/browser-electron` -> the Electron CDP provider
 *   - `dsh-browser-plus/tool-browser`     -> the model-facing browser_* tools
 * This root entry only re-exports for programmatic use; the loader rows are
 * the composition surface.
 * @module dsh-browser-plus
 */

export { BrowserError } from './browser/types.ts'
export type {
  BrowserChallenge,
  BrowserClickRequest,
  BrowserContentFormat,
  BrowserContentRequest,
  BrowserContentResult,
  BrowserExecuteRequest,
  BrowserExecuteResult,
  BrowserFillField,
  BrowserFillRequest,
  BrowserFillResult,
  BrowserNavigateRequest,
  BrowserOpenRequest,
  BrowserProvider,
  BrowserScreenshotRequest,
  BrowserScreenshotResult,
  BrowserSessionId,
  BrowserSnapshotElement,
  BrowserSnapshotResult,
  BrowserTab,
  BrowserTypeRequest,
  ExportedCookie,
} from './browser/types.ts'
export { BrowserRuntime } from './browser/runtime.ts'
export { ElectronBrowserProvider } from './browser-electron/provider.ts'
export type { ElectronBrowserViewHost, ElectronViewHandle } from './browser-electron/provider.ts'
export { RemoteElectronViewHost, defaultHostMainPath } from './browser-electron/remote-host.ts'
