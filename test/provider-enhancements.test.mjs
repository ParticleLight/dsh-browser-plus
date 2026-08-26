import assert from 'node:assert/strict'
import test from 'node:test'

import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

class FakeView {
  constructor(id, host) {
    this.id = id
    this.host = host
  }

  async sendCommand(method, params) {
    this.host.log.push({ method, params })
    if (method === 'Runtime.evaluate') return this.host.evalReplies.shift() ?? { result: { value: null } }
    return this.host.commandReplies.shift() ?? {}
  }
}

class FakeHost {
  constructor() {
    this.views = []
    this.log = []
    this.evalReplies = []
    this.commandReplies = []
    this.nextId = 1
    this.taskUpdates = []
  }

  createView() {
    const view = new FakeView('view:' + String(this.nextId++), this)
    this.views.push(view)
    return view
  }

  destroyView() {}
  showView() {}
  trace() {}

  async updateTask(key, update) {
    this.taskUpdates.push({ key, update })
    return undefined
  }
}

class AuthoritativeTaskHost extends FakeHost {
  constructor() {
    super()
    this.tasks = new Map()
  }

  createView(key = 'default', label = '') {
    const view = super.createView()
    if (!this.tasks.has(key)) {
      this.tasks.set(key, {
        key,
        label,
        active: true,
        tabs: 1,
        status: 'idle',
        control: 'agent',
        updatedAt: Date.now(),
      })
    }
    return view
  }

  async getTask(key) {
    return this.tasks.get(key)
  }

  async updateTask(key, update) {
    this.taskUpdates.push({ key, update })
    const previous = this.tasks.get(key)
    const next = { ...previous, ...update, updatedAt: Date.now() }
    this.tasks.set(key, next)
    return next
  }

  async listTasks() {
    return [...this.tasks.values()]
  }
}

function rawSnapshot() {
  return {
    url: 'https://example.com/',
    title: 'Example',
    elements: [{
      ref: 1,
      kind: 'button',
      label: 'Continue',
      selector: '#continue',
      loc: '#continue',
      path: '#continue',
      fingerprint: 'BUTTON\u001fsubmit\u001fcontinue\u001f\u001f\u001fContinue',
      x: 42,
      y: 24,
    }],
    truncated: false,
    challenge: { blocked: false },
    userControlling: false,
  }
}

test('snapshot references click only their retained target', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open({ key: 'task-ref' })
  host.evalReplies.push({ result: { value: rawSnapshot() } })
  const snapshot = await provider.snapshot(session)

  assert.match(snapshot.snapshotId, /^snapshot:/)
  assert.equal(snapshot.elements[0].ref, 1)

  host.evalReplies.push({ result: { value: { x: 44, y: 26, scrollX: 0, scrollY: 80, maxX: 0, maxY: 600 } } })
  await provider.clickRef(session, { snapshotId: snapshot.snapshotId, ref: 1 })

  const inputs = host.log.filter(entry => entry.method === 'Input.dispatchMouseEvent')
  assert.equal(inputs.length, 2)
  assert.deepEqual(inputs.map(entry => entry.params.type), ['mousePressed', 'mouseReleased'])
  assert.deepEqual(inputs.map(entry => [entry.params.x, entry.params.y]), [[44, 26], [44, 26]])
})

test('reset invalidates retained snapshot references', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  host.evalReplies.push({ result: { value: rawSnapshot() } })
  const snapshot = await provider.snapshot(session)

  await provider.reset(session)
  await assert.rejects(
    () => provider.clickRef(session, { snapshotId: snapshot.snapshotId, ref: 1 }),
    error => error.code === 'BROWSER_SNAPSHOT_UNKNOWN',
  )
})

test('back reports false without a previous history entry', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  host.commandReplies.push({ currentIndex: 0, entries: [{ id: 7 }] })

  assert.equal(await provider.back(session), false)
  assert.equal(host.log[0].method, 'Page.getNavigationHistory')
  const history = await provider.history(session)
  assert.equal(history.at(-1).action, 'back')
  assert.equal(history.at(-1).params.navigated, false)
})

test('scroll defaults to a viewport step and reports final coordinates', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  host.evalReplies.push({ result: { value: { x: 0, y: 480, maxX: 0, maxY: 1600 } } })

  const result = await provider.scroll(session, {})
  assert.deepEqual(result, { x: 0, y: 480, maxX: 0, maxY: 1600 })
  assert.equal(host.log[0].method, 'Runtime.evaluate')
  assert.match(host.log[0].params.expression, /effectiveDeltaY/)
})


test('status-only updates preserve Host-authoritative human control', async () => {
  const host = new AuthoritativeTaskHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open({ key: 'task-authority', label: 'Authority' })

  await provider.getTask(session)
  await host.updateTask('task-authority', { control: 'human', status: 'waiting-user', latestAction: 'human took control' })
  assert.equal((await provider.getTask(session)).control, 'human')

  const updated = await provider.updateTask(session, { status: 'idle', latestAction: 'completed action' })
  assert.equal(updated.control, 'human')
  assert.equal(host.tasks.get('task-authority').control, 'human')
  const lastUpdate = host.taskUpdates.at(-1)
  assert.equal(Object.hasOwn(lastUpdate.update, 'control'), false)
})


test('Agent CDP input suppresses automatic user handoff before dispatch', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()

  await provider.click(session, { x: 12, y: 34 })
  assert.equal(host.log[0].method, 'Runtime.evaluate')
  assert.match(host.log[0].params.expression, /data-dsh-agent-input-until/)
  assert.equal(host.log[1].method, 'Input.dispatchMouseEvent')
  assert.equal(host.log[2].method, 'Input.dispatchMouseEvent')

  await provider.type(session, { text: 'hello' })
  assert.equal(host.log[3].method, 'Runtime.evaluate')
  assert.equal(host.log[4].method, 'Input.insertText')
})

test('task handoff exposes waiting-user and Agent resume states', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open({ key: 'task-handoff', label: 'Review' })

  assert.equal((await provider.getTask(session)).status, 'idle')
  const waiting = await provider.setHandoff(session, 'waiting-user')
  assert.equal(waiting.status, 'waiting-user')
  assert.equal(waiting.control, 'human')

  const resumed = await provider.setHandoff(session, 'agent')
  assert.equal(resumed.status, 'idle')
  assert.equal(resumed.control, 'agent')
  assert.ok(host.taskUpdates.length >= 2)
})
