/**
 * Write-path admission for browser-produced files (screenshots, downloads).
 *
 * The provider — not the host — owns this guard so one implementation covers
 * the self-hosted Electron host and desktop-shell handles alike, and so it can
 * be exercised without Electron. Roots are resolved through the deepest
 * existing ancestor, which keeps a symlinked or `..`-laden target from
 * escaping a root it only appears to sit inside.
 * @module dsh-browser-plus/browser-electron/write-guard
 */
/**
 * Roots a browser write may target when the config does not name any: the
 * DSH workspace (the process working directory) and the OS temp directory.
 * This mirrors the DSH file sandbox's "write inside the workspace" boundary.
 */
export declare function defaultWriteRoots(): string[];
/**
 * Whether a path would be admitted by {@link resolveWritePath}, without
 * throwing. Exposed for focused tests and for callers that want to probe.
 * @param candidate - the path to test.
 * @param roots - the allowed roots.
 */
export declare function isWithinRoots(candidate: string, roots: readonly string[]): boolean;
/**
 * Resolve a write target and admit it only when it lands inside one of the
 * allowed roots. Returns the absolute path to write.
 * @param savePath - the caller-supplied path.
 * @param roots - the allowed roots; an empty list denies every write.
 * @throws BrowserError `BROWSER_WRITE_PATH_DENIED` when the path is unusable or outside every root.
 */
export declare function resolveWritePath(savePath: string, roots: readonly string[]): string;
/**
 * Resolve a file the browser is about to hand to a page and admit it only when
 * it lands inside one of the allowed roots. Unlike a write target the file must
 * already exist, so the path itself is realpath'd: a symlink to a permitted
 * file is admitted, a symlink that leaves the roots is not.
 * @param filePath - the caller-supplied path.
 * @param roots - the allowed roots; an empty list denies every read.
 * @throws BrowserError `BROWSER_READ_PATH_DENIED` when the path is unusable, missing, or outside every root.
 */
export declare function resolveReadPath(filePath: string, roots: readonly string[]): string;
