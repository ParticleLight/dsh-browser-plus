export interface AuthCookieLike {
    readonly domain?: string;
    readonly path?: string;
    readonly name: string;
    readonly value: string;
    readonly secure?: boolean;
    readonly httpOnly?: boolean;
    readonly expirationDate?: number;
}
export interface ExportedAuthCookie {
    readonly url: string;
    readonly name: string;
    readonly value: string;
    readonly domain: string;
    readonly path: string;
    readonly secure: boolean;
    readonly httpOnly: boolean;
    readonly expirationDate: number | undefined;
}
/** Convert Electron cookies into portable auth records, skipping invalid domains. */
export declare function exportCookiesForAuth(cookies: readonly AuthCookieLike[]): ExportedAuthCookie[];
/**
 * One cookie selected for removal, plus the URL Electron needs to delete it.
 */
export interface CookieClearTarget {
    readonly name: string;
    readonly domain: string;
    readonly path: string;
    readonly url: string;
}
/**
 * Which cookies a clear request targets: a domain scope, one exact name within
 * that scope, or an explicit whole-profile wipe.
 */
export interface CookieClearFilter {
    /** Domain scope; matches the domain itself and every subdomain. */
    readonly domain?: string;
    /** Exact cookie name to remove within the scope. */
    readonly name?: string;
    /** Remove every addressable cookie; requires this explicit opt-in. */
    readonly all?: boolean;
}
/** Whether one cookie domain falls under a scope: the scope itself, or a subdomain. */
export declare function cookieMatchesDomain(cookieDomain: string, scope: string): boolean;
/** Build the URL required to address one cookie for removal. */
export declare function cookieRemovalUrl(cookie: AuthCookieLike): string | undefined;
/**
 * Select the cookies a clear request targets. An unscoped request is refused
 * unless "all" is explicitly set, so a missing filter can never wipe logins.
 * @param cookies - the profile's cookies.
 * @param filter - domain scope, exact name, or an explicit full wipe.
 * @returns the removable cookies, each with its removal URL.
 */
export declare function selectCookiesForClear(cookies: readonly AuthCookieLike[], filter: CookieClearFilter): CookieClearTarget[];
