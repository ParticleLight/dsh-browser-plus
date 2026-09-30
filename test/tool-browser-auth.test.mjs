import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../lib/tool-browser/index.js'

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

test('browser_auth clear forwards a scoped filter to the provider', async () => {
  const calls = []
  const browser = {
    open: async () => 'browser:stub',
    clearAuth: async (session, request) => {
      calls.push({ session, request })
      return { removed: 2, names: ['QkmefgKpT5HyO', 'QkmefgKpT5HyP'] }
    },
  }
  const definitions = registerTools(browser)
  const result = await definitions.get('browser_auth').execute(
    { action: 'clear', domain: 'example.com', name: 'QkmefgKpT5HyP' },
    { agent: { id: 'task-auth-clear' } },
  )
  assert.deepEqual(result, { removed: 2, names: ['QkmefgKpT5HyO', 'QkmefgKpT5HyP'] })
  assert.deepEqual(calls, [{ session: 'browser:stub', request: { domain: 'example.com', name: 'QkmefgKpT5HyP' } }])
})

test('browser_auth clear refuses an unscoped request', async () => {
  const browser = {
    open: async () => 'browser:stub-unscoped',
    clearAuth: async () => ({ removed: 0, names: [] }),
  }
  const definitions = registerTools(browser)
  await assert.rejects(
    () => definitions.get('browser_auth').execute({ action: 'clear' }, { agent: { id: 'task-auth-unscoped' } }),
    /requires a domain or name filter/,
  )
})

test('browser_auth clear forwards an explicit full wipe', async () => {
  const calls = []
  const browser = {
    open: async () => 'browser:stub-all',
    clearAuth: async (session, request) => {
      calls.push(request)
      return { removed: 5, names: ['a', 'b', 'c', 'd', 'e'] }
    },
  }
  const definitions = registerTools(browser)
  const result = await definitions.get('browser_auth').execute({ action: 'clear', all: true }, { agent: { id: 'task-auth-all' } })
  assert.equal(result.removed, 5)
  assert.deepEqual(calls, [{ all: true }])
})
