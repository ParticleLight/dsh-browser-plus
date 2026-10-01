import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
} from '@deepseek-ai/dsh-tools'

import { apply } from '../lib/tool-browser/index.js'

/**
 * DSH validates every tool's schemas while registering it, and a rejection
 * there removes the whole plugin from the session rather than failing one
 * call. Running the same checks here means a bad schema is caught by npm test
 * instead of by a restart, which is the only other place it would show up.
 */
function definitions() {
  const registered = new Map()
  apply({
    systemPrompt: { section() {} },
    tools: { register(definition) { registered.set(definition.name, definition) }, schemas: () => [] },
    get: () => undefined,
  })
  return registered
}

test('every tool schema passes the validation DSH applies at registration', () => {
  const registered = definitions()
  assert.ok(registered.size > 0, 'the plugin registered no tools at all')
  for (const [name, definition] of registered) {
    // defineTool already converted the parameter spec, so these are the final
    // schemas DSH compiles at registration (dsh-tools/lib/index.js: assertSupportedJsonSchema(output.schema)).
    assert.doesNotThrow(() => assertObjectJsonSchema(definition.parameters), name + ': the parameter schema is not a valid object schema')
    assert.doesNotThrow(() => assertSupportedJsonSchema(definition.parameters), name + ': the parameter schema uses an unsupported keyword')
    assert.doesNotThrow(() => assertSupportedJsonSchema(definition.output.schema), name + ': the output schema uses an unsupported keyword')
  }
})

test('the schemas accept the calls the tools are actually given', () => {
  // A schema that rejects real usage is as broken as one DSH refuses to load,
  // and only shows up when someone tries the call.
  const registered = definitions()
  const calls = [
    ['browser_open', { url: 'https://example.com/' }],
    ['browser_click', { text: '登录' }],
    ['browser_click', { x: 10, y: 20 }],
    ['browser_click', { selector: '#a', button: 'right', modifiers: ['ctrl', 'shift'] }],
    ['browser_drag', { from: { selector: '#a' }, to: { x: 1, y: 2 }, steps: 8 }],
    ['browser_fill', { fields: [{ selector: '#a', value: 'v' }] }],
    ['browser_scrape', { action: 'start', urls: ['https://a.example/'], script: '1', outPath: '/tmp/rows.jsonl', concurrency: 4 }],
    ['browser_scrape', { action: 'status', id: 'scrape:1' }],
    ['browser_auth', { action: 'restore', file: '/tmp/cookies.json' }],
    ['browser_upload_file', { filePath: '/tmp/a.txt', selector: 'input[type=file]' }],
  ]
  for (const [name, args] of calls) {
    const definition = registered.get(name)
    assert.ok(definition !== undefined, name + ' is not registered')
    // The same call DSH makes on every invocation.
    const problems = validateJsonSchemaValue(definition.parameters, args, '')
    assert.deepEqual(problems, [], name + ' rejects a real call: ' + JSON.stringify(args))
  }
})
