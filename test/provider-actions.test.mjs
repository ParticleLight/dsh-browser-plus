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
    this.createViewArgs = []
  }

  createView(key, label) {
    this.createViewArgs.push({ key, label })
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

test('doubleClick dispatches a clickCount 2 press/release pair', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  await provider.doubleClick(session, { x: 10, y: 20 })
  assert.equal(host.log.length, 2)
  assert.equal(host.log[0].params.type, 'mousePressed')
  assert.equal(host.log[0].params.clickCount, 2)
  assert.equal(host.log[1].params.type, 'mouseReleased')
  assert.equal(host.log[1].params.clickCount, 2)
  assert.equal(host.log[0].params.x, 10)
  const history = await provider.history(session)
  assert.equal(history[0].action, 'doubleClick')
})

test('hover dispatches one mouseMoved with no button', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  await provider.hover(session, { x: 33, y: 44 })
  assert.equal(host.log.length, 1)
  assert.equal(host.log[0].method, 'Input.dispatchMouseEvent')
  assert.equal(host.log[0].params.type, 'mouseMoved')
  assert.equal(host.log[0].params.button, 'none')
  assert.equal(host.log[0].params.x, 33)
})

test('uploadFile resolves a nodeId through the DOM domain and sets files', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  // Stub the DOM-domain replies: document node resolves, then a matched input.
  // Keep the fake's log contract so the CDP call sequence stays assertable.
  host.views[0].sendCommand = async (method, params) => {
    host.log.push({ method, params })
    return method === 'DOM.getDocument' ? { root: { nodeId: 1 } }
      : method === 'DOM.querySelector' ? { nodeId: 42 }
        : {}
  }
  const result = await provider.uploadFile(session, { filePath: 'C:/tmp/x.txt' })
  assert.equal(result.path, 'C:/tmp/x.txt')
  const getDoc = host.log.find(e => e.method === 'DOM.getDocument')
  assert.ok(getDoc, 'asks for the document')
  const query = host.log.find(e => e.method === 'DOM.querySelector')
  assert.equal(query.params.selector, 'input[type="file"]')
  const set = host.log.find(e => e.method === 'DOM.setFileInputFiles')
  assert.deepEqual(set.params.files, ['C:/tmp/x.txt'])
  assert.equal(set.params.nodeId, 42)
})

test('uploadFile reports a missing file input', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  // Stub sendCommand for the missing-input scenario: document resolves but
  // DOM.querySelector answers nodeId 0 (no match).
  host.views[0].sendCommand = async (method, params) => {
    host.log.push({ method, params })
    return method === 'DOM.getDocument' ? { root: { nodeId: 1 } }
      : method === 'DOM.querySelector' ? { nodeId: 0 }
        : {}
  }
  await assert.rejects(() => provider.uploadFile(session, { filePath: 'C:/tmp/x.txt' }), /no file input/)
})

test('waitForElement polls until the element appears', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  // 前两次 evaluate 返回 null,第三次返回 found
  host.evalReplies.push(
    { result: { value: null } },
    { result: { value: null } },
    { result: { value: { found: true, selector: '#go', tag: 'button', text: 'Go' } } },
  )
  const result = await provider.waitForElement(session, { selector: '#go', timeoutMs: 3000 })
  assert.equal(result.found, true)
  assert.equal(result.tag, 'button')
  assert.equal(host.log.filter(e => e.method === 'Runtime.evaluate').length, 3)
  const history = await provider.history(session)
  assert.equal(history[0].action, 'waitForElement')
})

test('open forwards a window key and label to the host', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  await provider.open({ key: 'task-1', label: 'rewards' })
  assert.deepEqual(host.createViewArgs[0], { key: 'task-1', label: 'rewards' })
  await provider.open()
  assert.deepEqual(host.createViewArgs[1], { key: 'default', label: undefined })
})

test('waitForElement times out with BROWSER_WAIT_TIMEOUT', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  host.evalReplies.push({ result: { value: null } })
  await assert.rejects(
    () => provider.waitForElement(session, { selector: '#never', timeoutMs: 600 }),
    (error) => error.code === 'BROWSER_WAIT_TIMEOUT',
  )
})

test('setSpace labels the window and records it', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  const handle = host.views[0]
  let labeled = null
  handle.label = async (label) => { labeled = label }
  await provider.setSpace(session, 'rewards')
  assert.equal(labeled, 'rewards')
  const history = await provider.history(session)
  assert.equal(history[0].action, 'setSpace')
})

test('listSpaces forwards to the host', async () => {
  const host = new FakeHost()
  host.listWindows = async () => [{ key: 'task-1', label: 'rewards' }]
  const provider = new ElectronBrowserProvider(host)
  const spaces = await provider.listSpaces()
  assert.deepEqual(spaces, [{ key: 'task-1', label: 'rewards' }])
})
