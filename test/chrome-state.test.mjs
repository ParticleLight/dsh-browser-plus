import assert from 'node:assert/strict'
import test from 'node:test'

import { createBootstrap, createPatch } from '../lib/browser-electron/chrome-state.js'

const task = {
  key: 'task-a',
  label: 'Research',
  active: true,
  background: false,
  url: 'https://example.com',
  tabs: 2,
  status: 'running',
  control: 'agent',
  updatedAt: 1,
  thumbnailVersion: 0,
}

test('workspace bootstrap carries a complete selected-task snapshot', () => {
  const message = createBootstrap({
    epoch: 3,
    revision: 5,
    selectedTaskKey: 'task-a',
    panels: { tasks: true, trail: false },
    tasks: [task],
    trail: [{ action: 'navigate', at: 2, ok: true }],
  })

  assert.equal(message.kind, 'bootstrap')
  assert.equal(message.epoch, 3)
  assert.equal(message.revision, 5)
  assert.equal(message.tasks[0].key, 'task-a')
  assert.equal(message.trail.length, 1)
})

test('workspace patches carry only the requested operations', () => {
  const operations = [
    { op: 'task.upsert', task },
    { op: 'trail.append', taskKey: 'task-a', entry: { action: 'click', at: 4, ok: true } },
  ]
  const patch = createPatch(3, 6, operations)

  assert.deepEqual(patch, { kind: 'patch', epoch: 3, revision: 6, operations })
  assert.equal('tasks' in patch, false)
  assert.equal('trail' in patch, false)
})
