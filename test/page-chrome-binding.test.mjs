import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { PAGE_CHROME_SCRIPT, buildPageChromeScript } from '../lib/browser-electron/page-chrome.js'
import { taskSummaryUrl } from '../lib/browser-electron/task-summary.js'

const hostPath = new URL('../lib/browser-electron/host-main.js', import.meta.url)

/**
 * host-main.js imports electron, so it cannot be imported under plain Node.
 * Its page-safety helpers are top-level function declarations, though, so the
 * tests slice them out of the build and run them in a stub scope: the behaviour
 * under test is exactly the shipped code, without a hand-written copy.
 */
function hostFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `host-main defines ${name}`)
  const end = source.indexOf('\n}', start)
  assert.ok(end > start, `${name} ends at column 0`)
  return source.slice(start, end + 2)
}

function loadHostFunction(source, name, scope = {}) {
  const names = Object.keys(scope)
  const factory = new Function(...names, `${hostFunctionSource(source, name)}\nreturn ${name}`)
  return factory(...names.map(key => scope[key]))
}

/** One single-line arrow definition from the generated chrome script. */
function scriptLine(script, marker) {
  const start = script.indexOf(marker)
  assert.ok(start >= 0, `chrome script defines ${marker}`)
  const end = script.indexOf('\n', start)
  return script.slice(start, end < 0 ? script.length : end)
}

/** Run one chrome emit helper against a fake binding and collect its payloads. */
function loadEmit(script, marker, bindingToken) {
  const calls = []
  const window = { __dshBrowserTaskAction: payload => calls.push(payload) }
  const name = marker.replace('const ', '')
  const factory = new Function('bindingToken', 'window', `${scriptLine(script, marker)}\nreturn ${name}`)
  return { emit: factory(bindingToken, window), calls }
}

/** The chrome's human-readable trail line, evaluated from the shipped script. */
function loadDescribe(script) {
  const start = script.indexOf('    const describe = (entry) => {')
  assert.ok(start >= 0, 'chrome script defines describe')
  const end = script.indexOf('\n    }', start)
  assert.ok(end > start, 'describe ends at four-space indentation')
  return new Function(`${script.slice(start, end + 6)}\nreturn describe`)()
}

test('host redacts page-visible trail params before they reach the page', async () => {
  const source = await readFile(hostPath, 'utf8')
  const redact = loadHostFunction(source, 'redactTraceParams', { taskSummaryUrl })

  assert.deepEqual(redact('type', { text: 'hunter2-password' }), { chars: 16 })
  assert.deepEqual(redact('execute', { script: 'steal(document.cookie)' }), {})
  assert.deepEqual(redact('navigate', { url: 'https://bank.example/account?token=abc' }), { url: 'https://bank.example' })
  assert.deepEqual(
    redact('download', { url: 'https://bank.example/statement?t=1', savePath: 'C:\\Users\\me\\statement-2026.pdf' }),
    { url: 'https://bank.example', savePath: 'statement-2026.pdf' },
  )
  assert.deepEqual(
    redact('uploadFile', { filePath: 'C:\\Users\\me\\.ssh\\id_rsa', selector: '#file' }),
    { selector: '#file' },
  )
  assert.deepEqual(redact('pressKey', { key: 'a', modifiers: ['ctrl'] }), { modifiers: ['ctrl'] })
  assert.deepEqual(redact('replay', { seq: 3, of: 'type', text: 'pw' }), { seq: 3, of: 'type', chars: 2 })
  assert.deepEqual(redact('replay', { seq: 4, of: 'execute', script: 'x()' }), { seq: 4, of: 'execute' })
  assert.deepEqual(redact('unrecordedAction', { secret: 'value' }), {})
})

test('redaction keeps the trail readable for the page UI', async () => {
  const source = await readFile(hostPath, 'utf8')
  const redact = loadHostFunction(source, 'redactTraceParams', { taskSummaryUrl })

  assert.deepEqual(redact('click', { x: 12, y: 34 }), { x: 12, y: 34 })
  assert.deepEqual(redact('content', { selector: '#main' }), { selector: '#main' })
  assert.deepEqual(redact('screenshot', { fullPage: true }), { fullPage: true })
  assert.deepEqual(redact('fill', { fields: 3, submit: false }), { fields: 3, submit: false })
  assert.deepEqual(redact('navigate', { url: 'https://a.example' }), { url: 'https://a.example' })
})

test('bootstrap trail carries no typed text, script, query string, or directory path', async () => {
  const source = await readFile(hostPath, 'utf8')
  const redact = loadHostFunction(source, 'redactTraceParams', { taskSummaryUrl })
  assert.match(
    source,
    /params: redactTraceParams\(record\.action, record\.params\)/,
    'activeTraceForTask funnels every page-visible entry through the redactor',
  )
  const entries = [
    { action: 'type', params: { text: 'hunter2-password' }, ok: true, at: 1 },
    { action: 'execute', params: { script: 'steal(document.cookie)' }, ok: true, at: 2 },
    { action: 'navigate', params: { url: 'https://bank.example/account?token=abc' }, ok: true, at: 3 },
    { action: 'download', params: { url: 'https://bank.example/statement', savePath: 'C:\\Users\\me\\statement-2026.pdf' }, ok: true, at: 4 },
  ]
  const trail = entries.map(entry => ({
    action: entry.action,
    params: redact(entry.action, entry.params),
    ok: entry.ok,
    at: entry.at,
  }))
  const injected = JSON.stringify({ kind: 'bootstrap', trail })
  for (const secret of ['hunter2-password', 'steal(document.cookie)', 'token=abc', 'C:\\Users', 'id_rsa']) {
    assert.ok(!injected.includes(secret), `injected trail never carries ${secret}`)
  }
})

