import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, internals } from '../lib/tool-browser/index.js'

/**
 * The tool layer caches a session id per task. When the browser row reloads the
 * provider instance is replaced and no longer knows that id, so every later call
 * used to fail with BROWSER_SESSION_UNKNOWN until someone happened to run
 * browser_reset_session.
 */

const TASK = { agent: { id: 'recovery-task' } }
const TASK_INFO = { key: 'recovery-task', label: '', active: true, tabs: 1, status: 'idle', control: 'agent', updatedAt: 0 }

function unknownSessionError() {
  const error = new Error('browser: session "sess-1" is not open')
  error.code = 'BROWSER_SESSION_UNKNOWN'
  return error
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

test('a read reopens the session when the provider has forgotten it', async () => {
  let opens = 0
  let snapshots = 0
  const browser = {
    async open() { opens += 1; return 'sess-' + String(opens) },
    async snapshot() {
      snapshots += 1
      if (snapshots === 1) throw unknownSessionError()
      return { snapshotId: 'snap-1', url: 'https://example.com/', elements: [], truncated: false }
    },
  }
  const tools = registerTools(browser)
  try {
    const result = await tools.get('browser_snapshot').execute({}, TASK)
    assert.equal(result.url, 'https://example.com/')
    assert.equal(opens, 2, 'reopened once')
  } finally {
    internals.clearSession(TASK.agent.id)
  }
})

test('an action reopens the session when the provider has forgotten it', async () => {
  let opens = 0
  let tasks = 0
  const browser = {
    async open() { opens += 1; return 'sess-' + String(opens) },
    async getTask() {
      tasks += 1
      if (tasks === 1) throw unknownSessionError()
      return TASK_INFO
    },
    async updateTask() { return TASK_INFO },
    async click() {},
  }
  const tools = registerTools(browser)
  try {
    assert.deepEqual(await tools.get('browser_click').execute({ x: 1, y: 2 }, TASK), { clicked: true })
    assert.equal(opens, 2, 'reopened once')
  } finally {
    internals.clearSession(TASK.agent.id)
  }
})

test('an unrelated failure is not retried', async () => {
  let opens = 0
  const browser = {
    async open() { opens += 1; return 'sess-' + String(opens) },
    async snapshot() { throw new Error('browser: snapshot evaluation failed: boom') },
  }
  const tools = registerTools(browser)
  try {
    await assert.rejects(() => tools.get('browser_snapshot').execute({}, TASK), /boom/)
    assert.equal(opens, 1, 'did not reopen for an unrelated error')
  } finally {
    internals.clearSession(TASK.agent.id)
  }
})

test('closing an unknown tab id reports closed:false instead of success', async () => {
  let opens = 0
  const browser = {
    async open() { opens += 1; return 'sess-' + String(opens) },
    async getTask() { return TASK_INFO },
    async updateTask() { return TASK_INFO },
    async closeTab() { return false },
  }
  const tools = registerTools(browser)
  try {
    assert.deepEqual(await tools.get('browser_close_tab').execute({ tabId: 'nope' }, TASK), { closed: false })
  } finally {
    internals.clearSession(TASK.agent.id)
  }
})
