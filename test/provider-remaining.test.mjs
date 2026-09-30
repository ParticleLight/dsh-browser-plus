import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ElectronBrowserProvider, renderMarkdown } from '../lib/browser-electron/provider.js'

/**
 * Tests for the provider's remaining review items: a real (host-probed)
 * available(), a recursive markdown renderer, and uploadFile's input guards.
 *
 * The markdown tests drive the *page script* the provider builds, evaluated in
 * a vm with a minimal DOM shim, so they cover the code that actually runs in
 * the renderer rather than a re-implementation of it.
 */

const ELEMENT_NODE = 1
const TEXT_NODE = 3

/** Minimal element node: what the renderer reads off a real DOM element. */
function el (tag, children = [], props = {}) {
  return { nodeType: ELEMENT_NODE, tagName: tag.toUpperCase(), childNodes: children, ...props }
}

/** Minimal text node. */
function text (value) {
  return { nodeType: TEXT_NODE, textContent: value, childNodes: [] }
}

/** Host that answers Runtime.evaluate by really running the provider's script. */
class DomView {
  constructor (host, document) {
    this.id = `view:${String(host.views.length + 1)}`
    this.host = host
    this.document = document
  }

  async sendCommand (method, params) {
    this.host.log.push({ method, params })
    if (method !== 'Runtime.evaluate') return {}
    const value = vm.runInNewContext(params.expression, { document: this.document })
    return { result: { value } }
  }
}

class DomHost {
  constructor (document) {
    this.document = document
    this.views = []
    this.log = []
    this.createViewArgs = []
  }

  createView (key, label) {
    this.createViewArgs.push({ key, label })
    const view = new DomView(this, this.document)
    this.views.push(view)
    return view
  }

  destroyView () {}
  showView () {}
  trace () {}
}

/** Host without an availability probe: the conservative default applies. */
function probeHost (isAvailable) {
  const host = new DomHost({ body: el('div', []) })
  if (isAvailable !== undefined) host.isAvailable = isAvailable
  return host
}

test('available() assumes usable when the host exposes no probe', () => {
  const provider = new ElectronBrowserProvider(probeHost())
  assert.equal(provider.available(), true)
})

test('available() follows a host probe that reports the backend missing', () => {
  const provider = new ElectronBrowserProvider(probeHost(() => false))
  assert.equal(provider.available(), false)
})

test('available() reports present when the host probe does', () => {
  const provider = new ElectronBrowserProvider(probeHost(() => true))
  assert.equal(provider.available(), true)
})

test('available() treats a throwing host probe as unavailable', () => {
  const provider = new ElectronBrowserProvider(probeHost(() => { throw new Error('electron 42.9.3 not found') }))
  assert.equal(provider.available(), false)
})

test('content markdown recurses into containers and keeps headings/links/lists', async () => {
  const document = {
    body: el('div', [
      el('h2', [text('标题')]),
      el('a', [text('链接')], { href: 'https://x' }),
      el('ul', [el('li', [text('项')])]),
    ]),
  }
  const provider = new ElectronBrowserProvider(new DomHost(document))
  const session = await provider.open()
  const result = await provider.content(session, { format: 'markdown' })
  assert.equal(result.content, '## 标题\n[链接](https://x)\n- 项')
  // The container must not also emit its own textContent: each run of text
  // appears exactly once.
  assert.equal(result.content.split('标题').length - 1, 1)
  assert.equal(result.content.split('链接').length - 1, 1)
})

test('content markdown keeps an inline run inside one paragraph', async () => {
  const document = { body: el('div', [text('Hello '), el('b', [text('world')]), text('!')]) }
  const provider = new ElectronBrowserProvider(new DomHost(document))
  const session = await provider.open()
  const result = await provider.content(session, { format: 'markdown' })
  assert.equal(result.content, 'Hello world!')
})

test('content markdown honors a selector and separates sibling blocks', async () => {
  const document = {
    body: el('div', []),
    querySelector: () => el('section', [el('p', [text('one')]), el('p', [text('two')])]),
  }
  const provider = new ElectronBrowserProvider(new DomHost(document))
  const session = await provider.open()
  const result = await provider.content(session, { format: 'markdown', selector: '#main' })
  assert.equal(result.content, 'one\ntwo')
})

test('renderMarkdown is usable directly and drops script/style text', () => {
  const tree = el('article', [
    el('h1', [text('Title')]),
    el('script', [text('doNotRender()')]),
    el('div', [text('Body '), el('a', [text('link')], { href: 'https://example.com/a' })]),
    el('ol', [el('li', [text('first')]), el('li', [text('second')])]),
  ])
  assert.equal(
    renderMarkdown(tree),
    '# Title\nBody [link](https://example.com/a)\n- first\n- second',
  )
})

/** A real file inside its own root, so the read guard admits the upload. */
function tempUpload() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-upload-'))
  const file = join(dir, 'a.txt')
  writeFileSync(file, 'payload')
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('uploadFile suppresses auto user control before touching the DOM domain', async () => {
  const upload = tempUpload()
  try {
  const host = new DomHost({ body: el('div', []) })
  const provider = new ElectronBrowserProvider(host, { readRoots: [upload.dir] })
  const session = await provider.open()
  host.views[0].sendCommand = async (method, params) => {
    host.log.push({ method, params })
    return method === 'DOM.getDocument' ? { root: { nodeId: 1 } }
      : method === 'DOM.querySelector' ? { nodeId: 7 }
        : {}
  }
  const result = await provider.uploadFile(session, { filePath: upload.file })
  assert.equal(result.path, upload.file)
  assert.equal(host.log[0].method, 'Runtime.evaluate')
  assert.match(host.log[0].params.expression, /data-dsh-agent-input-until/)
  const order = ['Runtime.evaluate', 'DOM.getDocument', 'DOM.querySelector', 'DOM.setFileInputFiles']
    .map(method => host.log.findIndex(entry => entry.method === method))
  assert.ok(order.every(index => index >= 0), 'every step ran')
  assert.ok(order.every((index, position) => position === 0 || index > order[position - 1]), 'suppression precedes the DOM sequence')
  } finally {
    upload.cleanup()
  }
})

test('uploadFile is bounded by its own timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const upload = tempUpload()
  try {
    const host = new DomHost({ body: el('div', []) })
    const provider = new ElectronBrowserProvider(host, { readRoots: [upload.dir] })
    const session = await provider.open()
    host.views[0].sendCommand = async (method) => {
      if (method === 'Runtime.evaluate') return {}
      return new Promise(() => {}) // DOM.getDocument never settles
    }
    const pending = provider.uploadFile(session, { filePath: upload.file })
    const rejected = assert.rejects(pending, /upload timed out after 30000ms/)
    await new Promise(resolve => setImmediate(resolve))
    t.mock.timers.tick(30_000)
    await rejected
  } finally {
    upload.cleanup()
  }
})
