import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'
import { defaultWriteRoots, isWithinRoots, resolveReadPath, resolveWritePath } from '../lib/browser-electron/write-guard.js'

/**
 * Minimal host seam whose handle exposes exactly the two write-producing
 * paths: a native capture (screenshot) and a download. Everything else the
 * provider might call is optional on the handle and simply absent here.
 */
class FakeView {
  constructor(id, host) {
    this.id = id
    this.host = host
  }

  async sendCommand(method, params) {
    this.host.log.push({ method, params })
    if (method === 'Runtime.evaluate') return this.host.evalReplies.shift() ?? {}
    // Minimal DOM domain answers so an admitted upload can run to completion.
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
    if (method === 'DOM.querySelector') return { nodeId: 2 }
    return {}
  }

  async capture() {
    return { base64: Buffer.from('fake-png-bytes').toString('base64'), width: 8, height: 8 }
  }

  async download(url, savePath) {
    this.host.downloads.push({ url, savePath })
  }
}

class FakeHost {
  constructor() {
    this.views = []
    this.evalReplies = []
    this.log = []
    this.downloads = []
    this.nextId = 1
  }

  createView() {
    const view = new FakeView(`view:${String(this.nextId++)}`, this)
    this.views.push(view)
    return view
  }

  destroyView() {
    // no-op: views are cheap in-memory
  }
}

