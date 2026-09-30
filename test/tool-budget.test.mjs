import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, internals } from '../lib/tool-browser/index.js'

/** The tool layer's per-call budget clamp and its bounded history rows. */

const TASK = { agent: { id: 'budget-task' } }
const TASK_INFO = { key: 'budget-task', label: '', active: true, tabs: 1, status: 'idle', control: 'agent', updatedAt: 0 }

function fakeBrowser(seen) {
  return {
    async open() { return 'sess-1' },
    async getTask() { return TASK_INFO },
    async updateTask() { return TASK_INFO },
    async waitForElement(_session, request) {
      seen.push(['wait', request.timeoutMs])
      return { found: true, selector: request.selector, tag: 'div', text: '' }
    },
    async content(_session, request) {
      seen.push(['content', request.timeoutMs])
      return { content: 'body', truncated: false }
    },
    async history() {
      return [{ seq: 1, action: 'execute', ok: true, at: 0, params: { script: 'x'.repeat(2_000) } }]
    },
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

test('a per-call timeout is capped below the tool budget', async () => {
  const seen = []
  const tools = registerTools(fakeBrowser(seen))
  try {
    await tools.get('browser_wait_for').execute({ selector: '#a', timeoutMs: 900_000 }, TASK)
    await tools.get('browser_content').execute({ format: 'txt', timeoutMs: 900_000 }, TASK)
    await tools.get('browser_wait_for').execute({ selector: '#a', timeoutMs: 2_000 }, TASK)
    assert.deepEqual(seen, [['wait', 55_000], ['content', 55_000], ['wait', 2_000]],
      'clamped to budget minus headroom, and a smaller request is untouched')
  } finally {
    internals.clearSession(TASK.agent.id)
  }
})

test('browser_history bounds long params instead of deep-cloning them', async () => {
  const tools = registerTools(fakeBrowser([]))
  try {
    const result = await tools.get('browser_history').execute({}, TASK)
    const params = result.entries[0].params
    assert.ok(params.script.length < 2_000, 'the stored script is clipped for the model')
    assert.match(params.script, /more\)$/, 'and says how much was withheld')
  } finally {
    internals.clearSession(TASK.agent.id)
  }
})
