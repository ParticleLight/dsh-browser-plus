/**
 * Platform icon resolver for the shared browser host window.
 *
 * Maps the current platform to the matching generated icon derivative and
 * returns its absolute path, or undefined when the asset is missing (so the
 * host can build the window without the icon rather than fail). No files are
 * read at import time; only the resolver itself touches the filesystem.
 * @module dsh-browser-plus/browser-electron/icon
 */
/** Absolute path of this platform's BrowserWindow icon, or undefined. */
export declare function resolveBrowserIconPath(platform?: NodeJS.Platform): string | undefined;
