import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/browser-electron/entry.js'
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
