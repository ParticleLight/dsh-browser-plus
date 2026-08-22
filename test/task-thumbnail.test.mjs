import assert from 'node:assert/strict'
import test from 'node:test'

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
