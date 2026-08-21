/**
 * Service Definition for the browser capability seam.
 * @module dsh-browser/browser
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  BrowserClickRequest, BrowserContentRequest, BrowserContentResult,
  BrowserDownloadRequest, BrowserExecuteRequest, BrowserExecuteResult,
  BrowserFillRequest, BrowserFillResult, BrowserHistoryEntry,
  BrowserNavigateRequest, BrowserOpenRequest, BrowserProvider,
  BrowserPressKeyRequest, BrowserScreenshotRequest, BrowserScreenshotResult,
  BrowserSessionId, BrowserSnapshotResult, BrowserTab, BrowserTypeRequest,
  BrowserChallenge, ExportedCookie,
} from './types.ts'
import { BrowserError } from './types.ts'
export { BrowserError } from './types.ts'
export type {
  BrowserChallenge, BrowserClickRequest, BrowserContentFormat, BrowserContentRequest,
  BrowserContentResult, BrowserDownloadRequest, BrowserExecuteRequest, BrowserExecuteResult,
  BrowserFillField, BrowserFillRequest, BrowserFillResult, BrowserHistoryEntry,
  BrowserNavigateRequest, BrowserOpenRequest, BrowserPressKeyRequest, BrowserProvider,
  BrowserScreenshotRequest, BrowserScreenshotResult, BrowserSessionId, BrowserSnapshotElement,
  BrowserSnapshotResult, BrowserTab, BrowserTypeRequest, ExportedCookie,
} from './types.ts'
declare module '@deepseek-ai/cordis' { interface Context { browser: BrowserRuntime } }
export interface BrowserRuntimeConfig { readonly browserProvider?: string }
export class BrowserRuntime extends Service {
  static Config: z<BrowserRuntimeConfig> = z.object({ browserProvider: z.string() })
  private providers = new Map<string, BrowserProvider>()
  private readonly providerId: string | undefined
  constructor(ctx: Context, config: BrowserRuntimeConfig = {}) { super(ctx, 'browser'); this.providerId = config.browserProvider }
  registerBrowserProvider(provider: BrowserProvider): () => void {
    if (this.providers.has(provider.id)) throw new BrowserError(`a browser provider with id "${provider.id}" is already registered`, 'BROWSER_DUPLICATE_PROVIDER')
    const dispose = this.ctx.effect(function* (this: BrowserRuntime) { this.providers.set(provider.id, provider); yield () => this.providers.delete(provider.id) }.bind(this), 'browser.registerProvider()')
    return () => void dispose()
  }
  private resolveProvider(): BrowserProvider {
    const { providerId, providers } = this
    if (providerId !== undefined) {
      const provider = providers.get(providerId)
      if (!provider) throw new BrowserError(`configured browser provider "${providerId}" is not registered`, 'BROWSER_PROVIDER_CONFIGURED_MISSING')
      if (!provider.available()) throw new BrowserError(`configured browser provider "${providerId}" is registered but unavailable`, 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE')
      return provider
    }
    const usable = [...providers.values()].filter(provider => provider.available())
    if (usable.length === 0) throw new BrowserError('no usable browser provider is registered', 'BROWSER_PROVIDER_UNAVAILABLE')
    if (usable.length > 1) throw new BrowserError(`multiple usable browser providers are registered (${usable.map(p => p.id).join(', ')}); configure one explicitly`, 'BROWSER_PROVIDER_AMBIGUOUS')
    return usable[0]
  }
  async open(): Promise<BrowserSessionId> { return this.resolveProvider().open() }
  async openUrl(s: BrowserSessionId, r: BrowserOpenRequest, signal?: AbortSignal): Promise<void> { return this.resolveProvider().openUrl(s, r, signal) }
  async listTabs(s: BrowserSessionId): Promise<readonly BrowserTab[]> { return this.resolveProvider().listTabs(s) }
  async switchTab(s: BrowserSessionId, id: string): Promise<void> { return this.resolveProvider().switchTab(s, id) }
  async closeTab(s: BrowserSessionId, id: string): Promise<void> { return this.resolveProvider().closeTab(s, id) }
  async reset(s: BrowserSessionId): Promise<void> { return this.resolveProvider().reset(s) }
  async navigate(s: BrowserSessionId, r: BrowserNavigateRequest, signal?: AbortSignal): Promise<void> { return this.resolveProvider().navigate(s, r, signal) }
  async execute(s: BrowserSessionId, r: BrowserExecuteRequest, signal?: AbortSignal): Promise<BrowserExecuteResult> { return this.resolveProvider().execute(s, r, signal) }
  async snapshot(s: BrowserSessionId, signal?: AbortSignal): Promise<BrowserSnapshotResult> { return this.resolveProvider().snapshot(s, signal) }
  async content(s: BrowserSessionId, r: BrowserContentRequest, signal?: AbortSignal): Promise<BrowserContentResult> { return this.resolveProvider().content(s, r, signal) }
  async click(s: BrowserSessionId, r: BrowserClickRequest, signal?: AbortSignal): Promise<void> { return this.resolveProvider().click(s, r, signal) }
  async type(s: BrowserSessionId, r: BrowserTypeRequest, signal?: AbortSignal): Promise<void> { return this.resolveProvider().type(s, r, signal) }
  async pressKey(s: BrowserSessionId, r: BrowserPressKeyRequest, signal?: AbortSignal): Promise<void> { return this.resolveProvider().pressKey(s, r, signal) }
  async fillForm(s: BrowserSessionId, r: BrowserFillRequest, signal?: AbortSignal): Promise<BrowserFillResult> { return this.resolveProvider().fillForm(s, r, signal) }
  async screenshot(s: BrowserSessionId, r?: BrowserScreenshotRequest, signal?: AbortSignal): Promise<BrowserScreenshotResult> { return this.resolveProvider().screenshot(s, r, signal) }
  async detectChallenge(s: BrowserSessionId, signal?: AbortSignal): Promise<BrowserChallenge> { return this.resolveProvider().detectChallenge(s, signal) }
  async history(s: BrowserSessionId): Promise<readonly BrowserHistoryEntry[]> { return this.resolveProvider().history(s) }
  async replay(s: BrowserSessionId, seq: number): Promise<void> { return this.resolveProvider().replay(s, seq) }
  async download(s: BrowserSessionId, r: BrowserDownloadRequest, signal?: AbortSignal): Promise<{ readonly path: string }> { return this.resolveProvider().download(s, r, signal) }
  async flushAuth(s: BrowserSessionId): Promise<readonly ExportedCookie[]> { return this.resolveProvider().flushAuth(s) }
  async restoreAuth(s: BrowserSessionId, cookies: readonly ExportedCookie[]): Promise<number> { return this.resolveProvider().restoreAuth(s, cookies) }
  async close(s: BrowserSessionId): Promise<void> {
    try { await this.resolveProvider().close(s) } catch (error) {
      const code = error instanceof BrowserError ? (error as { code?: string }).code : undefined
      if (code === 'BROWSER_PROVIDER_UNAVAILABLE' || code === 'BROWSER_PROVIDER_CONFIGURED_MISSING' || code === 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE' || code === 'BROWSER_PROVIDER_AMBIGUOUS') return
      throw error
    }
  }
}
export default BrowserRuntime
