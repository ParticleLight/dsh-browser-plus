import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const thumbnail = await import('../lib/browser-electron/task-thumbnail.js')

const {
  MAX_TASK_THUMBNAIL_BYTES,
  TASK_THUMBNAIL_JPEG_QUALITY,
  TASK_THUMBNAIL_WIDTH,
  taskThumbnailDataUrl,
} = thumbnail

test('exports the bounded thumbnail encoder API', () => {
  assert.equal(TASK_THUMBNAIL_WIDTH, 288)
  assert.equal(TASK_THUMBNAIL_JPEG_QUALITY, 58)
  assert.equal(MAX_TASK_THUMBNAIL_BYTES, 180 * 1024)
  assert.equal(typeof taskThumbnailDataUrl, 'function')
})

test('encodes a resized image as a JPEG data URL', () => {
  const resizeCalls = []
  const image = {
    resize(options) {
      resizeCalls.push(options)
      return {
        toJPEG(quality) {
          assert.equal(quality, 58)
          return Buffer.from('jpeg:58')
        },
      }
    },
  }

  assert.equal(taskThumbnailDataUrl(image), 'data:image/jpeg;base64,anBlZzo1OA==')
  assert.deepEqual(resizeCalls, [{ width: 288 }])
})

test('rejects empty and oversized JPEG buffers', () => {
  for (const jpeg of [Buffer.alloc(0), Buffer.alloc(181 * 1024)]) {
    const image = {
      resize() {
        return { toJPEG: () => jpeg }
      },
    }

    assert.equal(taskThumbnailDataUrl(image), undefined)
  }
})

test('the host replays every task image to the surface that shows the panel', async () => {
  // A chrome surface only ever receives a task's image through a targeted
  // 'task.thumbnail' patch, and the capture path queues those for the visible
  // task alone. So the host has to hand over the images it already holds
  // whenever a surface starts showing the panel — otherwise the panel shows the
  // current task's picture and a placeholder for every other one, even for
  // tasks the human already looked at.
  const host = await readFile(new URL('../lib/browser-electron/host-main.js', import.meta.url), 'utf8')
  assert.ok(host.includes('function pushCachedTaskThumbnails('), 'the replay helper exists')
  assert.ok(host.includes('if (workspacePanels.tasks)'), 'the panel-open path is there')
  const call = 'pushCachedTaskThumbnails();'
  const calls = host.split(call).length - 1
  assert.equal(calls, 2, 'declared once and called from the two moments a surface starts showing the panel')
  const switchAt = host.indexOf('function switchVisibleTask(')
  const switchBody = switchAt < 0 ? '' : host.slice(switchAt, switchAt + 1200)
  assert.ok(switchBody.includes(call), 'switching tasks replays them too')
})
