import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as remoteHost from '../lib/browser-electron/remote-host.js'

const packagePath = new URL('../package.json', import.meta.url)

test('package supplies the supported Electron runtime', async () => {
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
  assert.equal(pkg.optionalDependencies?.electron, '42.9.3')
  assert.equal(pkg.peerDependencies?.electron, undefined)
})

test('resolver selects only Electron 42.9.3 candidates', () => {
  assert.equal(typeof remoteHost.selectSupportedElectronPath, 'function', 'selector is exported for behavior tests')
  const select = remoteHost.selectSupportedElectronPath
  assert.equal(select([{ version: '43.4.1', path: 'bad' }, { version: '42.9.3', path: 'good' }]), 'good')
  assert.throws(() => select([{ version: '43.4.1', path: 'bad' }]), /requires Electron 42.9.3/)
  assert.throws(() => select([]), /found: none/)
})

test('cookie export skips invalid domains and preserves valid URL forms', async () => {
  const authCookies = await import('../lib/browser-electron/auth-cookies.js').catch(() => undefined)
  assert.ok(authCookies, 'auth cookie helper module exists')
  const exported = authCookies.exportCookiesForAuth([
    { domain: undefined, path: '/', name: 'skip-missing', value: 'x', secure: true, httpOnly: true },
    { domain: '', path: '/', name: 'skip-empty', value: 'x', secure: true, httpOnly: true },
    { domain: '.example.com', path: '/', name: 'normal', value: 'x', secure: true, httpOnly: true, expirationDate: 123 },
    { domain: '::1', path: '/api', name: 'ipv6', value: 'y', secure: false, httpOnly: false },
  ])
  assert.deepEqual(exported, [
    { url: 'https://example.com/', name: 'normal', value: 'x', domain: '.example.com', path: '/', secure: true, httpOnly: true, expirationDate: 123 },
    { url: 'http://[::1]/api', name: 'ipv6', value: 'y', domain: '::1', path: '/api', secure: false, httpOnly: false, expirationDate: undefined },
  ])
})
