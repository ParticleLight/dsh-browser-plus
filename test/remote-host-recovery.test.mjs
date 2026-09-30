import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as remoteHost from '../lib/browser-electron/remote-host.js'

const DEAD = remoteHost.BROWSER_HOST_DEAD_CODE

/** An error shaped like one raised by ElectronChildClient on a death path. */
function deadError(message) {
  return Object.assign(new Error(message), { code: DEAD })
}

/**
 * A DeferredRemoteView whose first materialization yields a view that throws
 * `error` and whose second yields a healthy view. No child process is spawned:
 * DeferredRemoteView talks to the injected materializer only.
 */
function deathThenRecovery(error) {
  const materializeLabels = []
  const failing = { async sendCommand() { throw error } }
  const recovered = { async sendCommand() { return { recovered: true } } }
  const view = new remoteHost.DeferredRemoteView('view:test', 'T', async label => {
    materializeLabels.push(label)
    return materializeLabels.length === 1 ? failing : recovered
  })
  return { view, materializeLabels }
}

test('a child that dies mid-call self-heals once, judged by the stable code', async () => {
  // Exactly what ElectronChildClient.fail() rejects with when the child exits
  // while this handle's RPC is in flight: the old message-substring check
  // missed it, so the call failed instead of recovering.
  const { view, materializeLabels } = deathThenRecovery(deadError('dsh-browser-plus: browser host exited (code=1 signal=null)'))
  assert.deepEqual(await view.sendCommand('Runtime.evaluate'), { recovered: true })
  assert.deepEqual(materializeLabels, ['T', 'T'], 're-materialized exactly once')
})

test('every child-death path self-heals once it carries the stable code', async () => {
  const deaths = [
    'dsh-browser-plus: browser host is not running',                        // call() after the child died
    'dsh-browser-plus: browser host exited (code=1 signal=null)',           // child 'exit'
    'dsh-browser-plus: browser host failed to start: Error: spawn ENOENT',  // child 'error' (spawn failure)
    'dsh-browser-plus: browser host connection closed',                     // socket 'close'
    'dsh-browser-plus: RPC reply exceeded 134217728 bytes',                 // buffer-overflow teardown
  ]
  for (const message of deaths) {
    const error = deadError(message)
    assert.equal(remoteHost.isBrowserHostDead(error), true, message)
    const { view, materializeLabels } = deathThenRecovery(error)
    assert.deepEqual(await view.sendCommand('Page.navigate'), { recovered: true }, message)
    assert.equal(materializeLabels.length, 2, message)
  }
})

test('the stable code is what triggers recovery, not the wording', async () => {
  // Same text as a real exit error, but no code: this is the OLD contract, and
  // it must not be treated as a dead host by the new code path.
  const noCode = new Error('dsh-browser-plus: browser host exited (code=1 signal=null)')
  assert.equal(remoteHost.isBrowserHostDead(noCode), false)
  const { view, materializeLabels } = deathThenRecovery(noCode)
  await assert.rejects(view.sendCommand('Runtime.evaluate'), /browser host exited/)
  assert.deepEqual(materializeLabels, ['T'], 'no second materialization')
})

test('the legacy browser-host-is-not-running message still self-heals', async () => {
  // recovery-metadata.test.mjs relies on this plain, code-less error.
  const legacy = new Error('browser host is not running')
  assert.equal(remoteHost.isBrowserHostDead(legacy), true)
  const { view, materializeLabels } = deathThenRecovery(legacy)
  assert.deepEqual(await view.sendCommand('Runtime.evaluate'), { recovered: true })
  assert.deepEqual(materializeLabels, ['T', 'T'])
})

test('a child found dead while materializing self-heals', async () => {
  const labels = []
  const recovered = { async sendCommand() { return { recovered: true } } }
  const view = new remoteHost.DeferredRemoteView('view:test', 'T', async label => {
    labels.push(label)
    if (labels.length === 1) throw deadError('browser host unavailable')
    return recovered
  })
  assert.deepEqual(await view.sendCommand('Runtime.evaluate'), { recovered: true })
  assert.deepEqual(labels, ['T', 'T'])
})

test('unrelated RPC failures are not retried', async () => {
  const { view, materializeLabels } = deathThenRecovery(new Error('label RPC failed'))
  await assert.rejects(view.sendCommand('Runtime.evaluate'), /label RPC failed/)
  assert.deepEqual(materializeLabels, ['T'])
})

test('a disposed host rejects instead of respawning the child', async () => {
  // The host is never started: dispose() runs before any call, and the
  // disposed guard must win so no Electron process is spawned (which would
  // otherwise happen here, or in a withView self-heal retry).
  const host = new remoteHost.RemoteElectronViewHost('Z:\\nonexistent\\host-main.js')
  host.dispose()
  await assert.rejects(host.listWindows(), error => {
    assert.match(error.message, /browser host is disposed/)
    assert.equal(remoteHost.isBrowserHostDead(error), false, 'a disposed host must not be retried')
    return true
  })
  await assert.rejects(host.listTasks(), /browser host is disposed/)
})

test('parent RPC buffer cap fits a maximum-size child download', async () => {
  const source = await readFile(new URL('../lib/browser-electron/remote-host.js', import.meta.url), 'utf8')
  assert.match(source, /const MAX_RPC_BUFFER_BYTES = 128 \* 1024 \* 1024\b/)
  // Derivation: the child caps a download at 64 MiB and ships it base64 (4/3),
  // so the parent buffer must fit that reply with headroom — but stay bounded.
  const base64Reply = Math.ceil(64 * 1024 * 1024 * 4 / 3)
  const bufferCap = 128 * 1024 * 1024
  assert.ok(bufferCap >= base64Reply, 'a maximum-size download reply must fit: ' + String(base64Reply))
  assert.ok(bufferCap < base64Reply * 4, 'the cap must still bound a pathological child')
  assert.match(source, /base64/, 'the derivation is documented at the constant')
})
