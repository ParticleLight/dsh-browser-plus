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
