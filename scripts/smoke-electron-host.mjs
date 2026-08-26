import assert from 'node:assert/strict'

import { RemoteElectronViewHost, defaultHostMainPath } from '../lib/browser-electron/remote-host.js'

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' timed out after ' + String(timeoutMs) + 'ms')), timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const host = new RemoteElectronViewHost(defaultHostMainPath())
try {
  const view = host.createView('electron-host-smoke', 'Electron Host Smoke')
  await withTimeout(view.sendCommand('Page.navigate', { url: 'http://127.0.0.1:3080/' }), 15_000, 'Page.navigate')
  const binding = await withTimeout(view.sendCommand('Runtime.evaluate', {
    expression: 'typeof window.__dshBrowserTaskAction',
    returnByValue: true,
  }), 10_000, 'binding probe')
  assert.equal(binding.result?.value, 'function', 'page task binding must be present')
  const chromeReady = await withTimeout(view.sendCommand('Runtime.evaluate', {
    expression: "new Promise(resolve => { const deadline = Date.now() + 3000; const inspect = () => { const host = document.getElementById('__dsh_browser_chrome_host__'); if (host?.getAttribute('data-dsh-browser-ready') === '1' || Date.now() >= deadline) { resolve(host?.getAttribute('data-dsh-browser-ready') || null); return } setTimeout(inspect, 50) }; inspect() })",
    returnByValue: true,
    awaitPromise: true,
  }), 5_000, 'chrome ready probe')
  assert.equal(chromeReady.result?.value, '1', 'page chrome must finish wiring interactive controls')

  // The renderer's direct DOM interaction path is covered by page-chrome
  // regression tests. CDP Input.dispatchMouseEvent does not surface a DOM
  // pointer event in Electron 42, so it cannot faithfully stand in for a hand.
  await delay(300)
  await withTimeout(view.sendCommand('Runtime.evaluate', {
    expression: "window.__dshBrowserTaskAction(JSON.stringify({ type: 'set-control-owner', taskKey: 'electron-host-smoke', control: 'human' })); 'sent'",
    returnByValue: true,
  }), 10_000, 'binding action')
  await delay(300)
  const task = await withTimeout(host.getTask('electron-host-smoke'), 10_000, 'task state query')
  assert.equal(task?.control, 'human', 'Host must receive the page handoff')
  assert.equal(task?.status, 'waiting-user', 'Host must show the handoff state')
  console.log(JSON.stringify({ ok: true, task }))
} finally {
  host.dispose()
}
