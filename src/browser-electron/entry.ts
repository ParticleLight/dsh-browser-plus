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

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { BrowserRuntime } from '../browser/runtime.ts'
import { ElectronBrowserProvider } from './provider.ts'
import type { ElectronBrowserViewHost } from './provider.ts'
import { defaultHostMainPath, RemoteElectronViewHost } from './remote-host.ts'
import { defaultWriteRoots } from './write-guard.ts'

export {
  ELECTRON_BROWSER_PROVIDER_ID,
  ElectronBrowserProvider,
} from './provider.ts'
export type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.ts'
export { RemoteElectronViewHost, defaultHostMainPath } from './remote-host.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-electron'

/** The browser seam this provider registers into. */
export const inject = ['browser']

/** Plugin config: an optional externally-supplied view host. */
export interface Config {
  /** View host supplied by a desktop shell; absent -> self-host. */
  readonly viewHost?: ElectronBrowserViewHost
  /** Allow navigation only to HTTP(S) URLs. Default true. */
  readonly httpOnly?: boolean
  /**
   * Absolute directories `browser_screenshot` and `browser_download` may
   * write into. Absent -> the workspace and the OS temp directory. An explicit
   * empty list denies every write.
   */
  readonly writeRoots?: string[]
  /**
   * Absolute directories `browser_upload_file` may read from. Absent -> the
   * same default as writeRoots (the workspace and the OS temp directory).
   */
  readonly readRoots?: string[]
  /**
   * Which JavaScript world the injected page chrome lives in.
   *
   * `isolated` (default) keeps the chrome's task state — including the Agent's
   * plan, which the floating orb renders — and its binding token out of the
   * page's own context: the page's scripts see `undefined` for every `__dsh*`
   * global instead of a readable copy. It costs one extra CDP context per
   * document, and the chrome reads the DOM through that context (the DOM itself
   * is shared, so element lookups and layout still work).
   *
   * `main` puts everything in the page's world: the proven-against-everything
   * path, but a page can read the plan by hooking `Map.prototype.set` or
   * `document.createElement`. Use it only to bisect an isolated-world bug.
   */
  readonly chromeWorld?: 'main' | 'isolated'
  /**
   * Replace the engine's User-Agent verbatim. When absent, Electron's
   * `Electron/42.9.3` token is stripped and the matching client-hint headers
   * are added, so the request fingerprint says Chrome instead of "this is a
   * scripted Electron".
   */
  readonly userAgent?: string
  /**
   * Keep the automation fingerprint masked. Default true: Electron advertises
   * itself in the User-Agent and sends no client hints, which is the loudest
   * thing a bot check can read. Set false to send the engine's own fingerprint.
   */
  readonly maskAutomation?: boolean
}

export const Config: z<Config> = z.object({
  // Absent on surfaces without a desktop shell; the plugin self-hosts then.
  viewHost: z.any(),
  httpOnly: z.boolean().default(true),
  // The defaults are materialized HERE, not left to the provider's
  // `?? defaultWriteRoots()`: schemastery turns an absent array key into [],
  // and an empty array is not nullish, so the provider would see an empty
  // allow-list and refuse every write. Defaulting in the schema keeps absence
  // meaning "the documented defaults" while an explicit [] still denies all.
  writeRoots: z.array(z.string()).default(defaultWriteRoots()),
  readRoots: z.array(z.string()).default(defaultWriteRoots()),
  chromeWorld: z.union(['main', 'isolated'] as const).default('isolated'),
  userAgent: z.string(),
  maskAutomation: z.boolean().default(true),
})

/** Register the Electron browser provider with `ctx.browser`. */
export function apply(ctx: Context & { browser: BrowserRuntime }, config: Config): void {
  // External host (desktop shell) wins; otherwise self-host. The self-hosted
  // child is disposed with the fiber, mirroring the shell's lifetime.
  const host: ElectronBrowserViewHost = config.viewHost
    ?? new RemoteElectronViewHost(defaultHostMainPath(), {
      // `?? 'isolated'` 不只是为了类型：入口可能拿到**未经 schema 解析**的配置
      // （测试探针、其它调用方直接调 apply），那时缺省值不会自动出现，
      // 而 remote-host 把 undefined 当成「不加 --chrome-world」→ 子进程退回 main ✗。
      chromeWorld: config.chromeWorld ?? 'isolated',
      maskAutomation: config.maskAutomation,
      ...config.userAgent === undefined ? {} : { userAgent: config.userAgent },
    })
  // Own the disposer on THIS plugin's fiber: registerBrowserProvider's effect
  // is bound to the seam's own fiber (the browser row), so a reload of this
  // row would otherwise collide with the still-registered provider
  // (BROWSER_DUPLICATE_PROVIDER) or leave a stale provider behind.
  const unregister = ctx.browser.registerBrowserProvider(new ElectronBrowserProvider(host, {
    httpOnly: config.httpOnly,
    ...config.writeRoots !== undefined ? { writeRoots: config.writeRoots } : {},
    ...config.readRoots !== undefined ? { readRoots: config.readRoots } : {},
  }))
  ctx.effect(() => () => {
    unregister()
    if (config.viewHost === undefined && host instanceof RemoteElectronViewHost) {
      host.dispose()
    }
  })
}
