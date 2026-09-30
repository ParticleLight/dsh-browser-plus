import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { buildPageChromeScript } from '../lib/browser-electron/page-chrome.js'
import { resolveWritePath } from '../lib/browser-electron/write-guard.js'

/**
 * Task summaries are injected into every visited page's main world, so a page
 * could read the visible task's 288px JPEG (its screen content) and error
 * strings carrying absolute paths. The image now travels only through the
 * targeted 'task.thumbnail' patch, which is queued for the visible task alone.
 *
 * host-main.ts imports electron and cannot be loaded under node --test, so the
 * host half is asserted against its source (the pattern this repo already uses
 * for host line-order contracts).
 */

const hostPath = new URL('../src/browser-electron/host-main.ts', import.meta.url)

test('page-visible task summaries carry no thumbnail image', async () => {
  const source = await readFile(hostPath, 'utf8')
  const start = source.indexOf('function taskSummaries')
  const end = source.indexOf('function activeTraceForTask', start)
  assert.ok(start >= 0 && end > start, 'task summary block exists')
  const block = source.slice(start, end)
  assert.match(block, /thumbnailVersion:/, 'keeps the version so the chrome can reconcile')
  assert.doesNotMatch(block, /thumbnail: thumbnail/, 'never ships the JPEG inside a summary')
})

test('the injected chrome reads thumbnails from its own cache', () => {
  const script = buildPageChromeScript()
  assert.match(script, /taskThumbCache\.get\(taskKey\)/, 'the painter reads the cache')
  assert.match(script, /taskThumbCache\.set\(operation\.key, operation\.dataUrl\)/, 'the targeted patch fills it')
  assert.doesNotMatch(script, /typeof task\.thumbnail === 'string'/, 'no bulk field read remains')
})

test('the thumbnail cache is pruned to the tasks that still exist', () => {
  const script = buildPageChromeScript()
  assert.match(script, /taskThumbCache\.delete\(key\)/, 'drops entries for tasks the host no longer reports')
  assert.match(script, /const liveKeys = new Set/, 'prunes against the bootstrap task list')
})

test('a refused write does not echo the allowed roots into the error text', () => {
  const root = join(tmpdir(), 'dsh-redaction-root')
  let message = ''
  try {
    resolveWritePath(join(tmpdir(), 'outside.png'), [root])
    assert.fail('expected the write to be refused')
  } catch (error) {
    message = String(error.message)
  }
  assert.match(message, /outside the allowed roots/, 'still explains the refusal')
  assert.match(message, /writeRoots/, 'still names the config key to fix')
  assert.ok(!message.includes(root), `must not echo the root path, got: ${message}`)
})

test('an empty root list still says so without naming any path', () => {
  assert.throws(() => resolveWritePath(join(tmpdir(), 'x.png'), []), /\(none configured\)/)
})
