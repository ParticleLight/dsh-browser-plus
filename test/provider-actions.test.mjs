import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

/**
 * Minimal in-memory host seam. A real view handle answers CDP commands; this
 * fake queues replies for Runtime.evaluate (so execute/snapshot paths can be
 * driven deterministically) and lets tests override per-view behavior (e.g.
 * clearDialog) directly on the returned handle.
 */
class FakeView {
  constructor(id, host) {
    this.id = id
    this.host = host
    // Optional JS-dialog supervision; tests assign it when they need it.
    this.clearDialog = undefined
  }

  async sendCommand(method, params) {
    this.host.log.push({ method, params })
    // The only reply path the provider exercises with this fake is a
    // Runtime.evaluate: hand back the next queued reply.
    if (method === 'Runtime.evaluate') {
      const reply = this.host.evalReplies.shift()
      return reply ?? {}
    }
    return {}
  }
}

class FakeHost {
  constructor() {
    this.views = []
    this.evalReplies = []
    this.nextId = 1
    this.log = []
    this.createViewArgs = []
  }

  createView(key, label) {
    this.createViewArgs.push({ key, label })
    const view = new FakeView(`view:${String(this.nextId++)}`, this)
    this.views.push(view)
    return view
  }

  destroyView(handle) {
    // no-op: views are cheap in-memory
  }

  showView(handle) {
    // no-op
  }

  trace(viewId, entry) {
    // no-op: trail mirroring is the provider's concern, not the fake's
  }
}

test('execute records an auto-accepted dialog before running the script', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  // 桩:clearDialog 返回一次 dialog,之后为 null
  let dialogPings = 0
  host.views[0].clearDialog = async () => {
    dialogPings += 1
    return dialogPings === 1 ? { type: 'confirm', message: 'really?' } : null
  }
  host.evalReplies.push({ result: { value: 42 } })
  const result = await provider.execute(session, { script: '1 + 41' })
  assert.equal(result.ok, true)
  const history = await provider.history(session)
  assert.equal(history[0].action, 'dialog')
  assert.equal(history[0].params.message, 'really?')
})

test('pressKey dispatches keyDown and keyUp with CDP key descriptors', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  await provider.pressKey(session, { key: 'Enter' })
  assert.equal(host.log[0].method, 'Runtime.evaluate')
  assert.match(host.log[0].params.expression, /data-dsh-agent-input-until/)
  let keys = host.log.filter(entry => entry.method === 'Input.dispatchKeyEvent')
  assert.equal(keys.length, 2)
  assert.equal(keys[0].params.type, 'keyDown')
  assert.equal(keys[0].params.key, 'Enter')
  assert.equal(keys[0].params.windowsVirtualKeyCode, 13)
  assert.equal(keys[0].params.text, '\r')
  assert.equal(keys[1].params.type, 'keyUp')
  await provider.pressKey(session, { key: 'a', modifiers: ['ctrl'] })
  keys = host.log.filter(entry => entry.method === 'Input.dispatchKeyEvent')
  assert.equal(keys[2].params.key, 'a')
  assert.equal(keys[2].params.code, 'KeyA')
  assert.equal(keys[2].params.modifiers, 2)
  const history = await provider.history(session)
  assert.equal(history[0].action, 'pressKey')
})

test('pressKey rejects unknown keys', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  await assert.rejects(() => provider.pressKey(session, { key: 'Giggles' }), /unsupported key/)
})

test('doubleClick dispatches a clickCount 2 press/release pair', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  await provider.doubleClick(session, { x: 10, y: 20 })
  assert.equal(host.log[0].method, 'Runtime.evaluate')
  assert.match(host.log[0].params.expression, /data-dsh-agent-input-until/)
  const clicks = host.log.filter(entry => entry.method === 'Input.dispatchMouseEvent')
  assert.equal(clicks.length, 2)
  assert.equal(clicks[0].params.type, 'mousePressed')
  assert.equal(clicks[0].params.clickCount, 2)
  assert.equal(clicks[1].params.type, 'mouseReleased')
  assert.equal(clicks[1].params.clickCount, 2)
  assert.equal(clicks[0].params.x, 10)
  assert.equal(clicks[0].params.y, 20)
  assert.equal(clicks[1].params.x, 10)
  assert.equal(clicks[1].params.y, 20)
  const history = await provider.history(session)
  assert.equal(history[0].action, 'doubleClick')
})

