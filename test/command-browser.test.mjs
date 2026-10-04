import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../lib/command-browser/index.js'

/** Minimal context: only the two services the row injects. */
function contextWith(browser = { async ensureWindowVisible() {} }) {
  const registered = []
  const ctx = {
    commands: { register(definition) { registered.push(definition) } },
    browser,
  }
  return { ctx, registered }
}

test('the command row declares the services it needs', () => {
  assert.equal(name, 'browser-command')
  assert.deepEqual(inject, ['browser', 'commands'])
})

test('/browser raises the shared window without a model message', async () => {
  let raised = 0
  const { ctx, registered } = contextWith({ async ensureWindowVisible() { raised += 1 } })
  apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'browser')
  assert.ok(registered[0].description.length > 0)
  const outcome = await registered[0].handler({ rawInput: '' })
  assert.deepEqual(outcome, { kind: 'success', text: '浏览器窗口已打开。' })
  assert.equal(raised, 1)
})

test('/browser reports a failure instead of throwing at the dispatcher', async () => {
  const { ctx, registered } = contextWith({
    async ensureWindowVisible() { throw new Error('host is unavailable') },
  })
  apply(ctx)
  const outcome = await registered[0].handler({ rawInput: '' })
  assert.equal(outcome.kind, 'error')
  assert.match(outcome.text, /host is unavailable/)
})
