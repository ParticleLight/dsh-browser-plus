/**
 * Verify chromeWorld: 'isolated' in a real window.
 *
 * This is the one declared feature that had never been exercised: the chrome is
 * injected into an isolated world so the page's own scripts cannot read its
 * globals. The claim has two halves -- the chrome still mounts, and the page's
 * main world cannot see it -- and an A/B against the default mode proves the
 * switch actually changes something rather than being inert.
 *
 * Run: npm run smoke:chrome-world
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RemoteElectronViewHost, defaultHostMainPath } from '../lib/browser-electron/remote-host.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const results = []

const probe = async (label, options) => {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-chrome-world-'))
  process.env.DSH_BROWSER_PLUS_USER_DATA = profile
  const host = new RemoteElectronViewHost(defaultHostMainPath(), options)
  try {
    const view = host.createView('chrome-world', 'Chrome World')
    await view.sendCommand('Page.enable', {})
    await view.sendCommand('Page.navigate', { url: 'https://example.com/' })
    await wait(2500)
    const reply = await view.sendCommand('Runtime.evaluate', {
      expression: 'JSON.stringify({ chromeHost: document.getElementById("__dsh_browser_chrome_host__") !== null, binding: typeof window.__dshBrowserTaskAction, tasks: typeof window.__dshTasks, trail: typeof window.__dshTrail })',
      returnByValue: true,
    })
    const value = JSON.parse(reply?.result?.value ?? '{}')
    results.push({ label, ...value })
    console.log('  ' + label.padEnd(22) + JSON.stringify(value))
    return value
  } finally {
    host.dispose()
    await wait(1500)
    try { rmSync(profile, { recursive: true, force: true }) } catch { /* briefly locked */ }
  }
}

const main = await probe('main (default)', {})
const isolated = await probe('isolated', { chromeWorld: 'isolated' })

// Assert only what chromeWorld claims. window.__dshBrowserTaskAction is reported
// but not asserted: it appears asynchronously after load, so a fixed wait
// measures it inconsistently (observed both ways at 2.5s and 3s).
const failures = []
if (main.chromeHost !== true) failures.push('the chrome did not mount in main mode')
if (main.tasks !== 'object' || main.trail !== 'object') failures.push('main mode should leak the chrome globals, or the A/B proves nothing')
if (isolated.chromeHost !== true) failures.push('the chrome did not mount in isolated mode')
for (const key of ['binding', 'tasks', 'trail']) {
  if (isolated[key] !== 'undefined') failures.push('isolated mode still leaks window.' + (key === 'binding' ? '__dshBrowserTaskAction' : '__dsh' + key[0].toUpperCase() + key.slice(1)))
}
console.log('')
if (failures.length > 0) {
  console.log(JSON.stringify({ ok: false, failures }))
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, note: 'the chrome mounts in both modes; only the default leaks its globals to the page' }))