test('hover dispatches one mouseMoved with no button', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  await provider.hover(session, { x: 33, y: 44 })
  const inputs = host.log.filter(entry => entry.method === 'Input.dispatchMouseEvent')
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].params.type, 'mouseMoved')
  assert.equal(inputs[0].params.button, 'none')
  assert.equal(inputs[0].params.x, 33)
})

test('synthesized input asks for focus emulation once per view, before dispatching', async () => {
  // Chromium drops a synthesized mouse press while the renderer believes it is
  // unfocused, which is the normal state for a background view. Without this
  // handshake a click resolves its target, reports success, and does nothing.
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  await provider.click(session, { x: 1, y: 2 })
  await provider.click(session, { x: 3, y: 4 })
  await provider.hover(session, { x: 5, y: 6 })
  const emulated = host.log.filter(entry => entry.method === 'Emulation.setFocusEmulationEnabled')
  assert.equal(emulated.length, 1, 'once per view, not once per action')
  assert.equal(emulated[0].params.enabled, true)
  const firstInput = host.log.findIndex(entry => entry.method === 'Input.dispatchMouseEvent')
  assert.ok(host.log.indexOf(emulated[0]) < firstInput, 'the handshake comes before the input it protects')
})

/** A real file inside its own root, so the read guard admits the upload. */
function tempUpload(name = 'x.txt') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-upload-'))
  const file = join(dir, name)
  writeFileSync(file, 'payload')
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('uploadFile resolves a nodeId through the DOM domain and sets files', async () => {
  const upload = tempUpload()
  try {
    const host = new FakeHost()
    const provider = new ElectronBrowserProvider(host, { readRoots: [upload.dir] })
    const session = await provider.open()
    // Stub the DOM-domain replies: document resolves, then a matched input.
    host.views[0].sendCommand = domStub(host, 42)
    const result = await provider.uploadFile(session, { filePath: upload.file })
    assert.equal(result.path, upload.file)
  const getDoc = host.log.find(e => e.method === 'DOM.getDocument')
  assert.ok(getDoc, 'asks for the document')
    const query = host.log.find(e => e.method === 'DOM.querySelector')
    assert.equal(query.params.selector, 'input[type="file"]')
    const set = host.log.find(e => e.method === 'DOM.setFileInputFiles')
    assert.deepEqual(set.params.files, [upload.file])
    assert.equal(set.params.nodeId, 42)
    // Command order must be getDocument -> querySelector -> setFileInputFiles.
    const order = ['DOM.getDocument', 'DOM.querySelector', 'DOM.setFileInputFiles']
      .map(m => host.log.findIndex(e => e.method === m))
    assert.ok(order.every(i => i >= 0) && order.every((i, n) => n === 0 || i > order[n - 1]), 'CDP sequence ordered')
  } finally {
    upload.cleanup()
  }
})

test('uploadFile reports a missing file input', async () => {
  const upload = tempUpload()
  try {
    const host = new FakeHost()
    const provider = new ElectronBrowserProvider(host, { readRoots: [upload.dir] })
    const session = await provider.open()
    // Missing-input scenario: document resolves, DOM.querySelector answers nodeId 0.
    host.views[0].sendCommand = domStub(host, 0)
    await assert.rejects(() => provider.uploadFile(session, { filePath: upload.file }), /no file input/)
  } finally {
    upload.cleanup()
  }
})

test('waitForElement polls until the element appears', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  // 前两次 evaluate 返回 null,第三次返回 found
  host.evalReplies.push(
    { result: { value: null } },
    { result: { value: null } },
    { result: { value: { found: true, selector: '#go', tag: 'button', text: 'Go' } } },
  )
  const result = await provider.waitForElement(session, { selector: '#go', timeoutMs: 3000 })
  assert.equal(result.found, true)
  assert.equal(result.tag, 'button')
  assert.equal(host.log.filter(e => e.method === 'Runtime.evaluate').length, 3)
  const history = await provider.history(session)
  assert.equal(history[0].action, 'waitForElement')
})

test('open forwards a window key and label to the host', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  await provider.open({ key: 'task-1', label: 'rewards' })
  assert.deepEqual(host.createViewArgs[0], { key: 'task-1', label: 'rewards' })
  await provider.open()
  assert.deepEqual(host.createViewArgs[1], { key: 'default', label: undefined })
})

