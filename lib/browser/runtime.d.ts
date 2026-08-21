/**
 * Service Definition for the browser capability seam.
 * @module dsh-browser/browser
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { BrowserClickRequest, BrowserContentRequest, BrowserContentResult, BrowserDownloadRequest, BrowserExecuteRequest, BrowserExecuteResult, BrowserFillRequest, BrowserFillResult, BrowserHistoryEntry, BrowserNavigateRequest, BrowserOpenRequest, BrowserProvider, BrowserPressKeyRequest, BrowserScreenshotRequest, BrowserScreenshotResult, BrowserSessionId, BrowserSnapshotResult, BrowserTab, BrowserTypeRequest, BrowserChallenge, ExportedCookie } from './types.ts';
export { BrowserError } from './types.ts';
export type { BrowserChallenge, BrowserClickRequest, BrowserContentFormat, BrowserContentRequest, BrowserContentResult, BrowserDownloadRequest, BrowserExecuteRequest, BrowserExecuteResult, BrowserFillField, BrowserFillRequest, BrowserFillResult, BrowserHistoryEntry, BrowserNavigateRequest, BrowserOpenRequest, BrowserPressKeyRequest, BrowserProvider, BrowserScreenshotRequest, BrowserScreenshotResult, BrowserSessionId, BrowserSnapshotElement, BrowserSnapshotResult, BrowserTab, BrowserTypeRequest, ExportedCookie, } from './types.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        browser: BrowserRuntime;
    }
}
export interface BrowserRuntimeConfig {
    readonly browserProvider?: string;
}
export declare class BrowserRuntime extends Service {
    static Config: z<BrowserRuntimeConfig>;
    private providers;
    private readonly providerId;
    constructor(ctx: Context, config?: BrowserRuntimeConfig);
    registerBrowserProvider(provider: BrowserProvider): () => void;
    private resolveProvider;
    open(): Promise<BrowserSessionId>;
    openUrl(s: BrowserSessionId, r: BrowserOpenRequest, signal?: AbortSignal): Promise<void>;
    listTabs(s: BrowserSessionId): Promise<readonly BrowserTab[]>;
    switchTab(s: BrowserSessionId, id: string): Promise<void>;
    closeTab(s: BrowserSessionId, id: string): Promise<void>;
    reset(s: BrowserSessionId): Promise<void>;
    navigate(s: BrowserSessionId, r: BrowserNavigateRequest, signal?: AbortSignal): Promise<void>;
    execute(s: BrowserSessionId, r: BrowserExecuteRequest, signal?: AbortSignal): Promise<BrowserExecuteResult>;
    snapshot(s: BrowserSessionId, signal?: AbortSignal): Promise<BrowserSnapshotResult>;
    content(s: BrowserSessionId, r: BrowserContentRequest, signal?: AbortSignal): Promise<BrowserContentResult>;
    click(s: BrowserSessionId, r: BrowserClickRequest, signal?: AbortSignal): Promise<void>;
    type(s: BrowserSessionId, r: BrowserTypeRequest, signal?: AbortSignal): Promise<void>;
    pressKey(s: BrowserSessionId, r: BrowserPressKeyRequest, signal?: AbortSignal): Promise<void>;
    fillForm(s: BrowserSessionId, r: BrowserFillRequest, signal?: AbortSignal): Promise<BrowserFillResult>;
    screenshot(s: BrowserSessionId, r?: BrowserScreenshotRequest, signal?: AbortSignal): Promise<BrowserScreenshotResult>;
    detectChallenge(s: BrowserSessionId, signal?: AbortSignal): Promise<BrowserChallenge>;
    history(s: BrowserSessionId): Promise<readonly BrowserHistoryEntry[]>;
    replay(s: BrowserSessionId, seq: number): Promise<void>;
    download(s: BrowserSessionId, r: BrowserDownloadRequest, signal?: AbortSignal): Promise<{
        readonly path: string;
    }>;
    flushAuth(s: BrowserSessionId): Promise<readonly ExportedCookie[]>;
    restoreAuth(s: BrowserSessionId, cookies: readonly ExportedCookie[]): Promise<number>;
    close(s: BrowserSessionId): Promise<void>;
}
export default BrowserRuntime;
