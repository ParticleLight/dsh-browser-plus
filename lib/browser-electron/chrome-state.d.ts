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
    /**
     * Bumped when a new image arrives through the 'task.thumbnail' patch. The
     * image itself is never part of a summary: summaries reach every page.
     */
    readonly thumbnailVersion: number;
}
/**
 * One tab of the selected task, as the tab strip renders it.
 *
 * A tab is a host view, so this is the view list for the task in creation
 * order; `active` marks the one currently shown. Titles and URLs come from the
 * view itself and are refreshed on navigation.
 */
export interface ChromeTabSummary {
    readonly id: string;
    readonly title: string;
    readonly url: string;
    /** Favicon URL reported by the page, when it has one. Page-controlled. */
    readonly favicon?: string;
    readonly active: boolean;
}
export interface ChromeWorkspaceState {
    readonly epoch: number;
    readonly revision: number;
    readonly selectedTaskKey?: string;
    readonly panels: ChromePanels;
    readonly tasks: readonly ChromeTaskSummary[];
    /** Tabs of the selected task, in creation order. */
    readonly tabs: readonly ChromeTabSummary[];
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
} | {
    readonly op: 'tabs.set';
    readonly tabs: readonly ChromeTabSummary[];
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