test('new tabs retain their session task key and label', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open({ key: 'task-alpha', label: '采购审批' })
  await provider.openUrl(session, { url: 'https://www.iana.org/', newTab: true })
  assert.deepEqual(host.createViewArgs, [
    { key: 'task-alpha', label: '采购审批' },
    { key: 'task-alpha', label: '采购审批' },
  ])
})

test('keyed open recovers the existing session and its tabs', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open({ key: 'task-recover', label: 'Recover' })
  await provider.openUrl(session, { url: 'https://example.com/', newTab: true })
  const before = await provider.listTabs(session)
  assert.equal(before.length, 2)

  const recovered = await provider.open({ key: 'task-recover' })
  assert.equal(recovered, session)
  assert.deepEqual((await provider.listTabs(recovered)).map(tab => tab.id), before.map(tab => tab.id))

  await provider.switchTab(recovered, before[0].id)
  await provider.closeTab(recovered, before[1].id)
  assert.equal((await provider.listTabs(recovered)).length, 1)
  assert.equal(host.createViewArgs.length, 2, 'recovery must not create a second task session')
})

test('waitForElement times out with BROWSER_WAIT_TIMEOUT', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  host.evalReplies.push({ result: { value: null } })
  await assert.rejects(
    () => provider.waitForElement(session, { selector: '#never', timeoutMs: 600 }),
    (error) => error.code === 'BROWSER_WAIT_TIMEOUT',
  )
})

test('setSpace labels the window and records it', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  const handle = host.views[0]
  let labeled = null
  handle.label = async (label) => { labeled = label }
  await provider.setSpace(session, 'rewards')
  assert.equal(labeled, 'rewards')
  const history = await provider.history(session)
  assert.equal(history[0].action, 'setSpace')
})

test('listSpaces forwards to the host', async () => {
  const host = new FakeHost()
  host.listWindows = async () => [{ key: 'task-1', label: 'rewards' }]
  const provider = new ElectronBrowserProvider(host)
  const spaces = await provider.listSpaces()
  assert.deepEqual(spaces, [{ key: 'task-1', label: 'rewards' }])
})

/** DOM-stub for uploadFile tests: document resolves, querySelector answers queryNodeId. */
function domStub (host, queryNodeId) {
  return async (method, params) => {
    host.log.push({ method, params })
    return method === 'DOM.getDocument' ? { root: { nodeId: 1 } }
      : method === 'DOM.querySelector' ? { nodeId: queryNodeId }
        : {}
  }
}

test('pressKey types punctuation, including inside modifier combos', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  await provider.pressKey(session, { key: '-', modifiers: ['ctrl'] })
  let keys = host.log.filter(entry => entry.method === 'Input.dispatchKeyEvent')
  assert.equal(keys[0].params.key, '-')
  assert.equal(keys[0].params.code, 'Minus')
  assert.equal(keys[0].params.windowsVirtualKeyCode, 189)
  assert.equal(keys[0].params.text, '-')
  assert.equal(keys[0].params.modifiers, 2, 'ctrl is still held')
  await provider.pressKey(session, { key: '/' })
  keys = host.log.filter(entry => entry.method === 'Input.dispatchKeyEvent')
  assert.equal(keys[2].params.code, 'Slash')
  assert.equal(keys[2].params.text, '/')
})

test('chrome is re-installed through the host when it offers to', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  let reinstalled = 0
  host.views[0].reinstallChrome = async () => { reinstalled += 1 }
  host.evalReplies.push({ result: { value: 'complete' } })
  await provider.navigate(session, { url: 'https://example.com/' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reinstalled, 1, 'only the host holds the per-view binding token')
  const tokenless = host.log.filter(entry => entry.method === 'Runtime.evaluate'
    && String(entry.params.expression).includes('__dsh_browser_chrome_host__'))
  assert.equal(tokenless.length, 0, 'the tokenless copy was not injected')
})

test('chrome falls back to the provider copy when the host owns none', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  host.evalReplies.push({ result: { value: 'complete' } })
  await provider.navigate(session, { url: 'https://example.com/' })
  await new Promise(resolve => setImmediate(resolve))
  const injected = host.log.filter(entry => entry.method === 'Runtime.evaluate'
    && String(entry.params.expression).includes('__dsh_browser_chrome_host__'))
  assert.ok(injected.length >= 1, 'shell hosts still get chrome')
})

