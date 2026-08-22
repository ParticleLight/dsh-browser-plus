import test from 'node:test'
import assert from 'node:assert/strict'
import * as remoteHost from '../lib/browser-electron/remote-host.js'

test('DeferredRemoteView keeps the latest successful task label across recovery', async () => {
  assert.equal(typeof remoteHost.DeferredRemoteView, 'function', 'DeferredRemoteView is testable')
  const materializeLabels = []
  let rejectFirstLabel
  const initialView = {
    async label(label) {
      if (label === 'A') {
        return new Promise((resolve, reject) => { rejectFirstLabel = reject })
      }
    },
    async sendCommand() {
      throw new Error('browser host is not running')
    },
  }
  const recoveredView = {
    async label() {},
    async sendCommand() { return { recovered: true } },
  }
  const view = new remoteHost.DeferredRemoteView('view:test', 'X', async label => {
    materializeLabels.push(label)
    return materializeLabels.length === 1 ? initialView : recoveredView
  })

  const first = view.label('A')
  await new Promise(resolve => setImmediate(resolve))
  await view.label('B')
  rejectFirstLabel(new Error('label RPC failed'))
  await assert.rejects(first, /label RPC failed/)

  assert.deepEqual(await view.sendCommand('Runtime.evaluate'), { recovered: true })
  assert.deepEqual(materializeLabels, ['A', 'B'])
})

test('taskSummaryUrl strips path query hash and opaque URLs', async () => {
  const taskSummary = await import('../lib/browser-electron/task-summary.js').catch(() => undefined)
  assert.ok(taskSummary, 'task summary helper module exists')
  const { taskSummaryUrl } = taskSummary
  assert.equal(taskSummaryUrl('https://example.com/private/doc?token=secret#section'), 'https://example.com')
  assert.equal(taskSummaryUrl('https://example.com/'), 'https://example.com')
  assert.equal(taskSummaryUrl('about:blank'), '')
  assert.equal(taskSummaryUrl('data:text/plain,secret'), '')
  assert.equal(taskSummaryUrl('not a URL'), '')
})

test('DeferredRemoteView stays outside the package main API', async () => {
  const packageMain = await import('../lib/index.js')
  assert.equal('DeferredRemoteView' in packageMain, false)
  assert.equal(typeof packageMain.RemoteElectronViewHost, 'function')
})
