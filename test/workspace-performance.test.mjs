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