test('an over-long script is clipped in history and cannot be replayed', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  const long = 'x'.repeat(40_000)
  host.evalReplies.push({ result: { value: 1 } })
  await provider.execute(session, { script: `return 1 // ${long}` })
  const entry = (await provider.history(session)).find(candidate => candidate.action === 'execute')
  assert.equal(entry.params.scriptTruncated, true, 'marks the clip so replay can refuse')
  assert.equal(String(entry.params.script).length, 32_768, 'stores a bounded script')
  await assert.rejects(
    () => provider.replay(session, entry.seq),
    error => {
      assert.equal(error.code, 'BROWSER_HISTORY_TRUNCATED')
      return true
    },
  )
})

test('a timed-out operation carries a stable code', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  // A renderer that never answers: the evaluation must surface as a timeout.
  host.views[0].sendCommand = () => new Promise(() => {})
  await assert.rejects(
    () => provider.content(session, { format: 'txt', timeoutMs: 30 }),
    error => {
      assert.equal(error.code, 'BROWSER_OPERATION_TIMEOUT')
      assert.match(error.message, /timed out/)
      return true
    },
  )
})

test('waitForElement fails fast on an invalid selector instead of burning the budget', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  host.evalReplies.push({ result: { value: { error: 'SyntaxError: not a valid selector' } } })
  const started = Date.now()
  await assert.rejects(
    () => provider.waitForElement(session, { selector: 'div:has-text("x")', timeoutMs: 5_000 }),
    error => {
      assert.equal(error.code, 'BROWSER_SELECTOR_INVALID')
      return true
    },
  )
  assert.ok(Date.now() - started < 2_000, 'does not poll until the deadline')
})

