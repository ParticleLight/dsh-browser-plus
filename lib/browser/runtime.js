/**
 * Service Definition for the browser capability seam.
 * @module dsh-browser/browser
 */
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { BrowserError } from "./types.js";
export { BrowserError } from "./types.js";
export class BrowserRuntime extends Service {
    static Config = z.object({ browserProvider: z.string() });
    providers = new Map();
    providerId;
    constructor(ctx, config = {}) { super(ctx, 'browser'); this.providerId = config.browserProvider; }
    registerBrowserProvider(provider) {
        if (this.providers.has(provider.id))
            throw new BrowserError(`a browser provider with id "${provider.id}" is already registered`, 'BROWSER_DUPLICATE_PROVIDER');
        const dispose = this.ctx.effect(function* () { this.providers.set(provider.id, provider); yield () => this.providers.delete(provider.id); }.bind(this), 'browser.registerProvider()');
        return () => void dispose();
    }
    resolveProvider() {
        const { providerId, providers } = this;
        if (providerId !== undefined) {
            const provider = providers.get(providerId);
            if (!provider)
                throw new BrowserError(`configured browser provider "${providerId}" is not registered`, 'BROWSER_PROVIDER_CONFIGURED_MISSING');
            if (!provider.available())
                throw new BrowserError(`configured browser provider "${providerId}" is registered but unavailable`, 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE');
            return provider;
        }
        const usable = [...providers.values()].filter(provider => provider.available());
        if (usable.length === 0)
            throw new BrowserError('no usable browser provider is registered', 'BROWSER_PROVIDER_UNAVAILABLE');
        if (usable.length > 1)
            throw new BrowserError(`multiple usable browser providers are registered (${usable.map(p => p.id).join(', ')}); configure one explicitly`, 'BROWSER_PROVIDER_AMBIGUOUS');
        return usable[0];
    }
    async open() { return this.resolveProvider().open(); }
    async openUrl(s, r, signal) { return this.resolveProvider().openUrl(s, r, signal); }
    async listTabs(s) { return this.resolveProvider().listTabs(s); }
    async switchTab(s, id) { return this.resolveProvider().switchTab(s, id); }
    async closeTab(s, id) { return this.resolveProvider().closeTab(s, id); }
    async reset(s) { return this.resolveProvider().reset(s); }
    async navigate(s, r, signal) { return this.resolveProvider().navigate(s, r, signal); }
    async execute(s, r, signal) { return this.resolveProvider().execute(s, r, signal); }
    async snapshot(s, signal) { return this.resolveProvider().snapshot(s, signal); }
    async content(s, r, signal) { return this.resolveProvider().content(s, r, signal); }
    async click(s, r, signal) { return this.resolveProvider().click(s, r, signal); }
    async type(s, r, signal) { return this.resolveProvider().type(s, r, signal); }
    async pressKey(s, r, signal) { return this.resolveProvider().pressKey(s, r, signal); }
    async fillForm(s, r, signal) { return this.resolveProvider().fillForm(s, r, signal); }
    async screenshot(s, r, signal) { return this.resolveProvider().screenshot(s, r, signal); }
    async detectChallenge(s, signal) { return this.resolveProvider().detectChallenge(s, signal); }
    async history(s) { return this.resolveProvider().history(s); }
    async replay(s, seq) { return this.resolveProvider().replay(s, seq); }
    async download(s, r, signal) { return this.resolveProvider().download(s, r, signal); }
    async flushAuth(s) { return this.resolveProvider().flushAuth(s); }
    async restoreAuth(s, cookies) { return this.resolveProvider().restoreAuth(s, cookies); }
    async close(s) {
        try {
            await this.resolveProvider().close(s);
        }
        catch (error) {
            const code = error instanceof BrowserError ? error.code : undefined;
            if (code === 'BROWSER_PROVIDER_UNAVAILABLE' || code === 'BROWSER_PROVIDER_CONFIGURED_MISSING' || code === 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE' || code === 'BROWSER_PROVIDER_AMBIGUOUS')
                return;
            throw error;
        }
    }
}
export default BrowserRuntime;
