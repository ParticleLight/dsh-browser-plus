import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, internals } from '../lib/tool-browser/index.js'

/**
 * Minimal fake of the `ctx.browser` seam as the tool layer sees it: every
 * high-level call is recorded in order, and a call can be held open (gated) so
 * concurrency is observable. Ordering and dedup are tool-layer concerns, so the
 * seam is the right boundary here; the provider/host pair is covered elsewhere.
 */
class FakeBrowserHost {
  constructor() {
    this.log = []
    this.calls = new Map()
    this.gates = new Map()
    this.url = 'about:blank'
    this.tabs = [{ id: 'tab:1', url: 'about:blank', active: true }]
    this.spaces = [{ key: 'default', label: '' }]
  }

  record(method) {
    this.log.push(method)
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1)
  }

  async hold(method) {
    const gate = this.gates.get(method)
    if (gate !== undefined) await gate
  }

  gate(method) {
    let release
    const promise = new Promise(resolve => { release = resolve })
    this.gates.set(method, promise)
    return release
  }

  async open() {
    this.record('open')
    return 'session:fake'
  }

  async getTask() {
    return { key: 'default', label: '', status: 'idle', control: 'agent', tabs: this.tabs.length, active: true, updatedAt: 0 }
  }

  async updateTask() {
    return this.getTask()
  }

  async openUrl(_session, request) {
    this.record('openUrl')
    await this.hold('openUrl')
    this.url = request.url
    this.tabs = [{ id: 'tab:1', url: request.url, active: true }]
  }

  async snapshot() {
    this.record('snapshot')
    await this.hold('snapshot')
    return { snapshotId: 'snap:1', url: this.url, elements: [], truncated: false }
  }

  async listTabs() {
    this.record('listTabs')
    await this.hold('listTabs')
    return this.tabs
  }

  async history() {
    this.record('history')
    return []
  }

  async listSpaces() {
    this.record('listSpaces')
    return this.spaces
  }

  async setSpace(_session, label) {
    this.record('setSpace')
    this.spaces = [{ key: 'default', label }]
  }
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

/** Let every already-scheduled microtask (and the fake's async chain) settle. */
function settle() {
  return new Promise(resolve => setImmediate(resolve))
}

test('a concurrent read waits for the in-flight write (browser_open + browser_snapshot)', async () => {
  const key = 'ordering-open-snapshot'
  const browser = new FakeBrowserHost()
  const releaseOpenUrl = browser.gate('openUrl')
  const definitions = registerTools(browser)
  const exec = { agent: { id: key } }
  try {
    const openPromise = definitions.get('browser_open').execute({ url: 'https://example.com/after' }, exec)
    const snapshotPromise = definitions.get('browser_snapshot').execute({}, exec)

    await settle()
    // openUrl is still in flight. A read that skipped the queue would already
    // have called the seam here and observed the pre-navigation page.
    assert.deepEqual(browser.log, ['open', 'openUrl'], 'the read must not reach the seam while the write is in flight')

    releaseOpenUrl()
    const [opened, snapshot] = await Promise.all([openPromise, snapshotPromise])

    assert.deepEqual(browser.log, ['open', 'openUrl', 'snapshot', 'snapshot'])
    assert.equal(opened.url, 'https://example.com/after')
    assert.equal(snapshot.url, 'https://example.com/after', 'the read must observe the page after the write')
  } finally {
    internals.clearSession(key)
  }
})

test('tab/history/session reads also join the task FIFO', async () => {
  const key = 'ordering-tab-reads'
  const browser = new FakeBrowserHost()
  const releaseOpenUrl = browser.gate('openUrl')
  const definitions = registerTools(browser)
  const exec = { agent: { id: key } }
  try {
    const openPromise = definitions.get('browser_open').execute({ url: 'https://example.com/after' }, exec)
    const tabsPromise = definitions.get('browser_list_tabs').execute({}, exec)
    const historyPromise = definitions.get('browser_history').execute({}, exec)
    const sessionPromise = definitions.get('browser_session').execute({}, exec)

    await settle()
    assert.deepEqual(browser.log, ['open', 'openUrl'], 'no read may run while the write is in flight')

    releaseOpenUrl()
    const [, tabs, history, session] = await Promise.all([openPromise, tabsPromise, historyPromise, sessionPromise])

    const openUrlAt = browser.log.indexOf('openUrl')
    assert.ok(browser.log.indexOf('listTabs') > openUrlAt, 'browser_list_tabs must run after the write')
    assert.ok(browser.log.indexOf('history') > openUrlAt, 'browser_history must run after the write')
    assert.equal(tabs.tabs[0].url, 'https://example.com/after')
    assert.equal(session.tabs[0].url, 'https://example.com/after')
    assert.deepEqual(history.entries, [])
  } finally {
    internals.clearSession(key)
  }
})

test('identical concurrent reads still coalesce into one provider call', async () => {
  const key = 'ordering-read-dedup'
  const browser = new FakeBrowserHost()
  const releaseSnapshot = browser.gate('snapshot')
  const definitions = registerTools(browser)
  const exec = { agent: { id: key } }
  try {
    const first = definitions.get('browser_snapshot').execute({}, exec)
    const second = definitions.get('browser_snapshot').execute({}, exec)
    await settle()
    releaseSnapshot()
    const [a, b] = await Promise.all([first, second])
    assert.equal(browser.calls.get('snapshot'), 1, 'the same readKey must reach the seam exactly once')
    assert.deepEqual(a, b)
  } finally {
    internals.clearSession(key)
  }
})

test('operationTails is bounded: an entry exists only while its queue is busy', async () => {
  const key = 'bounded-busy-queue'
  const browser = new FakeBrowserHost()
  const releaseSnapshot = browser.gate('snapshot')
  const definitions = registerTools(browser)
  const exec = { agent: { id: key } }
  try {
    const pending = definitions.get('browser_snapshot').execute({}, exec)
    await settle()
    assert.equal(internals.operationTailCount, 1, 'a busy task holds exactly one queue entry')

    releaseSnapshot()
    await pending
    await settle()
    assert.equal(internals.operationTailCount, 0, 'the entry is dropped once the queue drains')
  } finally {
    internals.clearSession(key)
  }
})

test('many task keys leave no retained queue entries', async () => {
  const browser = new FakeBrowserHost()
  const definitions = registerTools(browser)
  const keys = ['bounded-a', 'bounded-b', 'bounded-c', 'bounded-d']
  try {
    await Promise.all(keys.map(key => definitions.get('browser_history').execute({}, { agent: { id: key } })))
    await Promise.all(keys.map(key => definitions.get('browser_snapshot').execute({}, { agent: { id: key } })))
    await settle()
    assert.equal(internals.operationTailCount, 0, 'idle task queues must not accumulate')
  } finally {
    for (const key of keys) internals.clearSession(key)
  }
})

test('browser_space list mode still does not open a session just to enumerate', async () => {
  const key = 'space-list-no-open'
  const browser = new FakeBrowserHost()
  const definitions = registerTools(browser)
  const exec = { agent: { id: key } }
  try {
    const result = await definitions.get('browser_space').execute({}, exec)
    assert.equal(browser.calls.get('open'), undefined, 'listing spaces must not force-open a visible window')
    assert.deepEqual(result.spaces, [{ key: 'default', label: '' }])
  } finally {
    internals.clearSession(key)
  }
})
