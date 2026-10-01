import test from 'node:test'
import assert from 'node:assert/strict'

import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

/**
 * Minimal in-memory host seam that can also speak first.
 *
 * The provider is the only party allowed to act on a chrome request, so the
 * fake records the listener the provider registers and lets each test raise an
 * event exactly as the real host would (an authenticated `{ type, taskKey,
 * tabId }`).
 */
class FakeView {
  constructor(id) {
    this.id = id
  }

  async sendCommand(method) {
    if (method === 'Runtime.evaluate') return { result: { value: 'about:blank' } }
    return {}
  }
}

class FakeHost {
  constructor(options = {}) {
    this.views = []
    this.destroyed = []
    this.nextId = 1
    this.createViewArgs = []
    this.chromeListener = undefined
    // A host that predates the chrome channel simply omits the hook.
    if (options.noChromeChannel !== true) {
      this.onChromeEvent = listener => { this.chromeListener = listener }
    }
  }

  createView(key, label) {
    this.createViewArgs.push({ key, label })
    const view = new FakeView(`view:${String(this.nextId++)}`)
    this.views.push(view)
    return view
  }

  destroyView(handle) {
    this.destroyed.push(handle.id)
    // A real host drops the view from its registry; the strip is built from it.
    this.views = this.views.filter(view => view.id !== handle.id)
  }

  showView() {}

  trace() {}
}

const hostViewIds = host => host.views.map(view => view.id)

test('the provider subscribes to chrome tab requests at construction', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  await provider.open()
  assert.equal(typeof host.chromeListener, 'function', 'listener registered without an explicit subscribe call')
  // Silence the unused warning for the provider reference on this path.
  assert.ok(provider)
})

test('a host without the chrome channel is still usable', async () => {
  const host = new FakeHost({ noChromeChannel: true })
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  assert.ok(session.startsWith('browser:'))
})

test('a chrome new-tab request creates a real view through the provider', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  await provider.open()
  assert.equal(host.views.length, 1)

  host.chromeListener({ type: 'new-tab', taskKey: 'default' })
  assert.equal(host.views.length, 2, 'the provider owns view creation, not the host')
  assert.deepEqual(hostViewIds(host), ['view:1', 'view:2'])
})

test('a chrome close-tab request destroys exactly the requested view', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  await provider.open()
  host.chromeListener({ type: 'new-tab', taskKey: 'default' })
  host.chromeListener({ type: 'new-tab', taskKey: 'default' })
  assert.equal(host.views.length, 3)

  host.chromeListener({ type: 'close-tab', taskKey: 'default', tabId: 'view:2' })
  assert.deepEqual(host.destroyed, ['view:2'])
  assert.deepEqual(hostViewIds(host), ['view:1', 'view:3'])
})

test('a chrome activate-tab request moves the session active index', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  host.chromeListener({ type: 'new-tab', taskKey: 'default' })
  assert.equal((await provider.listTabs(session)).find(tab => tab.active)?.id !== undefined, true)

  host.chromeListener({ type: 'activate-tab', taskKey: 'default', tabId: 'view:1' })
  const tabs = await provider.listTabs(session)
  const active = tabs.find(tab => tab.active)
  // listTabs reports the provider's own tab ids; the first created tab is view:1.
  assert.equal(tabs.indexOf(active), 0, 'the first tab is active again')
})

test('stale or malformed chrome requests are dropped instead of throwing', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  await provider.open()
  const before = host.views.length

  host.chromeListener({ type: 'new-tab', taskKey: 'no-such-task' })
  host.chromeListener({ type: 'close-tab', taskKey: 'default', tabId: 'view:does-not-exist' })
  host.chromeListener({ type: 'activate-tab', taskKey: 'default', tabId: 'view:does-not-exist' })
  host.chromeListener({ type: 'nonsense', taskKey: 'default', tabId: 'view:1' })
  host.chromeListener({ taskKey: 'default' })
  host.chromeListener(null)
  host.chromeListener('new-tab')

  assert.equal(host.views.length, before, 'no view was created for an unknown task')
  assert.deepEqual(host.destroyed, [], 'no view was destroyed for an unknown tab')
  assert.ok(provider)
})

test('a chrome request for one task never touches another task session', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  await provider.open({ key: 'alpha' })
  await provider.open({ key: 'beta' })
  assert.equal(host.views.length, 2)

  host.chromeListener({ type: 'new-tab', taskKey: 'alpha' })
  assert.equal(host.views.length, 3)
  assert.deepEqual(host.createViewArgs.map(arg => arg.key), ['alpha', 'beta', 'alpha'])
})
