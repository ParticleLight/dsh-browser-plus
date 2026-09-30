import assert from 'node:assert/strict'
import test from 'node:test'

import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'
import { apply, internals } from '../lib/tool-browser/index.js'

/**
 * browser_restrict used to hold one module-level allow-list, so a rule set by
 * one task silently restricted every other task in the process. The rule is now
 * keyed by the calling task; the plugin-level allowedActions config stays as a
 * default that a task may override for itself.
 */

class FakeView {
  constructor(id, host) {
    this.id = id
    this.host = host
  }

  async sendCommand(method) {
    this.host.log.push({ method })
    if (method === 'Runtime.evaluate') return { result: { value: null } }
    return {}
  }

  async capture() {
    return { base64: Buffer.from('png-bytes').toString('base64'), width: 8, height: 8 }
  }
}

class FakeHost {
  constructor() {
    this.views = []
    this.log = []
    this.nextId = 1
  }

  createView() {
    const view = new FakeView('view:' + String(this.nextId++), this)
    this.views.push(view)
    return view
  }

  destroyView() {}
  showView() {}
}

function registerTools(browser, config) {
  const definitions = new Map()
  const ctx = {
    systemPrompt: { section() {} },
    tools: {
      register(definition) { definitions.set(definition.name, definition) },
      schemas: () => [...definitions.values()].map(definition => ({ name: definition.name })),
    },
    get(name) { return name === 'browser' ? browser : undefined },
  }
  apply(ctx, config)
  return definitions
}

const taskA = { agent: { id: 'restrict-task-a' } }
const taskB = { agent: { id: 'restrict-task-b' } }

function cleanup() {
  internals.clearSession(taskA.agent.id)
  internals.clearSession(taskB.agent.id)
}

test('browser_restrict only restricts the calling task', async () => {
  const browser = new ElectronBrowserProvider(new FakeHost())
  const tools = registerTools(browser)
  try {
    const restricted = await tools.get('browser_restrict').execute({ allowed: ['browser_snapshot'] }, taskA)
    assert.deepEqual(restricted, { restrictedTo: ['browser_snapshot'] })

    await assert.rejects(
      () => tools.get('browser_click').execute({ x: 1, y: 2 }, taskA),
      /restricted for this task/,
    )
    // The other task never opted in, so it keeps working.
    assert.deepEqual(await tools.get('browser_click').execute({ x: 1, y: 2 }, taskB), { clicked: true })
  } finally {
    cleanup()
  }
})

test('lifting one task\'s restriction leaves the other task\'s rule intact', async () => {
  const browser = new ElectronBrowserProvider(new FakeHost())
  const tools = registerTools(browser)
  try {
    await tools.get('browser_restrict').execute({ allowed: ['browser_snapshot'] }, taskA)
    await tools.get('browser_restrict').execute({ allowed: ['browser_snapshot'] }, taskB)

    assert.deepEqual(await tools.get('browser_restrict').execute({ allowed: [] }, taskA), { restrictedTo: [] })
    assert.deepEqual(await tools.get('browser_click').execute({ x: 1, y: 2 }, taskA), { clicked: true })
    await assert.rejects(
      () => tools.get('browser_click').execute({ x: 1, y: 2 }, taskB),
      /restricted for this task/,
    )
  } finally {
    cleanup()
  }
})

test('the allowedActions config is a default that a task can override for itself', async () => {
  const browser = new ElectronBrowserProvider(new FakeHost())
  const tools = registerTools(browser, { allowedActions: ['browser_snapshot'] })
  try {
    await assert.rejects(() => tools.get('browser_click').execute({ x: 1, y: 2 }, taskA), /restricted for this task/)
    await assert.rejects(() => tools.get('browser_click').execute({ x: 1, y: 2 }, taskB), /restricted for this task/)

    await tools.get('browser_restrict').execute({ allowed: [] }, taskA)
    assert.deepEqual(await tools.get('browser_click').execute({ x: 1, y: 2 }, taskA), { clicked: true })
    await assert.rejects(() => tools.get('browser_click').execute({ x: 1, y: 2 }, taskB), /restricted for this task/)
  } finally {
    cleanup()
  }
})

test('browser_restrict rejects names that are not browser tools', async () => {
  const browser = new ElectronBrowserProvider(new FakeHost())
  const tools = registerTools(browser)
  try {
    await assert.rejects(
      () => tools.get('browser_restrict').execute({ allowed: ['read_image'] }, taskA),
      /must start with "browser_"/,
    )
  } finally {
    cleanup()
  }
})
test('browser_restrict rejects a name that is not a registered tool', async () => {
  const browser = new ElectronBrowserProvider(new FakeHost())
  const tools = registerTools(browser)
  try {
    await assert.rejects(
      () => tools.get('browser_restrict').execute({ allowed: ['browser_snapsho'] }, taskA),
      /no such browser tool/,
    )
    // A real name is still accepted.
    assert.deepEqual(
      await tools.get('browser_restrict').execute({ allowed: ['browser_snapshot'] }, taskA),
      { restrictedTo: ['browser_snapshot'] },
    )
  } finally {
    cleanup()
  }
})

test('browser_handoff is refused while this task is restricted', async () => {
  const browser = new ElectronBrowserProvider(new FakeHost())
  const tools = registerTools(browser)
  try {
    await tools.get('browser_restrict').execute({ allowed: ['browser_snapshot'] }, taskA)
    await assert.rejects(
      () => tools.get('browser_handoff').execute({ state: 'waiting-user' }, taskA),
      /restricted for this task/,
    )
  } finally {
    cleanup()
  }
})

test('a screenshot is guarded only when it writes a file', async () => {
  const browser = new ElectronBrowserProvider(new FakeHost())
  const tools = registerTools(browser)
  try {
    await tools.get('browser_restrict').execute({ allowed: ['browser_snapshot'] }, taskA)
    // Read-only capture stays available: the docs promise read tools are never blocked.
    const shot = await tools.get('browser_screenshot').execute({}, taskA)
    assert.match(shot.dataUrl, /^data:image\/png;base64,/)
    // The writing variant is a file write and is guarded.
    await assert.rejects(
      () => tools.get('browser_screenshot').execute({ savePath: 'shot.png' }, taskA),
      /restricted for this task/,
    )
  } finally {
    cleanup()
  }
})