test('importAuth restores every usable entry of a guarded cookie file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-import-'))
  try {
    const file = join(dir, 'cookies.json')
    writeFileSync(file, JSON.stringify({ cookies: [
      { url: 'https://example.com/', name: 'a', value: '1' },
      { url: 'https://example.com/', name: 'b', value: '2' },
      { name: 'no-url', value: '3' },              // unusable: no url
      { url: 'https://example.com/', name: 'c' },  // unusable: no value
    ] }))
    const host = new FakeHost()
    const provider = new ElectronBrowserProvider(host, { readRoots: [dir] })
    const session = await provider.open()
    let handed = []
    host.views[0].restoreAuth = async cookies => { handed = cookies; return cookies.length }

    const result = await provider.importAuth(session, file)
    assert.deepEqual(result, { restored: 2, failed: 2 })
    assert.deepEqual(handed.map(cookie => cookie.name), ['a', 'b'], 'only usable entries reach the session')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('importAuth accepts a bare array as well as the {cookies} shape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-import-array-'))
  try {
    const file = join(dir, 'cookies.json')
    writeFileSync(file, JSON.stringify([{ url: 'https://example.com/', name: 'a', value: '1' }]))
    const host = new FakeHost()
    const provider = new ElectronBrowserProvider(host, { readRoots: [dir] })
    const session = await provider.open()
    host.views[0].restoreAuth = async cookies => cookies.length
    assert.deepEqual(await provider.importAuth(session, file), { restored: 1, failed: 0 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('importAuth refuses a file outside the read roots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-import-outside-'))
  try {
    const file = join(dir, 'cookies.json')
    writeFileSync(file, JSON.stringify([{ url: 'https://example.com/', name: 'a', value: '1' }]))
    const host = new FakeHost()
    // The file exists; it is simply not under an allowed root.
    const provider = new ElectronBrowserProvider(host, { readRoots: [join(dir, 'elsewhere')] })
    const session = await provider.open()
    await assert.rejects(
      () => provider.importAuth(session, file),
      error => { assert.equal(error.code, 'BROWSER_READ_PATH_DENIED'); return true },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('importAuth rejects a file that is not a cookie export', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-import-bad-'))
  try {
    const file = join(dir, 'not-cookies.json')
    writeFileSync(file, JSON.stringify({ hello: 'world' }))
    const host = new FakeHost()
    const provider = new ElectronBrowserProvider(host, { readRoots: [dir] })
    const session = await provider.open()
    await assert.rejects(
      () => provider.importAuth(session, file),
      error => { assert.equal(error.code, 'BROWSER_AUTH_FILE_INVALID'); return true },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
/**
 * Make every view the host creates answer evaluations by expression, so a test
 * never has to count replies. It patches createView rather than views[0]: a
 * scrape batch creates a tab (and therefore a view) of its own.
 */
function scrapeViews(host, extract, delayMs = 0) {
  const create = host.createView.bind(host)
  host.createView = (key, label) => {
    const view = create(key, label)
    view.sendCommand = async (method, params) => {
      if (method !== 'Runtime.evaluate') return {}
      const expression = String(params?.expression ?? '')
      if (expression === 'document.readyState') return { result: { value: 'complete' } }
      if (expression.includes('__dsh_browser_chrome_host__')) return { result: { value: null } }
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
      return { result: { value: extract(expression) } }
    }
    // Without this, navigate also fires the provider's tokenless chrome copy.
    view.reinstallChrome = async () => {}
    return view
  }
}

/** Wait for a detached batch to leave the running state. */
async function settle(provider, id) {
  for (let i = 0; i < 500; i += 1) {
    const status = await provider.scrapeStatus(id)
    if (status.state !== 'running') return status
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('scrape did not settle')
}

const rowsOf = path => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

test('a scrape batch writes one JSONL row per URL and never returns the data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-scrape-'))
  try {
    const host = new FakeHost()
    const provider = new ElectronBrowserProvider(host, { writeRoots: [dir] })
    const session = await provider.open()
    scrapeViews(host, () => ({ title: 'extracted' }))
    const out = join(dir, 'rows.jsonl')

    const started = await provider.startScrape(session, {
      urls: ['https://a.example/', 'https://b.example/'],
      script: 'document.title',
      outPath: out,
    })
    assert.equal(started.total, 2)
    assert.equal(started.state, 'running', 'start returns before the batch finishes')
    assert.equal(started.path, out)

    const final = await settle(provider, started.id)
    assert.equal(final.state, 'done')
    assert.equal(final.done, 2)
    assert.equal(final.failed, 0)
    assert.deepEqual(rowsOf(out), [
      { seq: 0, url: 'https://a.example/', ok: true, data: { title: 'extracted' } },
      { seq: 1, url: 'https://b.example/', ok: true, data: { title: 'extracted' } },
    ], 'concurrency 1 keeps rows in URL order')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one bad page does not end the batch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-scrape-bad-'))
  try {
    const host = new FakeHost()
    const provider = new ElectronBrowserProvider(host, { writeRoots: [dir] })
    const session = await provider.open()
    scrapeViews(host, () => 'ok')
    const out = join(dir, 'rows.jsonl')

    // file:// is refused by URL admission before any navigation happens.
    const started = await provider.startScrape(session, {
      urls: ['file:///etc/passwd', 'https://good.example/'],
      script: '1',
      outPath: out,
    })
    const final = await settle(provider, started.id)
    assert.equal(final.done, 2, 'the batch continued past the failure')
    assert.equal(final.failed, 1)
    const rows = rowsOf(out)
    assert.equal(rows[0].ok, false)
    assert.match(rows[0].error, /non-HTTP\(S\)/)
    assert.deepEqual(rows[1], { seq: 1, url: 'https://good.example/', ok: true, data: 'ok' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stopped batch keeps the rows it already wrote', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-scrape-stop-'))
  try {
    const host = new FakeHost()
    const provider = new ElectronBrowserProvider(host, { writeRoots: [dir] })
    const session = await provider.open()
    scrapeViews(host, () => 'ok', 2)
    const out = join(dir, 'rows.jsonl')
    const urls = Array.from({ length: 60 }, (_, i) => `https://s${String(i)}.example/`)

    const started = await provider.startScrape(session, { urls, script: '1', outPath: out })
    // Let a few rows land, then stop mid-batch.
    for (let i = 0; i < 200 && rowsOf(out).length < 3; i += 1) await new Promise(resolve => setTimeout(resolve, 5))
    const stopped = await provider.stopScrape(started.id)
    assert.equal(stopped.state, 'stopped')
    const final = await settle(provider, started.id)
    assert.equal(final.state, 'stopped')
    assert.ok(final.done < urls.length, 'the batch did not run to the end')
    assert.equal(rowsOf(out).length, final.done, 'the file holds exactly the rows it managed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scrape rejects an empty batch, an unknown id, and a path outside the write roots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-scrape-guard-'))
  try {
    const host = new FakeHost()
    const provider = new ElectronBrowserProvider(host, { writeRoots: [join(dir, 'allowed')] })
    const session = await provider.open()
    await assert.rejects(
      () => provider.startScrape(session, { urls: [], script: '1', outPath: join(dir, 'x.jsonl') }),
      error => { assert.equal(error.code, 'BROWSER_SCRAPE_EMPTY'); return true },
    )
    await assert.rejects(
      () => provider.startScrape(session, { urls: ['https://a.example/'], script: '1', outPath: join(dir, 'x.jsonl') }),
      error => { assert.equal(error.code, 'BROWSER_WRITE_PATH_DENIED'); return true },
    )
    await assert.rejects(
      () => provider.scrapeStatus('scrape:nope'),
      error => { assert.equal(error.code, 'BROWSER_SCRAPE_UNKNOWN'); return true },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('a scrape batch works in its own tab and leaves the active one alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-scrape-tab-'))
  try {
    const host = new FakeHost()
    const provider = new ElectronBrowserProvider(host, { writeRoots: [dir] })
    // A per-page delay keeps the batch observably running while the test looks.
    scrapeViews(host, () => 'ok', 20)
    const session = await provider.open()
    const before = await provider.listTabs(session)
    assert.equal(before.length, 1)
    const out = join(dir, 'rows.jsonl')
    const urls = Array.from({ length: 40 }, (_, i) => `https://t${String(i)}.example/`)

    const started = await provider.startScrape(session, { urls, script: '1', outPath: out })
    const during = await provider.listTabs(session)
    assert.equal(during.length, 2, 'the batch added a tab of its own')
    assert.equal(during.find(tab => tab.active)?.id, before[0].id, 'and did not steal the active tab')

    const final = await settle(provider, started.id)
    assert.equal(final.state, 'done')
    const after = await provider.listTabs(session)
    assert.equal(after.length, 1, 'the batch tab is cleaned up')
    assert.equal(after[0].id, before[0].id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('concurrency loads several pages at once and every row carries its index', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-scrape-par-'))
  try {
    const host = new FakeHost()
    const provider = new ElectronBrowserProvider(host, { writeRoots: [dir] })
    // A per-page delay keeps all three workers busy at the same time.
    scrapeViews(host, () => 'ok', 20)
    const session = await provider.open()
    const out = join(dir, 'rows.jsonl')
    const urls = Array.from({ length: 6 }, (_, i) => `https://p${String(i)}.example/`)

    const started = await provider.startScrape(session, { urls, script: '1', outPath: out, concurrency: 3 })
    // Counted from the host rather than listTabs: listTabs awaits a URL per tab
    // and the batch can finish (and drop its tabs) while it is iterating.
    assert.equal(host.createViewArgs.length, 4, 'three workers plus the tab the session already had')
    assert.equal((await provider.listTabs(session)).filter(tab => tab.active).length, 1, 'exactly one tab stays active')

    const final = await settle(provider, started.id)
    assert.equal(final.state, 'done')
    assert.equal(final.done, 6)
    assert.equal(final.failed, 0)
    const rows = rowsOf(out)
    assert.equal(rows.length, 6)
    assert.deepEqual(rows.map(row => row.seq).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5], 'every URL was visited exactly once')
    assert.equal(new Set(rows.map(row => row.url)).size, 6)
    assert.equal((await provider.listTabs(session)).length, 1, 'all worker tabs are cleaned up')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrency is clamped to a sane worker count', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-scrape-cap-'))
  try {
    const host = new FakeHost()
    const provider = new ElectronBrowserProvider(host, { writeRoots: [dir] })
    scrapeViews(host, () => 'ok', 20)
    const session = await provider.open()
    const out = join(dir, 'rows.jsonl')
    const urls = Array.from({ length: 4 }, (_, i) => `https://c${String(i)}.example/`)
    const started = await provider.startScrape(session, { urls, script: '1', outPath: out, concurrency: 999 })
    // 8 workers is the cap, so 4 urls never need more than 4 tabs plus the original.
    assert.ok((await provider.listTabs(session)).length <= 9)
    await settle(provider, started.id)
    assert.equal(rowsOf(out).length, 4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('a pointer target resolves a selector in the page and reports what it hit', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  const asked = []
  host.views[0].sendCommand = async (method, params) => {
    if (method !== 'Runtime.evaluate') return {}
    const expression = String(params?.expression ?? '')
    asked.push(expression)
    // Only the resolver asks for a point; other evaluations get a harmless reply.
    if (expression.includes('querySelectorAll')) return { result: { value: { x: 120, y: 40, target: 'Sign in' } } }
    return { result: { value: null } }
  }
  const point = await provider.click(session, { selector: '#signin' })
  assert.deepEqual(point, { x: 120, y: 40, target: 'Sign in' })
  const resolver = asked.find(expression => expression.includes('querySelectorAll'))
  assert.ok(resolver !== undefined, 'the selector is resolved in the page, not by the caller')
  assert.match(resolver, /scrollIntoView/, 'and the element is brought into view before the click')
})

test('a pointer target needs coordinates, a selector, or text', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  await assert.rejects(
    () => provider.click(session, {}),
    error => { assert.equal(error.code, 'BROWSER_TARGET_MISSING'); return true },
  )
  await assert.rejects(
    () => provider.hover(session, { x: 10 }),
    error => { assert.equal(error.code, 'BROWSER_TARGET_MISSING'); return true },
  )
})

test('coordinates pass through untouched, with no page round-trip', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  host.views[0].sendCommand = async (method, params) => {
    host.log.push({ method, params })
    return {}
  }
  assert.deepEqual(await provider.click(session, { x: 5, y: 6 }), { x: 5, y: 6 })
  const resolved = host.log.some(entry => entry.method === 'Runtime.evaluate'
    && String(entry.params?.expression ?? '').includes('querySelectorAll'))
  assert.equal(resolved, false, 'a coordinate target needs no page round-trip')
})

test('a target that matches nothing is reported as such', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  host.views[0].sendCommand = async (method, params) => {
    if (method !== 'Runtime.evaluate') return {}
    const expression = String(params?.expression ?? '')
    if (expression.includes('invalid selector')) return { result: { value: { missing: true } } }
    return { result: { value: { missing: true } } }
  }
  await assert.rejects(
    () => provider.click(session, { text: 'nothing here' }),
    error => {
      assert.equal(error.code, 'BROWSER_TARGET_NOT_FOUND')
      assert.match(error.message, /text "nothing here"/)
      return true
    },
  )
})
test('the in-page resolver script is valid JavaScript and cannot be broken out of', async () => {
  // The script is built as text and only ever parsed inside a page, so a typo
  // would not surface until runtime, on a real site, far from here. Compiling
  // it catches that at build time.
  const { pointerTargetScript } = await import('../lib/browser-electron/provider.js')
  for (const [selector, text] of [['#a', undefined], [undefined, '登录'], [undefined, undefined]]) {
    const script = pointerTargetScript(selector, text)
    assert.doesNotThrow(() => new Function(`return ${script}`), 'the script compiles')
    assert.match(script, /querySelectorAll/)
  }
  // Selector and text are interpolated as JSON literals, so a quote in either
  // cannot terminate the string and inject code into the page.
  const hostile = pointerTargetScript('\"; globalThis.__pwned = 1; //', undefined)
  assert.doesNotThrow(() => new Function(`return ${hostile}`))
  assert.doesNotMatch(hostile, /__pwned = 1; \/\/$/)
})
test('a click can use another mouse button or hold modifiers', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  const sent = []
  host.views[0].sendCommand = async (method, params) => {
    if (method !== 'Runtime.evaluate') sent.push({ method, params })
    return { result: { value: null } }
  }
  await provider.click(session, { x: 10, y: 20, button: 'right' })
  await provider.click(session, { x: 10, y: 20, modifiers: ['ctrl', 'shift'] })
  await provider.click(session, { x: 10, y: 20, modifiers: ['alt', 'ctrl', 'meta', 'shift'] })
  const presses = sent.filter(entry => entry.method === 'Input.dispatchMouseEvent' && entry.params?.type === 'mousePressed')
  assert.equal(presses.length, 3)
  assert.equal(presses[0].params.button, 'right')
  assert.equal(presses[0].params.modifiers, 0, 'no modifiers is the zero mask')
  assert.equal(presses[1].params.button, 'left', 'the default button stays left')
  assert.equal(presses[1].params.modifiers, 2 | 8, 'ctrl is 2 and shift is 8')
  assert.equal(presses[2].params.modifiers, 1 | 2 | 4 | 8)
  // The release must carry the same button, or the page sees a stuck press.
  const releases = sent.filter(entry => entry.method === 'Input.dispatchMouseEvent' && entry.params?.type === 'mouseReleased')
  assert.deepEqual(releases.map(entry => entry.params.button), ['right', 'left', 'left'])
})
