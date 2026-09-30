/** Convert Electron cookies into portable auth records, skipping invalid domains. */
export function exportCookiesForAuth(cookies) {
    return cookies.flatMap(cookie => {
        const domain = cookie.domain;
        if (typeof domain !== 'string' || domain === '')
            return [];
        const host = domain.startsWith('.') ? domain.slice(1) : domain;
        const hostPart = host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host;
        const path = typeof cookie.path === 'string' && cookie.path !== '' ? cookie.path : '/';
        const secure = cookie.secure === true;
        return [{
                url: 'http' + (secure ? 's' : '') + '://' + hostPart + path,
                name: cookie.name,
                value: cookie.value,
                domain,
                path,
                secure,
                httpOnly: cookie.httpOnly === true,
                expirationDate: cookie.expirationDate,
            }];
    });
}
/** Normalize a scope/domain for comparison: drop one leading dot, lowercase. */
function normalizeDomain(domain) {
    const trimmed = domain.trim().toLowerCase();
    return trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;
}
/** Whether one cookie domain falls under a scope: the scope itself, or a subdomain. */
export function cookieMatchesDomain(cookieDomain, scope) {
    const cookie = normalizeDomain(cookieDomain);
    const target = normalizeDomain(scope);
    if (cookie === '' || target === '')
        return false;
    return cookie === target || cookie.endsWith('.' + target);
}
/** Build the URL required to address one cookie for removal. */
export function cookieRemovalUrl(cookie) {
    const domain = cookie.domain;
    if (typeof domain !== 'string' || domain === '')
        return undefined;
    const host = domain.startsWith('.') ? domain.slice(1) : domain;
    if (host === '')
        return undefined;
    const hostPart = host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host;
    const path = typeof cookie.path === 'string' && cookie.path !== '' ? cookie.path : '/';
    return 'http' + (cookie.secure === true ? 's' : '') + '://' + hostPart + path;
}
/**
 * Select the cookies a clear request targets. An unscoped request is refused
 * unless "all" is explicitly set, so a missing filter can never wipe logins.
 * @param cookies - the profile's cookies.
 * @param filter - domain scope, exact name, or an explicit full wipe.
 * @returns the removable cookies, each with its removal URL.
 */
export function selectCookiesForClear(cookies, filter) {
    const domainScope = typeof filter.domain === 'string' && filter.domain.trim() !== '' ? filter.domain : undefined;
    const nameScope = typeof filter.name === 'string' && filter.name !== '' ? filter.name : undefined;
    if (domainScope === undefined && nameScope === undefined && filter.all !== true) {
        throw new Error('cookie clear requires a domain or name filter; pass all: true to remove every cookie');
    }
    const targets = [];
    for (const cookie of cookies) {
        const domain = cookie.domain;
        if (typeof domain !== 'string' || domain === '')
            continue;
        if (domainScope !== undefined || nameScope !== undefined) {
            if (domainScope !== undefined && !cookieMatchesDomain(domain, domainScope))
                continue;
            if (nameScope !== undefined && cookie.name !== nameScope)
                continue;
        }
        const url = cookieRemovalUrl(cookie);
        if (url === undefined)
            continue;
        targets.push({
            name: cookie.name,
            domain,
            path: typeof cookie.path === 'string' && cookie.path !== '' ? cookie.path : '/',
            url,
        });
    }
    return targets;
}
