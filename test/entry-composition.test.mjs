import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, Config } from '../lib/browser-electron/entry.js'
import { RemoteElectronViewHost } from '../lib/browser-electron/remote-host.js'

/**
 * apply() picks the view host and owns the disposer that must unregister the
 * provider and shut down only a self-hosted host. None of that had a test, so a
 * break in the composition only showed up at runtime.
 */

function fakeContext() {
  const registered = []
  const disposers = []
  const ctx = {
    browser: {
      registerBrowserProvider(provider) {
        registered.push(provider)
        return () => {
          const index = registered.indexOf(provider)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    effect(setup) { disposers.push(setup()) },
  }
  return { ctx, registered, disposers }
}

/** Stand-in for a desktop shell's view host. */
function externalHost() {
  return {
    disposed: false,
    dispose() { this.disposed = true },
    createView() { return { id: 'view:1', sendCommand: async () => ({}) } },
    destroyView() {},
  }
}

test('an externally supplied view host is used and never disposed', () => {
  const host = externalHost()
  const { ctx, registered, disposers } = fakeContext()
  apply(ctx, { viewHost: host })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'electron')
  assert.equal(registered[0].host, host, 'the shell host wins over self-hosting')
  assert.equal(disposers.length, 1)
  disposers[0]()
  assert.equal(registered.length, 0, 'the provider is unregistered on teardown')
  assert.equal(host.disposed, false, 'a host we do not own must not be disposed')
})

test('without a view host the plugin self-hosts and owns the lifecycle', () => {
  const { ctx, registered, disposers } = fakeContext()
  apply(ctx, {})
  assert.equal(registered.length, 1)
  const provider = registered[0]
  assert.ok(provider.host instanceof RemoteElectronViewHost, 'self-hosts when no shell host is given')
  let disposed = false
  provider.host.dispose = () => { disposed = true }
  disposers[0]()
  assert.equal(registered.length, 0, 'the provider is unregistered on teardown')
  assert.equal(disposed, true, 'the self-hosted child is shut down with the fiber')
})

test('an absent writeRoots resolves to the documented defaults', () => {
  // These must go through Config(), not straight into apply(): the other tests
  // here call apply() with a raw object and so skip schemastery, which is
  // exactly the layer that broke. schemastery materializes an absent array key
  // as [], and [] is not nullish, so the provider's `?? defaultWriteRoots()`
  // never fired and every disk write was refused with "none configured".
  const absent = Config({})
  assert.ok(absent.writeRoots.length > 0, 'absent means the workspace + temp defaults')
  assert.ok(absent.readRoots.length > 0, 'and the same for reads')

  // An explicit empty list is a real posture: deny every write. Defaulting in
  // the schema is what keeps absence and [] distinguishable.
  assert.deepEqual(Config({ writeRoots: [], readRoots: [] }).writeRoots, [])
  assert.deepEqual(Config({ writeRoots: ['/x'], readRoots: ['/y'] }).readRoots, ['/y'])
})

test('the chrome world reaches the self-hosted child', () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, { chromeWorld: 'isolated' })
  assert.equal(registered[0].host.options.chromeWorld, 'isolated')
})

test('config reaches the provider', () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, { viewHost: externalHost(), httpOnly: false, writeRoots: ['/tmp/w'], readRoots: ['/tmp/r'] })
  const provider = registered[0]
  assert.equal(provider.httpOnly, false)
  assert.deepEqual(provider.writeRoots, ['/tmp/w'])
  assert.deepEqual(provider.readRoots, ['/tmp/r'])
})

test('omitted config keeps the provider defaults', () => {
  const { ctx, registered } = fakeContext()
  apply(ctx, { viewHost: externalHost() })
  const provider = registered[0]
  assert.equal(provider.httpOnly, true)
  assert.ok(Array.isArray(provider.writeRoots) && provider.writeRoots.length > 0, 'writeRoots defaulted')
  assert.ok(Array.isArray(provider.readRoots) && provider.readRoots.length > 0, 'readRoots defaulted')
})

test('every row in the bundle patch resolves through package exports', async () => {
  // 行在 cordis.patch.yml 里，模块却要靠 package.json 的 exports 才 import 得到 ——
  // 少一条 exports，DSH 只会打一行 "failed to import"，插件照跑、那条功能静默没有。
  // 悬浮球的 todo 桥接就是这么丢的（2026-10-04 实测）。
  const { readFile } = await import('node:fs/promises')
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const names = [...patch.matchAll(/name:\s*(dsh-browser-plus[^\s]*)/g)].map(match => match[1])
  assert.ok(names.length >= 6, 'the patch lists the plugin rows')
  for (const name of names) {
    const subpath = name === 'dsh-browser-plus' ? '.' : './' + name.slice('dsh-browser-plus/'.length)
    assert.ok(pkg.exports[subpath] !== undefined, name + ' has no exports entry, so the loader cannot import it')
  }
})
