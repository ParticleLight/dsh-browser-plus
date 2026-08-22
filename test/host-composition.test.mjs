import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const hostPath = new URL('../lib/browser-electron/host-main.js', import.meta.url)
const providerPath = new URL('../lib/browser-electron/provider.js', import.meta.url)
const remotePath = new URL('../lib/browser-electron/remote-host.js', import.meta.url)

test('showView changes visibility without reparenting a page view', async () => {
  const source = await readFile(hostPath, 'utf8')
  const start = source.indexOf("case 'showView'")
  const end = source.indexOf("case 'command'", start)
  assert.ok(start >= 0 && end > start, 'showView block exists')
  const showBlock = source.slice(start, end)
  assert.doesNotMatch(showBlock, /removeChildView/)
  assert.doesNotMatch(showBlock, /addChildView/)
})

test('host installs page chrome before creating the visible page surface', async () => {
  const source = await readFile(hostPath, 'utf8')
  assert.match(source, /buildPageChromeScript/)
  assert.ok(source.includes('executeJavaScript('), 'uses native executeJavaScript')
  assert.ok(source.includes('__dshTrail'), 'injects trail with chrome')
  assert.ok(source.includes("on('did-navigate'"), 'reapplies on navigation')
  assert.match(source, /void installPageChrome\(view, viewId\)/)
})

test('snapshots expose user-control state', async () => {
  const source = await readFile(providerPath, 'utf8')
  assert.match(source, /userControlling/)
  assert.match(source, /data-dsh-user-active/)
})

test('host keeps popup navigation inside the shared view', async () => {
  const source = await readFile(hostPath, 'utf8')
  assert.match(source, /setWindowOpenHandler/)
  assert.match(source, /action: 'deny'/)
})

test('host records trace ops and injects the trail into chrome', async () => {
  const source = await readFile(hostPath, 'utf8')
  assert.match(source, /case 'trace'/)
  assert.match(source, /__dshTrail/)
  assert.match(source, /traces/)
})

test('provider forwards each record as a host trace', async () => {
  const source = await readFile(providerPath, 'utf8')
  assert.match(source, /host\.trace/)
})

test('remote host forwards trace to the child', async () => {
  const source = await readFile(remotePath, 'utf8')
  assert.ok(source.includes("call('trace'"), 'forwards trace op')
})

test('model-facing snapshots ignore injected chrome controls', async () => {
  const source = await readFile(providerPath, 'utf8')
  assert.match(source, /data-dsh-browser-chrome/)
  assert.match(source, /closest\(/)
})

test('provider re-injects chrome after every navigation', async () => {
  const source = await readFile(providerPath, 'utf8')
  assert.match(source, /PAGE_CHROME_SCRIPT/)
  assert.match(source, /reinstallPageChrome\(handle\)/)
})

test('provider retains document-ready waiting and SPA empty-snapshot retry', async () => {
  const source = await readFile(providerPath, 'utf8')
  assert.match(source, /waitForDocumentReady/)
  assert.match(source, /attempt < 5/)
  assert.match(source, /readiness wait exceeded/)
})
test('host auto-accepts JS dialogs and exposes drainDialog', async () => {
  const source = await readFile(hostPath, 'utf8')
  assert.ok(source.includes("'Page.enable'"), 'enables Page domain')
  assert.ok(source.includes("'DOM.enable'"), 'enables DOM domain')
  assert.match(source, /Page\.javascriptDialogOpening/)
  assert.match(source, /Page\.handleJavaScriptDialog/)
  assert.match(source, /dialogLogs/)
  assert.match(source, /case 'drainDialog'/)
})

test('provider drains auto-accepted dialogs into history', async () => {
  const source = await readFile(providerPath, 'utf8')
  assert.match(source, /clearDialog/)
  assert.match(source, /this\.record\(s, 'dialog'/)
})

test('snapshots emit a targeted locator per element', async () => {
  const source = await readFile(providerPath, 'utf8')
  assert.match(source, /const locatorOf = /)
  assert.match(source, /CSS\.escape/)
  assert.match(source, /\[aria-label=|\(aria-label\)/)
  assert.match(source, /loc: locatorOf\(el\)/)
})

test('host keeps one window per session key and labels them', async () => {
  const source = await readFile(hostPath, 'utf8')
  assert.match(source, /windowsByKey/)
  assert.match(source, /windowFor\(/)
  assert.match(source, /case 'label'/)
  assert.match(source, /case 'listWindows'/)
  assert.match(source, /dsh-browser-plus — /)
  assert.match(source, /v\.window !== entry\.window/)
  assert.ok(!source.includes('layoutPageViews()'), 'window-scoped layout only')
})

test('provider opens with a window key and label through the host seam', async () => {
  const source = await readFile(providerPath, 'utf8')
  assert.match(source, /createView\(options\?\.key/)
})

test('capture CDP fallback detaches only same-window siblings', async () => {
  const source = await readFile(hostPath, 'utf8')
  const start = source.indexOf("case 'capture'")
  const end = source.indexOf("case 'download'", start)
  assert.ok(start >= 0 && end > start, 'capture block exists')
  const captureBlock = source.slice(start, end)
  assert.match(captureBlock, /v !== entry && v\.window === entry\.window/)
})

test('default window resets on close and first visibility is per window', async () => {
  const source = await readFile(hostPath, 'utf8')
  assert.match(source, /defaultWindow\.on\('closed'/)
  assert.match(source, /windowLabels\.delete\('default'\)/)
  assert.match(source, /!defaultWindow\.isDestroyed\(\)/)
  assert.ok(!source.includes('views.size === 0'), 'process-global first-view check removed')
  assert.match(source, /some\(v => v\.window === win\)/)
})

test('remote host forwards createView key/label and window ops', async () => {
  const source = await readFile(remotePath, 'utf8')
  assert.ok(source.includes("call('createView'"), 'creates views')
  assert.match(source, /\.\.\.key !== undefined/)
  assert.ok(source.includes("call('label'"), 'labels windows')
  assert.ok(source.includes("call('listWindows'"), 'lists windows')
})


test('recovered remote views settle the compositor before capture operations', async () => {
  const source = await readFile(remotePath, 'utf8')
  assert.match(source, /RECOVERY_CAPTURE_SETTLE_MS = 3_000/)
  assert.match(source, /recoveryCompositorSettle/)
  assert.match(source, /settleRecoveredCompositorForCapture/)
  const captureStart = source.indexOf('async capture()')
  const captureEnd = source.indexOf('async flushAuth()', captureStart)
  assert.ok(captureStart >= 0 && captureEnd > captureStart, 'capture method exists')
  assert.match(source.slice(captureStart, captureEnd), /settleRecoveredCompositorForCapture/)
  const deferredStart = source.indexOf('class DeferredRemoteView')
  const commandStart = source.indexOf('async sendCommand(', deferredStart)
  const commandEnd = source.indexOf('async download(', commandStart)
  assert.ok(commandStart >= 0 && commandEnd > commandStart, 'sendCommand method exists')
  const commandBlock = source.slice(commandStart, commandEnd)
  assert.match(commandBlock, /method === 'Page\.captureScreenshot'/)
  assert.match(commandBlock, /settleRecoveredCompositorForCapture/)
})
