/**
 * Request-fingerprint helpers.
 *
 * Electron advertises itself in the User-Agent (`Electron/42.9.3`) and sends no
 * client hints at all, even though its own `navigator.userAgentData` reports
 * Chromium — so a request claiming Chrome arrived with none of the sec-ch-ua
 * headers Chrome always sends. These turn the engine's own values into the shape
 * a real Chrome produces, without inventing a fingerprint the engine cannot
 * back up: the brands here are the ones the engine itself reports.
 * @module dsh-browser-plus/browser-electron/fingerprint
 */

/** Strip Electron's self-advertisement from a User-Agent. */
export function stripElectronToken(userAgent: string): string {
  return userAgent.replace(/\sElectron\/[\d.]+/, '')
}

/** The engine's Chrome major version, used to mirror its client-hint brands. */
export function chromeMajor(userAgent: string): string | undefined {
  return /Chrome\/(\d+)/.exec(userAgent)?.[1]
}

/** Serialize a brand list the way Chromium does in the sec-ch-ua header. */
export function secChUa(brands: readonly { brand: string; version: string }[]): string {
  return brands.map(brand => `"${brand.brand}";v="${brand.version}"`).join(', ')
}

/** sec-ch-ua-platform, spelled the way Chromium spells it per OS. */
export function clientHintPlatform(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return '"Windows"'
  if (platform === 'darwin') return '"macOS"'
  return '"Linux"'
}

/**
 * The language list to hand Chromium for a locale. Passing it through
 * `setUserAgent` (rather than rewriting the header) lets Chromium apply its own
 * q-weights, which is exactly the shape real Chrome produces; Electron otherwise
 * sends the bare locale alone.
 */
export function acceptLanguagesFor(locale: string): string {
  const base = locale.split('-')[0]
  // Dedupe so an "en-US" locale does not produce "en-US,en,en".
  return [...new Set([locale, base, 'en'])].join(',')
}
