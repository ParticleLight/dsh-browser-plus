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
import { apply } from '../lib/tool-browser/index.js'
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
// The three checks below assert that the page RECEIVED the event. Resolution
// alone is not a click: browser_click can resolve the right element, report
// success, and still leave the page untouched.
await check('left-click reaches the page', async () => {
  await provider.execute(session, { script: `(() => {
    window.__left = []
    for (const type of ['mousedown', 'mouseup', 'click']) {
      window.addEventListener(type, event => window.__left.push(type), true)
    }
    return 'armed'
  })()` })
  // body, not a paragraph: earlier checks may have navigated the page away.
  await provider.click(session, { selector: 'body' })
  await new Promise(resolve => setTimeout(resolve, 400))
  const seen = await provider.execute(session, { script: 'window.__left.join(",")' })
  if (seen.value !== 'mousedown,mouseup,click') throw new Error('the page saw ' + JSON.stringify(seen.value))
  return seen.value
})
await check('right-click reaches the page context menu', async () => {
  await provider.execute(session, { script: `(() => {
    window.__ctx = []
    document.addEventListener('contextmenu', event => window.__ctx.push('button:' + String(event.button)), { once: true })
    return 'armed'
  })()` })
  await provider.click(session, { selector: 'body', button: 'right' })
  await new Promise(resolve => setTimeout(resolve, 400))
  const seen = await provider.execute(session, { script: 'window.__ctx.join(",")' })
  // Returning "" used to pass silently, which hid the fact that no event arrived.
  if (seen.value !== 'button:2') throw new Error('the page saw ' + JSON.stringify(seen.value) + ' instead of a right-click')
  return seen.value
})
await check('modifiers reach the page', async () => {
  await provider.execute(session, { script: `(() => {
    window.__mods = []
    document.addEventListener('mousedown', event => window.__mods.push(String(event.shiftKey) + '/' + String(event.ctrlKey)), { once: true })
    return 'armed'
  })()` })
  await provider.click(session, { selector: 'body', modifiers: ['shift', 'ctrl'] })
  await new Promise(resolve => setTimeout(resolve, 400))
  const seen = await provider.execute(session, { script: 'window.__mods.join(",")' })
  if (seen.value !== 'true/true') throw new Error('the page saw ' + JSON.stringify(seen.value) + ' instead of a modified press')
  return seen.value
})
await check('drag reaches the page', async () => {
  await provider.execute(session, { script: `(() => {
    document.getElementById('__drag_probe')?.remove()
    const el = document.createElement('div')
    el.id = '__drag_probe'
    el.style.cssText = 'position:fixed;left:100px;top:100px;width:120px;height:60px;background:#39f;z-index:2147483647'
    document.body.appendChild(el)
    window.__drag = []
    el.addEventListener('mousedown', event => window.__drag.push('down@' + Math.round(event.clientX) + ',' + Math.round(event.clientY)), true)
    // On document, not on el: the gesture leaves the source almost immediately,
    // so an element-scoped listener would only ever see the first move.
    document.addEventListener('mousemove', event => window.__drag.push('move@' + Math.round(event.clientX)), true)
    document.addEventListener('mouseup', event => window.__drag.push('up@' + Math.round(event.clientX) + ',' + Math.round(event.clientY)), true)
    return 'armed'
  })()` })
  const result = await provider.drag(session, { from: { selector: '#__drag_probe' }, to: { x: 600, y: 400 }, steps: 6 })
  await new Promise(resolve => setTimeout(resolve, 300))
  const seen = await provider.execute(session, { script: 'window.__drag.join(" ")' })
  await provider.execute(session, { script: "document.getElementById('__drag_probe')?.remove()" })
  const log = String(seen.value ?? '')
  const moves = log.split(' ').filter(entry => entry.startsWith('move@')).length
  // The log opens with the pre-press hover, so the press is not necessarily first.
  if (!log.includes('down@160,130')) throw new Error('no press on the source: ' + JSON.stringify(log))
  if (!log.endsWith('up@600,400')) throw new Error('no release on the destination: ' + JSON.stringify(log))
  if (moves < 5) throw new Error('only ' + String(moves) + ' moves, so the gesture jumped: ' + JSON.stringify(log))
  return { moves, result: result.from.target + ' -> ' + String(result.to.x) + ',' + String(result.to.y) }
})
await check('keyboard input reaches the page', async () => {
  // Same gate as a mouse press: Chromium drops synthesized keys while the
  // renderer believes it is unfocused, so this was silently empty too.
  await provider.execute(session, { script: `(() => {
    window.__keys = []
    document.addEventListener('keydown', event => window.__keys.push(event.key), true)
    return 'armed'
  })()` })
  await provider.pressKey(session, { key: 'Enter' })
  await new Promise(resolve => setTimeout(resolve, 300))
  const seen = await provider.execute(session, { script: 'window.__keys.join(",")' })
  if (seen.value !== 'Enter') throw new Error('the page saw ' + JSON.stringify(seen.value))
  return seen.value
})
await check('typing lands in a focused field', async () => {
  await provider.execute(session, { script: `(() => {
    document.getElementById('__type_probe')?.remove()
    const input = document.createElement('input')
    input.id = '__type_probe'
    input.style.cssText = 'position:fixed;left:40px;top:40px;width:200px;height:30px;z-index:2147483647'
    document.body.appendChild(input)
    input.focus()
    return 'armed'
  })()` })
  await provider.type(session, { text: 'hello' })
  await new Promise(resolve => setTimeout(resolve, 300))
  const seen = await provider.execute(session, { script: "String((document.getElementById('__type_probe') || {}).value)" })
  await provider.execute(session, { script: "document.getElementById('__type_probe')?.remove()" })
  if (seen.value !== 'hello') throw new Error('the field holds ' + JSON.stringify(seen.value))
  return seen.value
})
await check('click_ref reaches the page', async () => {
  // The documented primary way to interact, and it had never been asserted to
  // actually deliver anything -- only that it returned.
  await provider.execute(session, { script: `(() => {
    document.getElementById('__ref_probe')?.remove()
    const button = document.createElement('button')
    button.id = '__ref_probe'
    button.textContent = 'Ref Probe'
    button.style.cssText = 'position:fixed;left:60px;top:60px;width:140px;height:40px;z-index:2147483647'
    document.body.appendChild(button)
    window.__ref = []
    button.addEventListener('mousedown', () => window.__ref.push('mousedown'), true)
    button.addEventListener('click', () => window.__ref.push('click'), true)
    return 'armed'
  })()` })
  const snap = await provider.snapshot(session)
  const target = snap.elements.find(element => element.label === 'Ref Probe')
  if (target === undefined) throw new Error('the snapshot did not list the probe button')
  await provider.clickRef(session, { snapshotId: snap.snapshotId, ref: target.ref })
  await new Promise(resolve => setTimeout(resolve, 400))
  const seen = await provider.execute(session, { script: 'window.__ref.join(",")' })
  await provider.execute(session, { script: "document.getElementById('__ref_probe')?.remove()" })
  if (seen.value !== 'mousedown,click') throw new Error('the page saw ' + JSON.stringify(seen.value))
  return seen.value
})
await check('double-click reaches the page', async () => {
  await provider.execute(session, { script: `(() => {
    window.__dbl = []
    document.addEventListener('dblclick', () => window.__dbl.push('dblclick'), true)
    return 'armed'
  })()` })
  await provider.doubleClick(session, { selector: 'body' })
  await new Promise(resolve => setTimeout(resolve, 400))
  const seen = await provider.execute(session, { script: 'window.__dbl.join(",")' })
  if (seen.value !== 'dblclick') throw new Error('the page saw ' + JSON.stringify(seen.value))
  return seen.value
})
await check('scroll moves the page', async () => {
  // The current page may be shorter than the viewport, in which case a correct
  // scroll has nowhere to go -- give it something to scroll first.
  await provider.execute(session, { script: `(() => {
    document.getElementById('__tall')?.remove()
    const spacer = document.createElement('div')
    spacer.id = '__tall'
    spacer.style.cssText = 'height:3000px;width:10px'
    document.body.appendChild(spacer)
    window.scrollTo(0, 0)
    return 'armed'
  })()` })
  const before = await provider.execute(session, { script: 'Math.round(window.scrollY)' })
  await provider.scroll(session, { deltaY: 300 })
  await new Promise(resolve => setTimeout(resolve, 300))
  const after = await provider.execute(session, { script: 'Math.round(window.scrollY)' })
  await provider.execute(session, { script: "document.getElementById('__tall')?.remove()" })
  if (Number(after.value) <= Number(before.value)) throw new Error('scrollY went ' + String(before.value) + ' -> ' + String(after.value))
  return String(before.value) + ' -> ' + String(after.value)
})
await check('fill sets a select', async () => {
  await provider.execute(session, { script: `(() => {
    document.getElementById('__sel')?.remove()
    const select = document.createElement('select')
    select.id = '__sel'
    select.style.cssText = 'position:fixed;left:60px;top:120px;z-index:2147483647'
    for (const value of ['a', 'b', 'c']) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = value
      select.appendChild(option)
    }
    document.body.appendChild(select)
    return 'armed'
  })()` })
  await provider.fillForm(session, { fields: [{ selector: '#__sel', kind: 'select', value: 'b' }] })
  await new Promise(resolve => setTimeout(resolve, 200))
  const seen = await provider.execute(session, { script: "String((document.getElementById('__sel') || {}).value)" })
  await provider.execute(session, { script: "document.getElementById('__sel')?.remove()" })
  if (seen.value !== 'b') throw new Error('the select holds ' + JSON.stringify(seen.value))
  return seen.value
})
await check('a browser-shaped cookie export imports', async () => {
  // What Cookie-Editor / EditThisCookie write: domain + path, no url. This is
  // the workflow the feature exists for, and it used to be rejected wholesale.
  const file = join(outDir, 'editor-export.json')
  writeFileSync(file, JSON.stringify([
    { domain: 'httpbin.org', name: 'dsh_editor', value: 'yes', path: '/', secure: true, httpOnly: false, sameSite: 'no_restriction' },
  ]))
  const imported = await provider.importAuth(session, file)
  const present = (await provider.flushAuth(session)).filter(cookie => cookie.name === 'dsh_editor').length
  await provider.clearAuth(session, { name: 'dsh_editor' })
  if (imported.restored !== 1) throw new Error('restored ' + String(imported.restored) + ', failed ' + String(imported.failed))
  if (present !== 1) throw new Error('the cookie is not in the session afterwards')
  return { restored: imported.restored, present }
})
// --- the tool layer, over the same real provider -------------------------
// The unit suite drives the tools against a fake browser, and the checks above
// drive the provider directly. This is the only place the two meet: tool schema
// -> tool layer -> provider -> RPC -> host-main -> CDP -> Chromium.
const definitions = new Map()
const toolCtx = {
  systemPrompt: { section() {} },
  tools: { register(definition) { definitions.set(definition.name, definition) }, schemas: () => [] },
  get(name) { return name === 'browser' ? provider : undefined },
}
apply(toolCtx)
/**
 * DSH validates a tool's return value against its declared output schema, so a
 * field the schema does not mention fails at runtime — but only inside DSH.
 * Calling execute() directly skips that, so check the shape here instead.
 */