test('page chrome emits control payloads with the per-view token', () => {
  const script = buildPageChromeScript('tok-abc123')
  assert.match(script, /const bindingToken = "tok-abc123"/, 'token is a closure constant')

  const action = loadEmit(script, 'const emitTaskAction', 'tok-abc123')
  action.emit('task-1')
  assert.deepEqual(JSON.parse(action.calls[0]), { type: 'switch-task', taskKey: 'task-1', token: 'tok-abc123' })

  const control = loadEmit(script, 'const emitTaskControl', 'tok-abc123')
  control.emit('task-1', 'human')
  assert.deepEqual(JSON.parse(control.calls[0]), { type: 'set-control-owner', taskKey: 'task-1', control: 'human', token: 'tok-abc123' })

  const panels = loadEmit(script, 'const emitWorkspacePanels', 'tok-abc123')
  panels.emit(true, false)
  assert.deepEqual(JSON.parse(panels.calls[0]), { type: 'set-workspace-panels', tasks: true, trail: false, token: 'tok-abc123' })

  const bootstrap = loadEmit(script, 'const requestChromeBootstrap', 'tok-abc123')
  bootstrap.emit()
  assert.deepEqual(JSON.parse(bootstrap.calls[0]), { type: 'request-chrome-bootstrap', token: 'tok-abc123' })
})

test('a tokenless chrome copy stays silent instead of emitting unauthenticated actions', () => {
  const script = buildPageChromeScript()
  assert.match(script, /const bindingToken = ""/, 'no-argument build keeps the tokenless fallback')
  assert.ok(script.includes('attachShadow'), 'the tokenless copy is still a mountable script')
  assert.match(PAGE_CHROME_SCRIPT, /const bindingToken = ""/, 'the provider copy is the tokenless fallback')

  for (const marker of ['const emitTaskAction', 'const emitTaskControl', 'const emitWorkspacePanels', 'const requestChromeBootstrap']) {
    const { emit, calls } = loadEmit(script, marker, '')
    if (marker === 'const emitTaskAction') emit('task-1')
    else if (marker === 'const emitTaskControl') emit('task-1', 'human')
    else if (marker === 'const emitWorkspacePanels') emit(true, false)
    else emit()
    assert.equal(calls.length, 0, `${marker} never calls the binding without a token`)
  }
})

test('host authorizes page-emitted actions with the per-view token', async () => {
  const source = await readFile(hostPath, 'utf8')
  const authorize = loadHostFunction(source, 'authorizeChromeAction')

  assert.equal(authorize({ type: 'set-control-owner', token: 'tok-abc123' }, 'tok-abc123'), true)
  assert.equal(authorize({ type: 'set-control-owner' }, 'tok-abc123'), false, 'missing token is ignored')
  assert.equal(authorize({ type: 'set-control-owner', token: 'wrong' }, 'tok-abc123'), false, 'wrong token is ignored')
  assert.equal(authorize({ type: 'set-control-owner', token: '' }, 'tok-abc123'), false, 'empty token is ignored')
  assert.equal(authorize(null, 'tok-abc123'), false)
  assert.equal(authorize(['set-control-owner'], 'tok-abc123'), false)

  assert.match(source, /const chromeToken = randomBytes\(24\)\.toString\('hex'\)/, 'each view gets a random token')
  assert.match(source, /buildPageChromeScript\(chromeTokens\.get\(view\) \?\? ''\)/, 'the chrome is built with the view token')
  assert.match(source, /if \(!authorizeChromeAction\(action, chromeToken\)\)/, 'the binding handler checks the token')
  const gate = source.indexOf('authorizeChromeAction(action, chromeToken)')
  const dispatch = source.indexOf('switchVisibleTask(action.taskKey)')
  assert.ok(gate >= 0 && dispatch > gate, 'the token gate runs before any action is dispatched')
  assert.ok(!source.includes('256 * 1024 * 1024'), 'the old download cap is gone')
  assert.match(source, /const MAX_DOWNLOAD_BYTES = 64 \* 1024 \* 1024/, 'downloads are capped at 64 MiB')
})

test('the page never receives the binding token', async () => {
  const source = await readFile(hostPath, 'utf8')
  const start = source.indexOf('function chromeBootstrapScript')
  const end = source.indexOf('function chromePatchScript', start)
  assert.ok(start >= 0 && end > start, 'chromeBootstrapScript exists')
  assert.doesNotMatch(source.slice(start, end), /chromeToken|bindingToken/, 'bootstrap payloads carry no token')
})

test('the trail UI still describes redacted entries', () => {
  const describe = loadDescribe(buildPageChromeScript('tok-abc123'))
  assert.equal(describe({ action: 'type', params: { chars: 8 } }), '输入文字（8 字符）')
  assert.equal(describe({ action: 'type', params: {} }), '输入文字')
  assert.equal(describe({ action: 'navigate', params: { url: 'https://a.example' } }), '导航到 https://a.example')
  assert.equal(describe({ action: 'download', params: { savePath: 'statement.pdf' } }), '下载 statement.pdf')
  assert.equal(describe({ action: 'execute', params: {} }), '执行页面脚本')
  assert.equal(describe({ action: 'click', params: { x: 3, y: 4 } }), '点击 (3, 4)')
})
