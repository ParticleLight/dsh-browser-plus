/**
 * Versioned state exchanged between the self-hosted Electron main process and
 * the injected page chrome. Keeping the payload declarative makes it possible
 * to update one task or one trail entry without rebuilding the whole workspace.
 * @module dsh-browser-plus/browser-electron/chrome-state
 */

export interface ChromePanels {
  readonly tasks: boolean
  readonly trail: boolean
}

export interface ChromeTrailEntry {
  readonly action: string
  readonly params?: Record<string, unknown>
  readonly ok?: boolean
  readonly at: number
}

export interface ChromeTaskLatest {
  readonly action: string
  readonly at: number
}

export interface ChromeTaskSummary {
  readonly key: string
  readonly label: string
  readonly active: boolean
  readonly background: boolean
  readonly url: string
  readonly tabs: number
  readonly status: 'idle' | 'running' | 'waiting-user' | 'failed'
  readonly control: 'agent' | 'human'
  readonly updatedAt: number
  readonly latest?: ChromeTaskLatest
  readonly error?: string
  /**
   * Bumped when a new image arrives through the 'task.thumbnail' patch. The
   * image itself is never part of a summary: summaries reach every page.
   */
  readonly thumbnailVersion: number
}

/**
 * One tab of the selected task, as the tab strip renders it.
 *
 * A tab is a host view, so this is the view list for the task in creation
 * order; `active` marks the one currently shown. Titles and URLs come from the
 * view itself and are refreshed on navigation.
 */
export interface ChromeTabSummary {
  readonly id: string
  readonly title: string
  readonly url: string
  readonly active: boolean
  /**
   * True while this tab's document is still loading.
   *
   * Drives the two Chrome affordances the strip mirrors: a spinner in place of
   * the favicon, and the toolbar's reload button turning into stop.
   */
  readonly loading?: boolean
  /**
   * The page's own favicon, re-encoded by the host as a small data: URL.
   *
   * The host fetches it through the view's own session and admits only a few
   * raster types under a byte cap, so this never becomes a general-purpose
   * network read. Like the title, it is visible to the page the chrome is
   * injected into; a favicon is public artwork for a site the page could fetch
   * itself, and the URL beside it is already reduced to an origin.
   */
  readonly favicon?: string
}

/**
 * One saved page.
 *
 * Bookmarks belong to the profile, not to a page: they are stored by the host
 * and pushed to the chrome, never kept in the page's own storage. localStorage
 * is per origin, so a bookmark saved on one site was invisible on every other
 * (measured: saved on iana.org, absent on example.com).
 */
export interface ChromeBookmark {
  readonly url: string
  readonly title: string
}

export interface ChromeWorkspaceState {
  readonly epoch: number
  readonly revision: number
  readonly selectedTaskKey?: string
  readonly panels: ChromePanels
  readonly tasks: readonly ChromeTaskSummary[]
  /** Tabs of the selected task, in creation order. */
  readonly tabs: readonly ChromeTabSummary[]
  readonly trail: readonly ChromeTrailEntry[]
  readonly bookmarks: readonly ChromeBookmark[]
  /** Chrome's bookmark bar, off until the user turns it on from the ⋮ menu. */
  readonly bookmarkBar: boolean
  /** Empty unless the chrome frame view failed to come up; then, why. */
  readonly frameError?: string
  /**
   * What the host's own window reports: visible/minimized/content size/frame size.
   *
   * Kept because the window's real state and what a screenshot tool *thinks* it is
   * are not the same thing — a capture that grabbed a helper window once looked
   * exactly like the browser window having come up 158x26, and that cost two
   * rounds before this made it visible.
   */
  readonly windowProbe?: string
}

export interface ChromeBootstrapMessage extends ChromeWorkspaceState {
  readonly kind: 'bootstrap'
}

export type ChromePatchOperation =
  | { readonly op: 'task.upsert'; readonly task: ChromeTaskSummary }
  | { readonly op: 'task.remove'; readonly key: string }
  | { readonly op: 'task.active'; readonly key?: string }
  | { readonly op: 'task.thumbnail'; readonly key: string; readonly version: number; readonly dataUrl?: string }
  | { readonly op: 'trail.append'; readonly taskKey: string; readonly entry: ChromeTrailEntry }
  | { readonly op: 'trail.replace'; readonly taskKey?: string; readonly entries: readonly ChromeTrailEntry[] }
  | { readonly op: 'panels.set'; readonly panels: ChromePanels }
  | { readonly op: 'tabs.set'; readonly tabs: readonly ChromeTabSummary[] }
  | { readonly op: 'bookmarks.set'; readonly bookmarks: readonly ChromeBookmark[] }
  | { readonly op: 'bookmarkbar.set'; readonly visible: boolean }
  /**
   * A popup the chrome frame view asked the page's copy to show, anchored where the
   * frame's own button is (the frame is 84px tall — a menu drawn there is clipped).
   */
  | { readonly op: 'panel.state'; readonly id: string; readonly open: boolean; readonly left?: number; readonly width?: number }

export interface ChromePatchMessage {
  readonly kind: 'patch'
  readonly epoch: number
  readonly revision: number
  readonly operations: readonly ChromePatchOperation[]
}

export type ChromeMessage = ChromeBootstrapMessage | ChromePatchMessage

export function createBootstrap(state: ChromeWorkspaceState): ChromeBootstrapMessage {
  return { kind: 'bootstrap', ...state }
}

export function createPatch(
  epoch: number,
  revision: number,
  operations: readonly ChromePatchOperation[],
): ChromePatchMessage {
  return { kind: 'patch', epoch, revision, operations }
}