const assertShape = (name, value) => {
  const schema = definitions.get(name).output.schema
  const properties = schema.properties ?? {}
  const undeclared = Object.keys(value ?? {}).filter(key => !(key in properties))
  if (undeclared.length > 0) throw new Error(name + ' returned undeclared fields: ' + undeclared.join(', '))
  const missing = Object.entries(properties)
    .filter(([key, spec]) => spec?.required === true && !(key in (value ?? {})))
    .map(([key]) => key)
  if (missing.length > 0) throw new Error(name + ' omitted required fields: ' + missing.join(', '))
  return value
}
const call = async (name, args, exec) => assertShape(name, await definitions.get(name).execute(args, exec))
const toolTask = { agent: { id: 'smoke-tool-task' } }

await check('tool browser_open', async () => {
  const opened = await call('browser_open', { url: 'https://example.com/' }, toolTask)
  return opened.url ?? opened.title ?? 'opened'
})
await check('tool browser_content', async () => {
  const content = await call('browser_content', { format: 'txt', maxChars: 200 }, toolTask)
  return content.content.slice(0, 40)
})
await check('tool browser_click by text', async () => {
  const clicked = await call('browser_click', { text: 'Learn more' }, toolTask)
  return clicked.target ?? clicked.clicked
})
await check('tool browser_snapshot', async () => {
  const snap = await call('browser_snapshot', {}, toolTask)
  return (snap.elements ?? []).length
})
await check('tool browser_scrape start+status', async () => {
  const out = join(outDir, 'tool-rows.jsonl')
  const started = await call('browser_scrape', {
    action: 'start', urls: ['https://example.com/'], script: 'document.title', outPath: out, concurrency: 1,
  }, toolTask)
  for (let i = 0; i < 60; i += 1) {
    const status = await call('browser_scrape', { action: 'status', id: started.id }, toolTask)
    if (status.state !== 'running') return { state: status.state, done: status.done }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return 'timed out'
})
await check('tool browser_auth file import', async () => {
  const exported = await provider.flushAuth(session)
  const file = join(outDir, 'tool-cookies.json')
  writeFileSync(file, JSON.stringify({ cookies: exported }))
  const imported = await call('browser_auth', { action: 'restore', file }, toolTask)
  return { restored: imported.restored, failed: imported.failed }
})

// --- two tasks at once --------------------------------------------------
// Per-task queues are what make this safe; a single shared queue would make the
// second task wait for the first. The scrape on A is deliberately long.
const taskA = { agent: { id: 'smoke-parallel-a' } }
const taskB = { agent: { id: 'smoke-parallel-b' } }
await check('two tasks do not block each other', async () => {
  await call('browser_open', { url: 'https://example.com/' }, taskA)
  await call('browser_open', { url: 'https://example.com/' }, taskB)
  const scrapeOut = join(outDir, 'parallel-a.jsonl')
  const started = await call('browser_scrape', {
    action: 'start', outPath: scrapeOut, concurrency: 2, timeoutMs: 20_000,
    urls: Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? 'https://example.com/' : 'https://www.iana.org/help/example-domains')),
    script: 'document.title',
  }, taskA)
  // B is busy with a long batch; A must still answer promptly.
  const began = Date.now()
  const snapB = await call('browser_snapshot', {}, taskB)
  const bMs = Date.now() - began
  const stillRunning = (await call('browser_scrape', { action: 'status', id: started.id }, taskA)).state === 'running'
  for (let i = 0; i < 90; i += 1) {
    if ((await call('browser_scrape', { action: 'status', id: started.id }, taskA)).state !== 'running') break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return { bAnsweredInMs: bMs, bElements: (snapB.elements ?? []).length, aWasStillBusy: stillRunning }
})
await check('each task kept its own session', async () => {
  const a = await call('browser_session', {}, taskA)
  const b = await call('browser_session', {}, taskB)
  return { sameSession: a.session === b.session, aTabs: a.tabs?.length, bTabs: b.tabs?.length }
})

// --- a wider concurrent scrape ------------------------------------------
await check('100 urls at concurrency 8', async () => {
  const out = join(outDir, 'wide.jsonl')
  const urls = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 'https://example.com/' : 'https://www.iana.org/help/example-domains'))
  const began = Date.now()
  const started = await provider.startScrape(session, { urls, script: 'document.title', outPath: out, concurrency: 8, timeoutMs: 30_000 })
  for (let i = 0; i < 600; i += 1) {
    const status = await provider.scrapeStatus(started.id)
    if (status.state !== 'running') {
      const rows = readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      return { rows: rows.length, distinctSeqs: new Set(rows.map(r => r.seq)).size,
               failed: rows.filter(r => r.ok !== true).length, seconds: Math.round((Date.now() - began) / 100) / 10,
               tabsLeft: (await provider.listTabs(session)).length }
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return 'timed out'
})

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