import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const hostPath = new URL('../src/browser-electron/host-main.ts', import.meta.url)
const chromePath = new URL('../src/browser-electron/page-chrome.ts', import.meta.url)
const remotePath = new URL('../src/browser-electron/remote-host.ts', import.meta.url)

test('host emits versioned workspace bootstrap and batched patches', async () => {
  const source = await readFile(hostPath, 'utf8')
  assert.match(source, /createBootstrap/)
  assert.match(source, /createPatch/)
  assert.match(source, /chromeEpoch/)
  assert.match(source, /chromeRevision/)
  assert.match(source, /pendingChromeOperations/)
  assert.match(source, /queueChromePatch/)
  assert.match(source, /setTimeout\(flushChromePatches, 24\)/)
  assert.match(source, /resetChromeDelivery/)
})

test('host limits thumbnail capture to visible open workspace demand', async () => {
  const source = await readFile(hostPath, 'utf8')
  const start = source.indexOf('function scheduleVisibleTaskThumbnail')
  const end = source.indexOf('/** Select a task', start)
  assert.ok(start >= 0 && end > start, 'thumbnail scheduler exists')
  const block = source.slice(start, end)
  assert.match(block, /!workspacePanels.tasks/)
  assert.match(block, /thumbnailCaptureInFlight/)
  assert.match(block, /2_000/)
  assert.match(block, /taskThumbnails.size > 32/)
  assert.match(block, /thumbnailDirty/)
})


test('remote child RPC has bounded queries and timeout-driven recovery', async () => {
  const source = await readFile(remotePath, 'utf8')
  assert.match(source, /RPC_QUERY_TIMEOUT_MS = 8_000/)
  assert.match(source, /RPC_COMMAND_TIMEOUT_MS = 35_000/)
  assert.match(source, /RPC_TRANSFER_TIMEOUT_MS = 120_000/)
  assert.match(source, /this\.pending\.delete\(id\)/)
  assert.match(source, /this\.fail\(error\)/)
  assert.match(source, /this\.child\.kill\(\)/)
  assert.match(source, /listTasks', {}, RPC_QUERY_TIMEOUT_MS/)
  assert.match(source, /getTask', { key }, RPC_QUERY_TIMEOUT_MS/)
})

test('page chrome applies patches without rebuilding all task and trail state', async () => {
  const source = await readFile(chromePath, 'utf8')
  assert.match(source, /window.__dshChromeApply = applyChromeMessage/)
  assert.match(source, /patchTaskRow/)
  assert.match(source, /appendTrailEntry/)
  assert.match(source, /taskPatches/)
  assert.match(source, /trailAppends/)
  assert.match(source, /window.__dshChromeSetActive/)
  assert.match(source, /stopChromeTimers/)
  assert.match(source, /startChromeTimers/)
})

test('a failed thumbnail capture does not re-arm the retry loop', async () => {
  const source = await readFile(hostPath, 'utf8')
  const start = source.indexOf('async function refreshVisibleTaskThumbnail')
  const end = source.indexOf('/** Select a task', start)
  assert.ok(start >= 0 && end > start, 'thumbnail refresh exists')
  const block = source.slice(start, end)
  assert.match(block, /let produced = false/, 'tracks whether a capture produced an image')
  assert.match(block, /produced = true/, 'marks the success path')
  const branch = block.indexOf('if (produced) {')
  const clear = block.indexOf('thumbnailDirty.delete(taskKey)', branch)
  assert.ok(branch >= 0 && clear > branch, 'the failure path clears dirty so a broken window is not re-captured at 5Hz')
})

test('download enforces its cap while streaming rather than after buffering', async () => {
  const source = await readFile(hostPath, 'utf8')
  const start = source.indexOf("case 'download':")
  const end = source.indexOf("case 'flushAuth':", start)
  assert.ok(start >= 0 && end > start, 'download op exists')
  const block = source.slice(start, end)
  assert.doesNotMatch(block, /arrayBuffer\(\)/, 'never buffers the whole body before checking the size')
  assert.match(block, /getReader\(\)/, 'reads the body as a stream')
  assert.match(block, /content-length/, 'rejects a declared oversize body before reading it')
  assert.match(block, /reader\.cancel\(\)/, 'cancels the stream once the cap is exceeded')
  assert.match(block, /AbortSignal\.timeout/, 'bounds the in-page fetch')
})

test('a download is written by the child and reported as a byte count', async () => {
  const [host, remote] = await Promise.all([readFile(hostPath, 'utf8'), readFile(remotePath, 'utf8')])
  const start = host.indexOf("case 'download':")
  const end = host.indexOf("case 'flushAuth':", start)
  assert.ok(start >= 0 && end > start, 'download op exists')
  const block = host.slice(start, end)
  assert.match(block, /writeFileSync\(savePath, bytes\)/, 'the child writes the file itself')
  assert.match(block, /result: \{ bytes: bytes\.length \}/, 'and reports only its size')
  assert.doesNotMatch(block, /base64: value/, 'the body no longer crosses the RPC line')

  const downloadStart = remote.indexOf('async download(url: string, savePath: string)')
  assert.ok(downloadStart >= 0, 'the parent-side download exists')
  const downloadBlock = remote.slice(downloadStart, remote.indexOf('\n  }', downloadStart))
  assert.doesNotMatch(downloadBlock, /writeFileSync/, 'the parent no longer buffers and writes it')
})
test('every chrome injection goes through the world-aware helper', async () => {
  const source = await readFile(hostPath, 'utf8')
  const direct = source.match(/executeJavaScript\(/g) ?? []
  assert.equal(direct.length, 1, 'only runChromeScript touches executeJavaScript directly')
  assert.match(source, /function runChromeScript\(view: WebContentsView, snippet: string\)/)
  assert.match(source, /Page\.createIsolatedWorld/, 'isolated mode creates its own world')
  assert.match(source, /executionContextName: CHROME_WORLD_NAME/, 'and scopes the binding to it')
  assert.match(source, /if \(CHROME_WORLD === 'main'\) \{/, 'main mode keeps the old binding registration')
  assert.match(source, /chromeContexts\.delete\(view\)/, 'a new document drops the stale world')
})

test('the chrome world travels to the child as an argument', async () => {
  const source = await readFile(remotePath, 'utf8')
  assert.match(source, /'--chrome-world', 'isolated'/, 'the child is told which world to use')
  assert.match(source, /this\.chromeWorld === 'isolated'/, 'and only for the opt-in mode')
  assert.match(source, /chromeWorld\?: 'main' \| 'isolated'/, 'the option is typed')
})
test('a fresh view commits a dark start page instead of staying blank', async () => {
  const source = await readFile(hostPath, 'utf8')
  // A WebContentsView with no committed document paints white AND leaves CDP
  // with no frame to evaluate against, so an un-navigated window made every
  // browser_* call time out. The empty state is a real document for that reason.
  assert.match(source, /const START_PAGE_URL = 'data:text\/html;charset=utf-8,' \+ encodeURIComponent\(START_PAGE_HTML\)/)
  assert.match(source, /void view\.webContents\.loadURL\(START_PAGE_URL\)/, 'createView loads it')
  assert.match(source, /backgroundColor: '#0e1218'/, 'the window frame is dark too')
  assert.match(source, /START_PAGE_HTML[\s\S]{0,600}background:radial-gradient/, 'and the page itself is dark')
})
