import assert from 'node:assert/strict'
import test from 'node:test'

import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'
import { apply, internals } from '../lib/tool-browser/index.js'

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
}

class FakeHost {
  constructor() {
    this.views = []
    this.log = []
    this.nextId = 1
  }

  createView(key, label) {
    this.views.push({ key, label })
    return new FakeView('view:' + String(this.nextId++), this)
  }

  destroyView() {}
  showView() {}
}

function registerTools(browser) {
  const definitions = new Map()
  const ctx = {
    systemPrompt: { section() {} },
    tools: { register(definition) { definitions.set(definition.name, definition) } },
    get(name) { return name === 'browser' ? browser : undefined },
  }
  apply(ctx)
  return definitions
}

test('tab tools recover the keyed session when the tool cache is absent', async () => {
  const key = 'issue-1-tab-recovery'
  const host = new FakeHost()
  const browser = new ElectronBrowserProvider(host)
  const session = await browser.open({ key })
  await browser.openUrl(session, { url: 'https://example.com/', newTab: true })
  const tabs = await browser.listTabs(session)
  assert.equal(tabs.length, 2)

  const definitions = registerTools(browser)
  const exec = { agent: { id: key } }
  try {
    internals.clearSession(key)
    const switched = await definitions.get('browser_switch_tab').execute({ tabId: tabs[0].id }, exec)
    assert.deepEqual(switched, { switched: true })

    internals.clearSession(key)
    const closed = await definitions.get('browser_close_tab').execute({ tabId: tabs[1].id }, exec)
    assert.deepEqual(closed, { closed: true })

    internals.clearSession(key)
    assert.equal((await browser.listTabs(session)).length, 1)
    assert.equal(host.views.length, 2, 'cache recovery must not create a second task session')
  } finally {
    internals.clearSession(key)
  }
})

test('both snapshot tools publish the iframe fields and pass them through', async () => {
  const key = 'issue-frames-passthrough'
  const host = new FakeHost()
  // FakeHost records {key,label} in views and returns the handle separately,
  // so capture the handle to stub its CDP replies.
  const created = []
  const createView = host.createView.bind(host)
  host.createView = (viewKey, label) => {
    const view = createView(viewKey, label)
    created.push(view)
    return view
  }
  const browser = new ElectronBrowserProvider(host)
  await browser.open({ key })
  const frames = [
    { index: 0, url: 'https://example.com/inner', readable: true },
    { index: 1, url: 'https://cross.test/', readable: false },
  ]
  created[0].sendCommand = async (method) => {
    host.log.push({ method })
    if (method === 'Runtime.evaluate') {
      return { result: { value: {
        url: 'https://example.com/frames',
        title: 'frames',
        truncated: false,
        frames,
        elements: [{
          ref: 1,
          kind: 'button',
          label: 'INNER-BUTTON',
          x: 10,
          y: 20,
          loc: '#innerBtn',
          path: '#innerBtn',
          fingerprint: 'button',
          frame: 0,
        }],
        challenge: { blocked: false },
        userControlling: false,
      } } }
    }
    return {}
  }
  const definitions = registerTools(browser)
  const exec = { agent: { id: key } }
  try {
    const snapshot = await definitions.get('browser_snapshot').execute({}, exec)
    assert.deepEqual(snapshot.frames, frames)
    assert.equal(snapshot.elements[0].frame, 0)
    // 两个工具必须发布同一份 schema —— frames 只加在 browser_open 上、
    // 元素 frame 两边都漏掉，就是它被 output schema 静默丢掉的根因。
    assert.deepEqual(
      definitions.get('browser_snapshot').output.schema,
      definitions.get('browser_open').output.schema,
      'the two snapshot tools must not drift apart',
    )
    const declared = definitions.get('browser_open').output.schema.properties
    assert.ok(declared.frames, 'frames is declared')
    assert.ok(declared.elements.items.properties.frame, 'the element frame index is declared')
  } finally {
    internals.clearSession(key)
  }
})
