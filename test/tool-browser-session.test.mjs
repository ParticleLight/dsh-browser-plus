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
