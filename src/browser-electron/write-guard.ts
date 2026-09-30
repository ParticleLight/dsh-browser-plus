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

import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { BrowserError } from '../browser/types.ts'

/**
 * Roots a browser write may target when the config does not name any: the
 * DSH workspace (the process working directory) and the OS temp directory.
 * This mirrors the DSH file sandbox's "write inside the workspace" boundary.
 */
export function defaultWriteRoots(): string[] {
  return [process.cwd(), tmpdir()]
}

/** Windows paths compare case-insensitively; POSIX paths do not. */
function comparable(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/**
 * Resolve symlinks on the deepest ancestor that exists, then re-append the
 * segments that do not. A save target usually does not exist yet, so the
 * target itself cannot be realpath'd — but its parent usually can.
 */
function realpathOfNearestAncestor(target: string): string {
  let current = target
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return tail.length === 0 ? real : join(real, ...[...tail].reverse())
    } catch {
      const parent = dirname(current)
      // Reached the filesystem root without finding anything real: fall back
      // to the lexical path rather than denying a legitimate write.
      if (parent === current) return target
      tail.push(basename(current))
      current = parent
    }
  }
}

/** True when `candidate` is `root` itself or lives beneath it. */
function within(candidate: string, root: string): boolean {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** Real, comparable forms of both sides; roots are normalized exactly once per call. */
function resolvedPair(candidate: string, roots: readonly string[]): { target: string; roots: string[] } {
  return {
    target: comparable(realpathOfNearestAncestor(resolve(candidate))),
    roots: roots.map(root => comparable(realpathOfNearestAncestor(resolve(root)))),
  }
}

/**
 * Whether a path would be admitted by {@link resolveWritePath}, without
 * throwing. Exposed for focused tests and for callers that want to probe.
 * @param candidate - the path to test.
 * @param roots - the allowed roots.
 */
export function isWithinRoots(candidate: string, roots: readonly string[]): boolean {
  const { target, roots: resolved } = resolvedPair(candidate, roots)
  return resolved.some(root => within(target, root))
}

/**
 * Resolve a write target and admit it only when it lands inside one of the
 * allowed roots. Returns the absolute path to write.
 * @param savePath - the caller-supplied path.
 * @param roots - the allowed roots; an empty list denies every write.
 * @throws BrowserError `BROWSER_WRITE_PATH_DENIED` when the path is unusable or outside every root.
 */
export function resolveWritePath(savePath: string, roots: readonly string[]): string {
  if (typeof savePath !== 'string' || savePath.trim() === '') {
    throw new BrowserError('browser: refusing to write without a save path', 'BROWSER_WRITE_PATH_DENIED')
  }
  const absolute = resolve(savePath)
  if (!isWithinRoots(absolute, roots)) {
    const shown = roots.length === 0 ? '(none configured)' : roots.join(', ')
    throw new BrowserError(
      `browser: refusing to write "${savePath}" outside the allowed roots (${shown}); `
      + 'add the directory to the browser-electron "writeRoots" config to allow it',
      'BROWSER_WRITE_PATH_DENIED',
    )
  }
  return absolute
}
