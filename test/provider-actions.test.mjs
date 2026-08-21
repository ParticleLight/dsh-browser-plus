import test from 'node:test'
import assert from 'node:assert/strict'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

/**
 * Minimal in-memory host seam. A real view handle answers CDP commands; this
 * fake queues replies for Runtime.evaluate (so execute/snapshot paths can be
 * driven deterministically) and lets tests override per-view behavior (e.g.
 * clearDialog) directly on the returned handle.
 */
class FakeView {
  constructor(id, host) {
    this.id = id
    this.host = host
    // Optional JS-dialog supervision; tests assign it when they need it.
    this.clearDialog = undefined
  }

  async sendCommand(method, params) {
    this.host.log.push({ method, params })
    // The only reply path the provider exercises with this fake is a
    // Runtime.evaluate: hand back the next queued reply.
    if (method === 'Runtime.evaluate') {
      const reply = this.host.evalReplies.shift()
      return reply ?? {}
    }
    return {}
  }
}

class FakeHost {
  constructor() {
    this.views = []
    this.evalReplies = []
    this.nextId = 1
    this.log = []
  }

  createView() {
    const view = new FakeView(`view:${String(this.nextId++)}`, this)
    this.views.push(view)
    return view
  }

  destroyView(handle) {
    // no-op: views are cheap in-memory
  }

  showView(handle) {
    // no-op
  }

  trace(viewId, entry) {
    // no-op: trail mirroring is the provider's concern, not the fake's
  }
}

test('execute records an auto-accepted dialog before running the script', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  // 桩:clearDialog 返回一次 dialog,之后为 null
  let dialogPings = 0
  host.views[0].clearDialog = async () => {
    dialogPings += 1
    return dialogPings === 1 ? { type: 'confirm', message: 'really?' } : null
  }
  host.evalReplies.push({ result: { value: 42 } })
  const result = await provider.execute(session, { script: '1 + 41' })
  assert.equal(result.ok, true)
  const history = await provider.history(session)
  assert.equal(history[0].action, 'dialog')
  assert.equal(history[0].params.message, 'really?')
})

test('pressKey dispatches keyDown and keyUp with CDP key descriptors', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  await provider.pressKey(session, { key: 'Enter' })
  assert.equal(host.log.length, 2)
  assert.equal(host.log[0].method, 'Input.dispatchKeyEvent')
  assert.equal(host.log[0].params.type, 'keyDown')
  assert.equal(host.log[0].params.key, 'Enter')
  assert.equal(host.log[0].params.windowsVirtualKeyCode, 13)
  assert.equal(host.log[0].params.text, '\r')
  assert.equal(host.log[1].params.type, 'keyUp')
  await provider.pressKey(session, { key: 'a', modifiers: ['ctrl'] })
  assert.equal(host.log[2].params.key, 'A')
  assert.equal(host.log[2].params.code, 'KeyA')
  assert.equal(host.log[2].params.modifiers, 2)
  const history = await provider.history(session)
  assert.equal(history[0].action, 'pressKey')
})

test('pressKey rejects unknown keys', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  await assert.rejects(() => provider.pressKey(session, { key: 'Giggles' }), /unsupported key/)
})
