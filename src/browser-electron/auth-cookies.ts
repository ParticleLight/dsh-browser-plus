export interface AuthCookieLike {
  readonly domain?: string
  readonly path?: string
  readonly name: string
  readonly value: string
  readonly secure?: boolean
  readonly httpOnly?: boolean
  readonly expirationDate?: number
}

export interface ExportedAuthCookie {
  readonly url: string
  readonly name: string
  readonly value: string
  readonly domain: string
  readonly path: string
  readonly secure: boolean
  readonly httpOnly: boolean
  readonly expirationDate: number | undefined
}

/** Convert Electron cookies into portable auth records, skipping invalid domains. */
export function exportCookiesForAuth(cookies: readonly AuthCookieLike[]): ExportedAuthCookie[] {
  return cookies.flatMap(cookie => {
    const domain = cookie.domain
    if (typeof domain !== 'string' || domain === '') return []
    const host = domain.startsWith('.') ? domain.slice(1) : domain
    const hostPart = host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host
    const path = typeof cookie.path === 'string' && cookie.path !== '' ? cookie.path : '/'
    const secure = cookie.secure === true
    return [{
      url: 'http' + (secure ? 's' : '') + '://' + hostPart + path,
      name: cookie.name,
      value: cookie.value,
      domain,
      path,
      secure,
      httpOnly: cookie.httpOnly === true,
      expirationDate: cookie.expirationDate,
    }]
  })
}
/**
 * One cookie selected for removal, plus the URL Electron needs to delete it.
 */
export interface CookieClearTarget {
  readonly name: string
  readonly domain: string
  readonly path: string
  readonly url: string
}

/**
 * Which cookies a clear request targets: a domain scope, one exact name within
 * that scope, or an explicit whole-profile wipe.
 */
export interface CookieClearFilter {
  /** Domain scope; matches the domain itself and every subdomain. */
  readonly domain?: string
  /** Exact cookie name to remove within the scope. */
  readonly name?: string
  /** Remove every addressable cookie; requires this explicit opt-in. */
  readonly all?: boolean
}

/** Normalize a scope/domain for comparison: drop one leading dot, lowercase. */
function normalizeDomain(domain: string): string {
  const trimmed = domain.trim().toLowerCase()
  return trimmed.startsWith('.') ? trimmed.slice(1) : trimmed
}

/** Whether one cookie domain falls under a scope: the scope itself, or a subdomain. */
export function cookieMatchesDomain(cookieDomain: string, scope: string): boolean {
  const cookie = normalizeDomain(cookieDomain)
  const target = normalizeDomain(scope)
  if (cookie === '' || target === '') return false
  return cookie === target || cookie.endsWith('.' + target)
}

/** Build the URL required to address one cookie for removal. */
export function cookieRemovalUrl(cookie: AuthCookieLike): string | undefined {
  const domain = cookie.domain
  if (typeof domain !== 'string' || domain === '') return undefined
  const host = domain.startsWith('.') ? domain.slice(1) : domain
  if (host === '') return undefined
  const hostPart = host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host
  const path = typeof cookie.path === 'string' && cookie.path !== '' ? cookie.path : '/'
  return 'http' + (cookie.secure === true ? 's' : '') + '://' + hostPart + path
}

/**
 * Select the cookies a clear request targets. An unscoped request is refused
 * unless "all" is explicitly set, so a missing filter can never wipe logins.
 * @param cookies - the profile's cookies.
 * @param filter - domain scope, exact name, or an explicit full wipe.
 * @returns the removable cookies, each with its removal URL.
 */
export function selectCookiesForClear(
  cookies: readonly AuthCookieLike[],
  filter: CookieClearFilter,
): CookieClearTarget[] {
  const domainScope = typeof filter.domain === 'string' && filter.domain.trim() !== '' ? filter.domain : undefined
  const nameScope = typeof filter.name === 'string' && filter.name !== '' ? filter.name : undefined
  if (domainScope === undefined && nameScope === undefined && filter.all !== true) {
    throw new Error('cookie clear requires a domain or name filter; pass all: true to remove every cookie')
  }
  const targets: CookieClearTarget[] = []
  for (const cookie of cookies) {
    const domain = cookie.domain
    if (typeof domain !== 'string' || domain === '') continue
    if (domainScope !== undefined || nameScope !== undefined) {
      if (domainScope !== undefined && !cookieMatchesDomain(domain, domainScope)) continue
      if (nameScope !== undefined && cookie.name !== nameScope) continue
    }
    const url = cookieRemovalUrl(cookie)
    if (url === undefined) continue
    targets.push({
      name: cookie.name,
      domain,
      path: typeof cookie.path === 'string' && cookie.path !== '' ? cookie.path : '/',
      url,
    })
  }
  return targets
}
