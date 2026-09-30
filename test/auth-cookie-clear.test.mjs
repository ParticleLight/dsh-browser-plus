import assert from 'node:assert/strict'
import test from 'node:test'

import * as authCookies from '../lib/browser-electron/auth-cookies.js'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

/** A profile with two rotating-name generations plus unrelated cookies. */
const jar = [
  { domain: '.example.com', path: '/', name: 'QkmefgKpT5HyO', value: 'a', secure: true, httpOnly: true },
  { domain: '.example.com', path: '/', name: 'QkmefgKpT5HyP', value: 'b', secure: true, httpOnly: true },
  { domain: 'api.example.com', path: '/v1', name: 'session', value: 'c', secure: true, httpOnly: false },
  { domain: 'other.com', path: '/', name: 'QkmefgKpT5HyO', value: 'd', secure: false, httpOnly: false },
  { domain: undefined, path: '/', name: 'broken', value: 'e' },
  { domain: '::1', path: '/api', name: 'ipv6', value: 'f', secure: false, httpOnly: false },
]

test('cookie domain scope covers the domain itself and its subdomains', () => {
  assert.equal(authCookies.cookieMatchesDomain('.example.com', 'example.com'), true)
  assert.equal(authCookies.cookieMatchesDomain('api.example.com', 'example.com'), true)
  assert.equal(authCookies.cookieMatchesDomain('example.com', '.example.com'), true)
  assert.equal(authCookies.cookieMatchesDomain('notexample.com', 'example.com'), false)
  assert.equal(authCookies.cookieMatchesDomain('', 'example.com'), false)
})

test('site-scoped clear keeps cookies outside the domain scope', () => {
  const targets = authCookies.selectCookiesForClear(jar, { domain: 'example.com' })
  assert.deepEqual(targets.map(target => target.name), ['QkmefgKpT5HyO', 'QkmefgKpT5HyP', 'session'])
  assert.deepEqual(targets.map(target => target.url), [
    'https://example.com/',
    'https://example.com/',
    'https://api.example.com/v1',
  ])
})

test('name filter narrows the scope to exactly one cookie', () => {
  const targets = authCookies.selectCookiesForClear(jar, { domain: 'example.com', name: 'QkmefgKpT5HyP' })
  assert.deepEqual(targets.map(target => target.name), ['QkmefgKpT5HyP'])
  assert.deepEqual(authCookies.selectCookiesForClear(jar, { name: 'QkmefgKpT5HyO' }).map(target => target.domain), ['.example.com', 'other.com'])
})

test('unscoped clear is refused unless the full wipe is explicit', () => {
  assert.throws(() => authCookies.selectCookiesForClear(jar, {}), /requires a domain or name filter/)
  assert.throws(() => authCookies.selectCookiesForClear(jar, { domain: '   ' }), /requires a domain or name filter/)
  const all = authCookies.selectCookiesForClear(jar, { all: true })
  assert.deepEqual(all.map(target => target.name), ['QkmefgKpT5HyO', 'QkmefgKpT5HyP', 'session', 'QkmefgKpT5HyO', 'ipv6'])
})

test('removal URLs mirror the export URL forms', () => {
  assert.equal(authCookies.cookieRemovalUrl({ domain: '.example.com', name: 'x', value: 'v', secure: true }), 'https://example.com/')
  assert.equal(authCookies.cookieRemovalUrl({ domain: 'other.com', path: '/deep', name: 'x', value: 'v' }), 'http://other.com/deep')
  assert.equal(authCookies.cookieRemovalUrl({ domain: '::1', path: '/api', name: 'x', value: 'v' }), 'http://[::1]/api')
  assert.equal(authCookies.cookieRemovalUrl({ name: 'x', value: 'v' }), undefined)
})

class FakeView {
  constructor(host, withClear) {
    this.id = 'view:cookie'
    this.host = host
    // Only install the capability when the host advertises it: a prototype
    // method could not be removed to model an unsupported store.
    if (withClear) {
      this.clearCookies = async (filter) => {
        this.host.cleared.push(filter)
        return { removed: 2, names: ['QkmefgKpT5HyO', 'QkmefgKpT5HyP'] }
      }
    }
  }

  async sendCommand() {
    return {}
  }
}

class FakeHost {
  constructor(withClear) {
    this.cleared = []
    this.withClear = withClear
  }

  createView() {
    return new FakeView(this, this.withClear)
  }

  destroyView() {}
  showView() {}
}

test('provider clearAuth forwards the scope and records the operation', async () => {
  const host = new FakeHost(true)
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open({ key: 'task-cookie-clear' })

  const result = await provider.clearAuth(session, { domain: 'example.com', name: 'QkmefgKpT5HyP' })
  assert.deepEqual(result, { removed: 2, names: ['QkmefgKpT5HyO', 'QkmefgKpT5HyP'] })
  assert.deepEqual(host.cleared, [{ domain: 'example.com', name: 'QkmefgKpT5HyP' }])

  const history = await provider.history(session)
  assert.equal(history.at(-1).action, 'clearAuth')
  assert.equal(history.at(-1).result, '2 cookies')
})

test('provider clearAuth reports hosts without a deletable cookie store', async () => {
  const host = new FakeHost(false)
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open({ key: 'task-cookie-unsupported' })
  await assert.rejects(
    () => provider.clearAuth(session, { domain: 'example.com' }),
    error => error.code === 'BROWSER_AUTH_UNSUPPORTED',
  )
})
