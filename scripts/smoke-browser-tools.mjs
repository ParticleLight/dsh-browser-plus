/**
 * Integration smoke for the provider's tool surface, against a REAL Electron
 * host. The unit suite drives a fake host, so this is the only place the whole
 * chain runs end to end: provider -> RPC -> host-main -> CDP -> Chromium.
 *
 * It takes its own profile via DSH_BROWSER_PLUS_USER_DATA, because Chromium
 * holds a singleton lock per profile and the one a running DSH uses is busy.
 * A window will appear for the duration; that is the point.
 *
 * Run: npm run smoke:browser-tools
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'
import { RemoteElectronViewHost, defaultHostMainPath } from '../lib/browser-electron/remote-host.js'

const profile = mkdtempSync(join(tmpdir(), 'dsh-bt-profile-'))
const outDir = mkdtempSync(join(tmpdir(), 'dsh-bt-out-'))
// Must be set before the host spawns: the child reads it at startup.
process.env.DSH_BROWSER_PLUS_USER_DATA = profile

const results = []
const check = async (name, fn) => {
  try {
    const value = await fn()
    results.push({ name, ok: true })
    console.log('  ok   ' + name.padEnd(26) + (value === undefined ? '' : JSON.stringify(value).slice(0, 110)))
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error) })
    console.log('  FAIL ' + name.padEnd(26) + String(error?.message ?? error).slice(0, 170))
  }
}

const host = new RemoteElectronViewHost(defaultHostMainPath())
const provider = new ElectronBrowserProvider(host, { writeRoots: [outDir], readRoots: [outDir] })

try {
  const session = await provider.open()
  console.log('session', session)

  await check('navigate', async () => {
    await provider.navigate(session, { url: 'https://example.com/' })
    const tabs = await provider.listTabs(session)
    return tabs.find(tab => tab.active)?.url ?? '(no active tab)'
  })
  await check('content', async () => (await provider.content(session, { format: 'txt', maxChars: 300 })).content.slice(0, 50))
  await check('snapshot', async () => (await provider.snapshot(session)).elements.length)
  await check('screenshot', async () => (await provider.screenshot(session)).dataUrl.length)
  // Non-navigating targets on purpose: clicking the "Learn more" link would move
  // the page on and invalidate every later check. example.com currently has no
  // h1 and splits its body text into one span per character, so the paragraph is
  // the honest target — and matching it proves the matcher walks containers
  // rather than only leaf nodes.
  await check('click selector', async () => await provider.click(session, { selector: 'p' }))
  await check('click text', async () => await provider.click(session, { text: 'This domain is for use' }))
  await check('click coordinates', async () => await provider.click(session, { x: 5, y: 5 }))
  await check('click text missing', async () => {
    try { await provider.click(session, { text: 'zzz-not-here-zzz' }) } catch (error) { return error.code }
    return 'no error'
  })
  await check('waitForElement', async () => (await provider.waitForElement(session, { selector: 'body' })).tag)
  await check('scrape concurrent', async () => {
    const out = join(outDir, 'rows.jsonl')
    const started = await provider.startScrape(session, {
      urls: ['https://example.com/', 'https://www.iana.org/help/example-domains'],
      script: '({ title: document.title, links: document.querySelectorAll("a").length })',
      outPath: out,
      concurrency: 2,
      timeoutMs: 20_000,
    })
    for (let i = 0; i < 120; i += 1) {
      const status = await provider.scrapeStatus(started.id)
      if (status.state !== 'running') {
        const rows = readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        return { state: status.state, rows: rows.length, seqs: rows.map(row => row.seq).sort((a, b) => a - b) }
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    return 'timed out'
  })
  // example.com sets no cookies, so the round trip needs a host that does.
  await check('cookie round trip', async () => {
    await provider.navigate(session, { url: 'https://httpbin.org/cookies/set?dsh_probe=1' })
    const exported = await provider.flushAuth(session)
    const file = join(outDir, 'cookies.json')
    writeFileSync(file, JSON.stringify({ cookies: exported }))
    const probe = () => exported.filter(cookie => cookie.name === 'dsh_probe').length
    await provider.clearAuth(session, { name: 'dsh_probe' })
    const afterClear = (await provider.flushAuth(session)).filter(cookie => cookie.name === 'dsh_probe').length
    const imported = await provider.importAuth(session, file)
    const afterImport = (await provider.flushAuth(session)).filter(cookie => cookie.name === 'dsh_probe').length
    return { exported: exported.length, probe: probe(), afterClear, restored: imported.restored, failed: imported.failed, afterImport }
  })
  await check('chromeWorld config reachable', async () => (await provider.listTabs(session)).length)
} finally {
  host.dispose()
  await new Promise(resolve => setTimeout(resolve, 1500))
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* locked briefly */ }
  try { rmSync(outDir, { recursive: true, force: true }) } catch { /* locked briefly */ }
}

const failed = results.filter(result => !result.ok)
console.log('')
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, failures: failed.map(f => f.name) }))
process.exit(failed.length === 0 ? 0 : 1)
