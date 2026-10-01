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
export declare function stripElectronToken(userAgent: string): string;
/** The engine's Chrome major version, used to mirror its client-hint brands. */
export declare function chromeMajor(userAgent: string): string | undefined;
/** Serialize a brand list the way Chromium does in the sec-ch-ua header. */
export declare function secChUa(brands: readonly {
    brand: string;
    version: string;
}[]): string;
/** sec-ch-ua-platform, spelled the way Chromium spells it per OS. */
export declare function clientHintPlatform(platform?: NodeJS.Platform): string;
/**
 * The language list to hand Chromium for a locale. Passing it through
 * `setUserAgent` (rather than rewriting the header) lets Chromium apply its own
 * q-weights, which is exactly the shape real Chrome produces; Electron otherwise
 * sends the bare locale alone.
 */
export declare function acceptLanguagesFor(locale: string): string;