/** A throwaway tree with one allowed root, so each test owns its own boundary. */
function makeSandbox() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-write-guard-'))
  const root = join(base, 'root')
  mkdirSync(root, { recursive: true })
  return { base, root, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

/** Assert a rejection carries the stable BrowserError code. */
async function rejectsWithCode(run, code) {
  await assert.rejects(run, error => {
    assert.equal(error.code, code)
    return true
  })
}

test('defaultWriteRoots covers the workspace and the OS temp directory', () => {
  const roots = defaultWriteRoots()
  assert.ok(roots.includes(process.cwd()))
  assert.ok(roots.includes(tmpdir()))
})

test('resolveWritePath admits a path inside a root and returns it absolute', () => {
  const sandbox = makeSandbox()
  try {
    const target = resolveWritePath(join(sandbox.root, 'shot.png'), [sandbox.root])
    assert.equal(target, resolve(sandbox.root, 'shot.png'))
  } finally {
    sandbox.cleanup()
  }
})

test('resolveWritePath refuses traversal that escapes the root', () => {
  const sandbox = makeSandbox()
  try {
    const escaping = join(sandbox.root, '..', 'escape.png')
    assert.equal(isWithinRoots(escaping, [sandbox.root]), false)
    assert.throws(() => resolveWritePath(escaping, [sandbox.root]), /outside the allowed roots/)
  } finally {
    sandbox.cleanup()
  }
})

test('resolveWritePath refuses a sibling that merely shares the root prefix', () => {
  const sandbox = makeSandbox()
  try {
    const sibling = `${sandbox.root}-evil`
    assert.throws(() => resolveWritePath(join(sibling, 'shot.png'), [sandbox.root]), /outside the allowed roots/)
  } finally {
    sandbox.cleanup()
  }
})

test('resolveWritePath denies every path when no root is configured', () => {
  assert.throws(() => resolveWritePath(join(tmpdir(), 'shot.png'), []), /none configured/)
})

test('screenshot refuses a savePath outside the allowed roots and writes nothing', async () => {
  const sandbox = makeSandbox()
  try {
    const host = new FakeHost()
    const provider = new ElectronBrowserProvider(host, { writeRoots: [sandbox.root] })
    const session = await provider.open()
    const outside = join(sandbox.base, 'outside.png')
    await rejectsWithCode(() => provider.screenshot(session, { savePath: outside }), 'BROWSER_WRITE_PATH_DENIED')
    assert.equal(existsSync(outside), false)
  } finally {
    sandbox.cleanup()
  }
})

test('screenshot writes a capture inside an allowed root', async () => {
  const sandbox = makeSandbox()
  try {
    const host = new FakeHost()
    const provider = new ElectronBrowserProvider(host, { writeRoots: [sandbox.root] })
    const session = await provider.open()
    const target = join(sandbox.root, 'shot.png')
    const shot = await provider.screenshot(session, { savePath: target })
    assert.equal(shot.path, target)
    assert.equal(readFileSync(target, 'utf8'), 'fake-png-bytes')
  } finally {
    sandbox.cleanup()
  }
})

test('download refuses a savePath outside the allowed roots before reaching the host', async () => {
  const sandbox = makeSandbox()
  try {
    const host = new FakeHost()
    const provider = new ElectronBrowserProvider(host, { writeRoots: [sandbox.root] })
    const session = await provider.open()
    await rejectsWithCode(
      () => provider.download(session, { url: 'https://example.com/a.bin', savePath: join(sandbox.base, 'a.bin') }),
      'BROWSER_WRITE_PATH_DENIED',
    )
    assert.deepEqual(host.downloads, [])
  } finally {
    sandbox.cleanup()
  }
})

test('download applies the same URL admission as navigation', async () => {
  const sandbox = makeSandbox()
  try {
    const host = new FakeHost()
    const provider = new ElectronBrowserProvider(host, { writeRoots: [sandbox.root] })
    const session = await provider.open()
    const savePath = join(sandbox.root, 'a.bin')
    await rejectsWithCode(() => provider.download(session, { url: 'file:///etc/passwd', savePath }), 'BROWSER_NAVIGATION_BLOCKED')
    await rejectsWithCode(() => provider.download(session, { url: 'https://u:p@example.com/a.bin', savePath }), 'BROWSER_NAVIGATION_BLOCKED')
    assert.deepEqual(host.downloads, [])
  } finally {
    sandbox.cleanup()
  }
})

test('download passes an admitted URL and an absolute path to the host', async () => {
  const sandbox = makeSandbox()
  try {
    const host = new FakeHost()
    const provider = new ElectronBrowserProvider(host, { writeRoots: [sandbox.root] })
    const session = await provider.open()
    const savePath = join(sandbox.root, 'a.bin')
    const result = await provider.download(session, { url: 'https://example.com/a.bin', savePath })
    assert.equal(result.path, savePath)
    assert.deepEqual(host.downloads, [{ url: 'https://example.com/a.bin', savePath: resolve(savePath) }])
  } finally {
    sandbox.cleanup()
  }
})

test('navigate keeps its existing HTTP(S) admission', async () => {
  const host = new FakeHost()
  const provider = new ElectronBrowserProvider(host)
  const session = await provider.open()
  await rejectsWithCode(() => provider.navigate(session, { url: 'file:///etc/passwd' }), 'BROWSER_NAVIGATION_BLOCKED')
  // waitForDocumentReady polls document.readyState; answer once so navigate
  // settles without consuming its full 12s readiness budget.
  host.evalReplies.push({ result: { value: 'complete' } })
  await provider.navigate(session, { url: 'https://example.com/' })
  assert.ok(host.log.some(entry => entry.method === 'Page.navigate'))
})

test('resolveWritePath refuses a symlink that escapes an allowed root', t => {
  const sandbox = makeSandbox()
  try {
    const link = join(sandbox.root, 'link')
    try {
      // A Windows junction needs no elevation, unlike a real symlink.
      symlinkSync(sandbox.base, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      t.skip('link creation is not permitted on this platform')
      return
    }
    assert.throws(() => resolveWritePath(join(link, 'escape.png'), [sandbox.root]), /outside the allowed roots/)
  } finally {
    sandbox.cleanup()
  }
})
test('resolveReadPath admits an existing file inside a root', () => {
  const sandbox = makeSandbox()
  try {
    const file = join(sandbox.root, 'notes.txt')
    writeFileSync(file, 'hi')
    assert.equal(resolveReadPath(file, [sandbox.root]), resolve(file))
  } finally {
    sandbox.cleanup()
  }
})

test('resolveReadPath refuses a file that does not exist', () => {
  const sandbox = makeSandbox()
  try {
    assert.throws(() => resolveReadPath(join(sandbox.root, 'nope.txt'), [sandbox.root]), /does not exist/)
  } finally {
    sandbox.cleanup()
  }
})

test('resolveReadPath refuses a file outside the roots', () => {
  const sandbox = makeSandbox()
  try {
    const outside = join(sandbox.base, 'secret.txt')
    writeFileSync(outside, 'x')
    assert.throws(() => resolveReadPath(outside, [sandbox.root]), /outside the allowed roots/)
  } finally {
    sandbox.cleanup()
  }
})

test('resolveReadPath refuses a link that escapes a root', t => {
  const sandbox = makeSandbox()
  try {
    const outside = join(sandbox.base, 'secret.txt')
    writeFileSync(outside, 'x')
    const link = join(sandbox.root, 'link.txt')
    try {
      symlinkSync(outside, link, 'file')
    } catch {
      t.skip('file links are not permitted on this platform')
      return
    }
    assert.throws(() => resolveReadPath(link, [sandbox.root]), /outside the allowed roots/)
  } finally {
    sandbox.cleanup()
  }
})

test('uploadFile refuses a file outside readRoots before any DOM work', async () => {
  const sandbox = makeSandbox()
  try {
    const host = new FakeHost()
    const provider = new ElectronBrowserProvider(host, { readRoots: [sandbox.root] })
    const session = await provider.open()
    const outside = join(sandbox.base, 'secret.txt')
    writeFileSync(outside, 'x')
    await rejectsWithCode(() => provider.uploadFile(session, { filePath: outside }), 'BROWSER_READ_PATH_DENIED')
    assert.deepEqual(host.log.filter(entry => entry.method.startsWith('DOM.')), [], 'admission precedes DOM work')
  } finally {
    sandbox.cleanup()
  }
})

test('uploadFile admits a file inside readRoots and sends the resolved path', async () => {
  const sandbox = makeSandbox()
  try {
    const host = new FakeHost()
    const provider = new ElectronBrowserProvider(host, { readRoots: [sandbox.root] })
    const session = await provider.open()
    const file = join(sandbox.root, 'notes.txt')
    writeFileSync(file, 'hi')
    const result = await provider.uploadFile(session, { filePath: file })
    assert.equal(result.path, file)
    const set = host.log.find(entry => entry.method === 'DOM.setFileInputFiles')
    assert.deepEqual(set.params.files, [resolve(file)])
  } finally {
    sandbox.cleanup()
  }
})
