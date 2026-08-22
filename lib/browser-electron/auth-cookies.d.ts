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
