/**
 * Versioned state exchanged between the self-hosted Electron main process and
 * the injected page chrome. Keeping the payload declarative makes it possible
 * to update one task or one trail entry without rebuilding the whole workspace.
 * @module dsh-browser-plus/browser-electron/chrome-state
 */
export interface ChromePanels {
    readonly tasks: boolean;
    readonly trail: boolean;
}
export interface ChromeTrailEntry {
    readonly action: string;
    readonly params?: Record<string, unknown>;
    readonly ok?: boolean;
    readonly at: number;
}
export interface ChromeTaskLatest {
    readonly action: string;
    readonly at: number;
}
export interface ChromeTaskSummary {
    readonly key: string;
    readonly label: string;
    readonly active: boolean;
    readonly background: boolean;
    readonly url: string;
    readonly tabs: number;
    readonly status: 'idle' | 'running' | 'waiting-user' | 'failed';
    readonly control: 'agent' | 'human';
    readonly updatedAt: number;
    readonly latest?: ChromeTaskLatest;
    readonly error?: string;
    readonly thumbnail?: string;
    readonly thumbnailVersion: number;
}
export interface ChromeWorkspaceState {
    readonly epoch: number;
    readonly revision: number;
    readonly selectedTaskKey?: string;
    readonly panels: ChromePanels;
    readonly tasks: readonly ChromeTaskSummary[];
    readonly trail: readonly ChromeTrailEntry[];
}
export interface ChromeBootstrapMessage extends ChromeWorkspaceState {
    readonly kind: 'bootstrap';
}
export type ChromePatchOperation = {
    readonly op: 'task.upsert';
    readonly task: ChromeTaskSummary;
} | {
    readonly op: 'task.remove';
    readonly key: string;
} | {
    readonly op: 'task.active';
    readonly key?: string;
} | {
    readonly op: 'task.thumbnail';
    readonly key: string;
    readonly version: number;
    readonly dataUrl?: string;
} | {
    readonly op: 'trail.append';
    readonly taskKey: string;
    readonly entry: ChromeTrailEntry;
} | {
    readonly op: 'trail.replace';
    readonly taskKey?: string;
    readonly entries: readonly ChromeTrailEntry[];
} | {
    readonly op: 'panels.set';
    readonly panels: ChromePanels;
};
export interface ChromePatchMessage {
    readonly kind: 'patch';
    readonly epoch: number;
    readonly revision: number;
    readonly operations: readonly ChromePatchOperation[];
}
export type ChromeMessage = ChromeBootstrapMessage | ChromePatchMessage;
export declare function createBootstrap(state: ChromeWorkspaceState): ChromeBootstrapMessage;
export declare function createPatch(epoch: number, revision: number, operations: readonly ChromePatchOperation[]): ChromePatchMessage;
