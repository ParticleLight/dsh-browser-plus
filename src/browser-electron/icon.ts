/**
 * Platform icon resolver for the shared browser host window.
 *
 * Maps the current platform to the matching generated icon derivative and
 * returns its absolute path, or undefined when the asset is missing (so the
 * host can build the window without the icon rather than fail). No files are
 * read at import time; only the resolver itself touches the filesystem.
 * @module dsh-browser-plus/browser-electron/icon
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Icon filename for each platform; any unknown platform falls back to linux. */
const ICON_BY_PLATFORM: Record<string, string> = {
  win32: 'dsh-browser-plus.ico',
  darwin: 'dsh-browser-plus-512.png',
  linux: 'dsh-browser-plus-256.png',
}

/** Absolute path of this platform's BrowserWindow icon, or undefined. */
export function resolveBrowserIconPath(platform = process.platform): string | undefined {
  const filename = ICON_BY_PLATFORM[platform] ?? ICON_BY_PLATFORM.linux
  const path = fileURLToPath(new URL('../../assets/' + filename, import.meta.url))
  return existsSync(path) ? path : undefined
}
