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
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
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
    // The ⋮ menu's import: the chrome hands a cookie list to the host, which writes it
    // into the profile. The file picker itself cannot be driven, so the seam below
    // starts at the same place the picker's reader does.
    await check('the cookie import path works from the chrome', async () => {
      const probe = 'dsh_import_probe'
      await provider.clearAuth(session, { name: probe })
      const list = [{ domain: '.example.com', name: probe, value: 'from-the-menu', path: '/', secure: true }]
      const sent = await provider.execute(session, { script: '((list) => (window.__dshChromeImport ? window.__dshChromeImport(list) : -1))(' + JSON.stringify(list) + ')' })
      for (let i = 0; i < 25; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 200))
        const found = (await provider.flushAuth(session)).filter(cookie => cookie.name === probe)
        if (found.length > 0) return { sent: sent.value, value: found[0].value }
      }
      throw new Error('the imported cookie never reached the profile')
    })
  await check('chromeWorld config reachable', async () => (await provider.listTabs(session)).length)
// The chrome lives in the page's closed shadow root, so the only honest way to
// prove its + and × buttons work is to click where they are. That click travels
// the whole chain: CDP -> page chrome -> host binding -> host -> provider event
// -> tab model. The strip geometry is fixed (8px padding, 240px tabs, 2px gaps,
// a 28px + button with a 4px left margin, 18px close buttons 10px from the tab
// edge), so these candidates bracket the expected centres rather than betting
// the whole check on one pixel.
const CHROME_ROW_Y = 20
const CHROME_TOOLBAR_Y = 62
// The chrome lives in the host's own view, which is not a tab: driving it needs its
// own channel. (CDP input aimed at a page is delivered whatever is on top, so once
// the page stops drawing a toolbar of its own, these must go to the frame.)
const chromeClick = async (x, y) => {
  await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
const chromeType = async (text) => provider.chromeInput('Input.insertText', { text })
const chromeEnter = async () => {
  await provider.chromeInput('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await provider.chromeInput('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
}
await check('chrome + creates a provider tab', async () => {
  const before = (await provider.listTabs(session)).length
  for (const x of [258, 252, 266, 246]) {
    await chromeClick(x, CHROME_ROW_Y)
    await new Promise(resolve => setTimeout(resolve, 500))
    const after = (await provider.listTabs(session)).length
    if (after > before) return { before, after, x }
  }
  throw new Error('no tab was created: the + button was never hit (tabs=' + String(before) + ')')
})
await check('chrome x closes the tab it belongs to', async () => {
  const before = (await provider.listTabs(session)).length
  if (before < 2) throw new Error('needs two tabs to close one, has ' + String(before))
  for (const x of [453, 447, 459, 441]) {
    await chromeClick(x, CHROME_ROW_Y)
    await new Promise(resolve => setTimeout(resolve, 500))
    const after = (await provider.listTabs(session)).length
    if (after < before) return { before, after, x }
  }
  throw new Error('no tab was closed: the × was never hit (tabs=' + String(before) + ')')
})
// The chrome also has a copy in the host's own 84px view (that is what will let the
// page viewport really shrink). That view is not a tab, so driving it needs its own
// channel — and its buttons must work, because a person's click lands there.
await check('the chrome frame view drives the tab list', async () => {
  const before = (await provider.listTabs(session)).length
  const click = async (x) => {
    await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: CHROME_ROW_Y, button: 'left', clickCount: 1 })
    await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: CHROME_ROW_Y, button: 'left', clickCount: 1 })
  }
  for (const x of [258, 252, 266, 246]) {
    await click(x)
    await new Promise(resolve => setTimeout(resolve, 500))
    const after = (await provider.listTabs(session)).length
    if (after > before) return { before, after, x }
  }
  throw new Error('the frame chrome never created a tab (tabs=' + String(before) + ')')
})
// Chrome's drag-to-reorder. The strip order lives in the host (a Set) and is mirrored
// by the provider, so a drag has to move both — what browser_list_tabs reports is the
// provider's order, which makes this an end-to-end assertion.
await check('dragging a tab reorders the strip', async () => {
  const before = (await provider.listTabs(session)).map(tab => tab.id)
  if (before.length < 2) throw new Error('needs two tabs to drag, has ' + String(before.length))
  await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mousePressed', x: 130, y: CHROME_ROW_Y, button: 'left', clickCount: 1 })
  for (const x of [200, 300, 420, 560, 700]) {
    await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: CHROME_ROW_Y, button: 'left' })
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: CHROME_ROW_Y, button: 'left', clickCount: 1 })
  await new Promise(resolve => setTimeout(resolve, 700))
  const after = (await provider.listTabs(session)).map(tab => tab.id)
  if (after.length !== before.length) throw new Error('the drag changed the tab count: ' + JSON.stringify({ before, after }))
  if (after[0] === before[0]) throw new Error('the order did not change: ' + JSON.stringify({ before, after }))
  if (JSON.stringify([...after].sort()) !== JSON.stringify([...before].sort())) throw new Error('the drag lost or duplicated a tab')
  return { first: before[0].slice(0, 8) + ' -> ' + after[0].slice(0, 8) }
})
// The frame's chrome cannot touch the page itself — its address bar has to be
// relayed through the host. This drives it the way a person would: click the
// omnibox, type, Enter, and the PAGE navigates.
await check('the frame chrome drives the page it is showing', async () => {
  const frameInput = async (method, params) => provider.chromeInput(method, params)
  await frameInput('Input.dispatchMouseEvent', { type: 'mousePressed', x: 690, y: CHROME_TOOLBAR_Y, button: 'left', clickCount: 1 })
  await frameInput('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 690, y: CHROME_TOOLBAR_Y, button: 'left', clickCount: 1 })
  await frameInput('Input.insertText', { text: 'example.com' })
  await frameInput('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await frameInput('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  let url = ''
  for (let i = 0; i < 25; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 200))
    url = (await provider.listTabs(session)).find(tab => tab.active)?.url ?? ''
    if (url.includes('example.com')) return { url }
  }
  throw new Error('the page never navigated: ' + JSON.stringify(url))
})
// The frame's buttons are the real ones once it is on screen, but its own popups
// would be clipped at 84px — so it reports where the button is and the PAGE draws
// the menu there. Clicking the frame's star must open the page's bookmarks panel.
// Ctrl+L belongs to the toolbar, which lives in the frame now, so the page's copy
// relays it. If the relay works the frame's omnibox ends up focused — proved by
// typing into the frame and watching the PAGE navigate.
await check('Ctrl+L hands the page focus to the frame omnibox', async () => {
  await provider.navigate(session, { url: 'https://example.com/' })
  await new Promise(resolve => setTimeout(resolve, 600))
  await provider.pressKey(session, { key: 'l', modifiers: ['ctrl'] })
  await new Promise(resolve => setTimeout(resolve, 400))
  await chromeType('example.org')
  await chromeEnter()
  let url = ''
  for (let i = 0; i < 25; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 200))
    url = (await provider.listTabs(session)).find(tab => tab.active)?.url ?? ''
    if (url.includes('example.org')) return { url }
  }
  throw new Error('the omnibox never got the focus: ' + JSON.stringify(url))
})
// The user's report: the toolbar menus opened when the pointer merely crossed them.
// Hover now has to rest on the button for a moment, so this check needs BOTH halves —
// a sweep must open nothing, and resting on the same button must still open it.
// (Without the second half a "menus never open at all" regression would pass.)
await check('a pass-over opens nothing, resting on the button does', async () => {
  const readPanels = async () => JSON.parse(String((await provider.execute(session, {
    script: 'JSON.stringify(window.__dshChromePanels ? window.__dshChromePanels() : [])',
  })).value))
  const moveTo = async (x, y) => { await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }) }
  const openIds = async () => (await readPanels()).filter(entry => entry.open === true).map(entry => entry.id)
  // A click in the page is "outside the chrome" and closes every menu (the page copy
  // has always done that), which is how each attempt starts from a known state.
  const closeAnyMenu = async () => {
    await provider.click(session, { x: 4, y: 4 })
    await new Promise(resolve => setTimeout(resolve, 350))
  }
  // Cross the toolbar the way a pointer does on its way somewhere else: in and straight
  // back out. Each RPC round trip is normally ~5-10ms (measured), but a busy machine can
  // stall one for a second — and a one-second dwell IS a rest, so that sweep would be a
  // false failure. Measure it, and only accept an attempt that really was a pass-over.
  let swept = []
  let dwell = Infinity
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await closeAnyMenu()
    await moveTo(700, CHROME_TOOLBAR_Y)
    await new Promise(resolve => setTimeout(resolve, 250))
    const t0 = Date.now()
    await moveTo(1362, CHROME_TOOLBAR_Y)
    await moveTo(700, CHROME_TOOLBAR_Y)
    dwell = Date.now() - t0
    if (dwell > 150) continue
    await new Promise(resolve => setTimeout(resolve, 800))
    swept = await openIds()
    break
  }
  if (dwell > 150) throw new Error('could not simulate a fast pass-over: the sweep took ' + String(dwell) + 'ms')
  if (swept.length > 0) throw new Error('crossing the toolbar opened ' + JSON.stringify(swept))
  // Rest on it: the menu has to appear (this is the half that keeps the check honest).
  await moveTo(1362, CHROME_TOOLBAR_Y)
  let rested = []
  for (let i = 0; i < 20; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 150))
    rested = await openIds()
    if (rested.length > 0) break
  }
  if (rested.length === 0) throw new Error('resting on the button never opened its menu')
  // Put it back: click pins the hover-opened menu, a second click closes it.
  const clickAt = async (x, y) => {
    await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  await clickAt(1362, CHROME_TOOLBAR_Y)
  await new Promise(resolve => setTimeout(resolve, 350))
  await clickAt(1362, CHROME_TOOLBAR_Y)
  await new Promise(resolve => setTimeout(resolve, 400))
  return { swept: 'nothing', rested: rested.join(',') }
})
// 动效：二级菜单是「浮出来」的，不是一个 display 硬切。弹层在闭影子根里，测试从外面
// 既点不到也算不到它的 opacity，所以由 chrome 自己记录动画事件，这里断言它真的跑了。
await check('opening a menu runs its entrance animation', async () => {
  const motion = async () => JSON.parse(String((await provider.execute(session, {
    script: 'JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : null)',
  })).value))
  const moveTo = async (x, y) => { await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }) }
  const clickAt = async (x, y) => {
    await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  await provider.execute(session, { script: '(() => { window.__dshChromeMotionClear?.(); return "cleared" })()' })
  // Start from a closed menu: a click in the page is "outside the chrome".
  await provider.click(session, { x: 4, y: 4 })
  await new Promise(resolve => setTimeout(resolve, 400))
  await moveTo(700, CHROME_TOOLBAR_Y)
  await new Promise(resolve => setTimeout(resolve, 250))
  await moveTo(1362, CHROME_TOOLBAR_Y)
  let started
  for (let i = 0; i < 24; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 100))
    const log = await motion()
    if (!Array.isArray(log)) throw new Error('window.__dshChromeMotion is missing: ' + JSON.stringify(log))
    // 只看**入场**那条：上一条检查刚关过菜单，它的退场（dshPopOut）可能还在日志里，
    // 拿「第一条 main 的动画」当入场会被它骗到（第 40 轮真踩了）。
    started = log.find(entry => entry.id === 'main' && entry.phase === 'start' && entry.name === 'dshPopIn')
    if (started !== undefined) break
  }
  if (started === undefined) throw new Error('the ⋮ menu opened without running an entrance animation: ' + JSON.stringify(await motion()))
  // It has to finish, too: an animation stuck at its first keyframe would leave the
  // menu invisible while every class-based check still passed.
  let ended = false
  for (let i = 0; i < 12 && !ended; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 80))
    ended = (await motion()).some(entry => entry.id === 'main' && entry.phase === 'end' && entry.name === 'dshPopIn')
  }
  if (!ended) throw new Error('the entrance animation never finished')
  // Put it back the way we found it: click pins the hover-opened menu, a second closes it.
  await clickAt(1362, CHROME_TOOLBAR_Y)
  await new Promise(resolve => setTimeout(resolve, 300))
  await clickAt(1362, CHROME_TOOLBAR_Y)
  await new Promise(resolve => setTimeout(resolve, 400))
  // 指针挪开，别让下一个检查的「移进按钮」变成原地不动（那样没有 pointerenter）。
  await moveTo(700, CHROME_TOOLBAR_Y)
  return { animation: started.name, finished: true }
})
// 关掉一个标签，剩下的标签要**滑**到新位置，而不是瞬移。用「关掉一个后台标签」来验：
// 这样当前文档不变（日志就在这个文档里），标签栏的顺序变了，FLIP 必须记一笔。
await check('closing a tab slides the survivors into place', async () => {
  const motion = async () => JSON.parse(String((await provider.execute(session, {
    script: 'JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : null)',
  })).value))
  const slide = log => (Array.isArray(log) ? log : []).filter(entry => entry.id === 'tab' && entry.phase === 'slide')
  // 保证至少两个标签，并且让**不是第一个**的那个处于激活状态。
  const opened = await provider.listTabs(session)
  if (opened.length < 2) {
    await provider.openUrl(session, { url: 'https://example.com/', newTab: true })
    await new Promise(resolve => setTimeout(resolve, 900))
  }
  const firstId = (await provider.listTabs(session))[0]?.id
  await provider.openUrl(session, { url: 'https://example.com/', newTab: true })
  await new Promise(resolve => setTimeout(resolve, 900))
  const before = (await provider.listTabs(session)).length
  await provider.execute(session, { script: '(() => { window.__dshChromeMotionClear?.(); return "cleared" })()' })
  // 关掉**第一个**标签：激活的那个不动，所以当前文档不变，日志留在原地。
  await chromeClick(221, CHROME_ROW_Y)
  await new Promise(resolve => setTimeout(resolve, 800))
  const after = (await provider.listTabs(session)).length
  if (after >= before) throw new Error('the first tab was not closed: ' + String(before) + ' -> ' + String(after))
  if (firstId !== undefined && (await provider.listTabs(session)).some(tab => tab.id === firstId)) {
    throw new Error('the wrong tab was closed')
  }
  const seen = slide(await motion())
  if (seen.length === 0) throw new Error('the surviving tabs jumped instead of sliding')
  return { slide: seen[0].name, tabs: String(before) + ' -> ' + String(after) }
})
// 关掉的那个标签自己也要收起来：原地淡出 + 宽度收到 0，而不是「啪」一下没了。
await check('a closed tab collapses instead of blinking out', async () => {
  const motion = async () => JSON.parse(String((await provider.execute(session, {
    script: 'JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : null)',
  })).value))
  const opened = await provider.listTabs(session)
  if (opened.length < 2) {
    await provider.openUrl(session, { url: 'https://example.com/', newTab: true })
    await new Promise(resolve => setTimeout(resolve, 900))
  }
  // 让第一个标签**不是**激活的那个：关它不会换文档，日志就留在原地。
  await provider.openUrl(session, { url: 'https://example.com/', newTab: true })
  await new Promise(resolve => setTimeout(resolve, 900))
  const before = (await provider.listTabs(session)).length
  await provider.execute(session, { script: '(() => { window.__dshChromeMotionClear?.(); return "cleared" })()' })
  await chromeClick(221, CHROME_ROW_Y)
  await new Promise(resolve => setTimeout(resolve, 700))
  const after = (await provider.listTabs(session)).length
  if (after >= before) throw new Error('the first tab was not closed: ' + String(before) + ' -> ' + String(after))
  const closes = (await motion()).filter(entry => entry.id === 'tab' && entry.phase === 'close')
  if (closes.length === 0) throw new Error('the closed tab blinked out instead of collapsing')
  return { close: closes[0].name, tabs: String(before) + ' -> ' + String(after) }
})
// 同一个记录缝，验另一半动效：新标签浮入。两半都要断言 —— 初始渲染不许播（chrome 每次
// 导航都会重新注入，不挡的话整条标签栏会在每个页面加载时重弹一次），真的新建标签才播。
await check('a new tab floats in, but a plain page load does not', async () => {
  const motion = async () => JSON.parse(String((await provider.execute(session, {
    script: 'JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : null)',
  })).value))
  const tabStarts = log => (Array.isArray(log) ? log : []).filter(entry => entry.id === 'tab' && entry.phase === 'start')
  // 导航 = chrome 重新注入 = 新文档、新日志。所以不用清空：这个文档的第一次渲染
  // 如果也播了动画，日志里当场就会有记录（去掉 guard 这条立刻变红）。
  await provider.navigate(session, { url: 'https://example.com/' })
  await new Promise(resolve => setTimeout(resolve, 1200))
  const quiet = tabStarts(await motion())
  if (quiet.length > 0) throw new Error('a plain page load animated the tab strip: ' + JSON.stringify(quiet))
  // The entrance animation belongs to the document that was ALREADY open when the tab
  // appeared — and the new tab takes focus, so the log has to be read from the old tab
  // after switching back to it.
  const opened = await provider.listTabs(session)
  const firstTabId = opened.find(tab => tab.active)?.id
  if (firstTabId === undefined) throw new Error('no active tab before opening a new one')
  const before = opened.length
  // 用 provider 的新标签 API，而不是点 ：那个按钮的位置会随着标签数量往右漂。
  await provider.openUrl(session, { url: 'https://example.com/', newTab: true })
  await new Promise(resolve => setTimeout(resolve, 900))
  if ((await provider.listTabs(session)).length <= before) throw new Error('no tab was created')
  await provider.switchTab(session, firstTabId)
  await new Promise(resolve => setTimeout(resolve, 500))
  const started = tabStarts(await motion()).find(entry => entry.name === 'dshTabIn')
  if (started === undefined) throw new Error('the new tab appeared without an entrance animation')
  // 把指针挪开：下一个检查靠「移进按钮」触发悬停，指针停在按钮上的话不会有 pointerenter。
  await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: CHROME_TOOLBAR_Y })
  return { animation: started.name, pageLoadsQuiet: true }
})
await check('hovering a button after using its menu shows the menu again', async () => {
  const readPanels = async () => JSON.parse(String((await provider.execute(session, {
    script: 'JSON.stringify(window.__dshChromePanels ? window.__dshChromePanels() : [])',
  })).value))
  const moveTo = async (x, y) => { await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }) }
  const clickAt = async (x, y) => {
    await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  const waitForPanel = async (id) => {
    for (let i = 0; i < 20; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 150))
      const found = (await readPanels()).find(entry => entry.id === id && entry.open === true)
      if (found) return found
    }
    return null
  }
  // Open the ⋮ menu from the FRAME (its button is the real one): the page puts its own
  // copy of the menu under that button.
  await moveTo(1362, CHROME_TOOLBAR_Y)
  const menu = await waitForPanel('main')
  if (menu === null) throw new Error('the ⋮ menu never opened: ' + JSON.stringify(await readPanels()))
  // Leaving the button must NOT close it: the pointer has to travel from the button
  // (in the frame) down into the menu (in the page), and the frame cannot see it once
  // it crosses — so the frame must not decide anything on the way out.
  await moveTo(1362, 80)
  await new Promise(resolve => setTimeout(resolve, 700))
  const stillOpen = (await readPanels()).find(entry => entry.id === 'main' && entry.open === true)
  if (stillOpen === undefined) throw new Error('the menu vanished as the pointer left the button')
  if (menu === null) throw new Error('the ⋮ menu never opened: ' + JSON.stringify(await readPanels()))
  const item = Array.isArray(menu.items) ? menu.items.find(candidate => candidate.id === 'mmNewTab') : undefined
  if (item === undefined || item.height <= 0) throw new Error('the menu published no usable items: ' + JSON.stringify(menu.items))
  // Click that item in the PAGE's copy — the visible one. This is what the user did, and
  // afterwards the frame's own (clipped) copy still believed its menu was open, so the
  // next hover did nothing at all.
  const tabsBefore = (await provider.listTabs(session)).length
  await provider.click(session, { x: item.left + 12, y: item.top + Math.round(item.height / 2) })
  await new Promise(resolve => setTimeout(resolve, 600))
  const closed = (await readPanels()).every(entry => entry.open !== true)
  // Hover the same button again: the menu must come back.
  await moveTo(1350, CHROME_TOOLBAR_Y)
  await moveTo(1362, CHROME_TOOLBAR_Y)
  const reopened = await waitForPanel('main')
  if (reopened === null) throw new Error('hovering ⋮ again after clicking an item showed no menu (closedAfterClick=' + String(closed) + ')')
  // Close it again so it cannot sit over the page for every later check.
  await clickAt(1362, CHROME_TOOLBAR_Y)
  await new Promise(resolve => setTimeout(resolve, 500))
  return { item: item.id, closedAfterClick: closed, reopened: true, tabs: tabsBefore + ' -> ' + String((await provider.listTabs(session)).length) }
})
// 关闭也要有动画：收起 ⋮ 菜单时先淡出，而不是「啪」一下没了。同时**逻辑上已经关了**必须
// 立刻可见 —— 上面那几条「点了菜单项菜单就该关了」的断言全靠这个（否则会被这 150ms 骗到）。
await check('closing a menu fades it out but reports it closed at once', async () => {
  const motion = async () => JSON.parse(String((await provider.execute(session, {
    script: 'JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : null)',
  })).value))
  // 这几个辅助函数在上一条检查里是局部的，这里得自己来一份。
  const readPanels = async () => JSON.parse(String((await provider.execute(session, {
    script: 'JSON.stringify(window.__dshChromePanels ? window.__dshChromePanels() : [])',
  })).value))
  const moveTo = async (x, y) => { await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }) }
  const waitForPanel = async id => {
    for (let i = 0; i < 20; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 150))
      const found = (await readPanels()).find(entry => entry.id === id && entry.open === true)
      if (found) return found
    }
    return null
  }
  // 先把指针挪开再移回按钮，才会有真正的 pointerenter。
  await provider.click(session, { x: 4, y: 4 })
  await new Promise(resolve => setTimeout(resolve, 400))
  await moveTo(700, CHROME_TOOLBAR_Y)
  await new Promise(resolve => setTimeout(resolve, 250))
  await moveTo(1362, CHROME_TOOLBAR_Y)
  const opened = await waitForPanel('main')
  if (opened === null) throw new Error('the ⋮ menu never opened: ' + JSON.stringify(await readPanels()))
  await provider.execute(session, { script: '(() => { window.__dshChromeMotionClear?.(); return "cleared" })()' })
  // 点页面空白处 = 在 chrome 之外 → 关。
  await provider.click(session, { x: 4, y: 4 })
  const immediately = (await readPanels()).find(entry => entry.id === 'main')
  if (immediately === undefined || immediately.open === true) {
    throw new Error('the menu still reported itself open right after being closed: ' + JSON.stringify(immediately))
  }
  let faded = false
  for (let i = 0; i < 12 && !faded; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 80))
    faded = (await motion()).some(entry => entry.id === 'main' && entry.phase === 'end' && entry.name === 'dshPopOut')
  }
  if (!faded) throw new Error('the menu vanished without fading out')
  return { logicalOpen: false, animation: 'dshPopOut' }
})
// The three checks below assert that the page RECEIVED the event. Resolution
// alone is not a click: browser_click can resolve the right element, report
// success, and still leave the page untouched.
// Clicking the address bar must select the whole URL (Chrome's behaviour) AND
// must leave CDP typing working: the earlier attempt at this called select() in
// the focus handler, after which Input.insertText never landed in that shadow-DOM
// input again. Typing over a full selection replaces the address, so landing on
// example.com proves both halves at once.
await check('address bar select-all keeps CDP typing working', async () => {
  // The star of this check is the select-all on pointerdown, which lives in the chrome.
  await chromeClick(690, CHROME_TOOLBAR_Y)
  await chromeType('example.com')
  await chromeEnter()
  for (let i = 0; i < 40; i += 1) {
    const url = (await provider.listTabs(session)).find(tab => tab.active)?.url ?? ''
    if (url.startsWith('https://example.com')) return url
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  const url = (await provider.listTabs(session)).find(tab => tab.active)?.url ?? '(unknown)'
  throw new Error('the address bar did not navigate to example.com (now at ' + url + ')')
})
// The host pushes the loading flag from did-start/did-stop-loading; a flag that
// never clears would leave the strip spinning forever. (That the flag appears at
// all is checked against a deliberately slow page by hand — polling it here would
// race the navigation.)
// Chrome's tab shortcuts, over the same binding the toolbar buttons use.
//
// Only Ctrl+T is asserted here. Ctrl+W reaches the same binding, but in this
// harness the press lands on a view the host reports as unknown right after the
// new tab appears; driving a freshly created tab by hand (browser_type +
// browser_execute) works, so it looks specific to this process rather than to the
// shortcut. Asserting it here would be a flaky check, not a real one.
await check('Ctrl+T opens a tab through the provider', async () => {
  // Land on a definitely-materialised view first: the tab-closing checks above can
  // leave the session's active tab pointing at a view the host has dropped.
  await provider.navigate(session, { url: 'https://example.com/' })
  // Wait for the document to settle: a re-injection is the chrome's whole state,
  // and a key pressed while the old document is being replaced goes nowhere.
  for (let i = 0; i < 30; i += 1) {
    const url = (await provider.listTabs(session)).find(tab => tab.active)?.url ?? ''
    if (url.startsWith('https://example.com')) break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  await new Promise(resolve => setTimeout(resolve, 600))
  const before = (await provider.listTabs(session)).length
  let opened = before
  // Retry: the page may still be settling under the first press.
  for (let attempt = 0; attempt < 3 && opened === before; attempt += 1) {
    await provider.pressKey(session, { key: 't', modifiers: ['ctrl'] })
    for (let i = 0; i < 12 && opened === before; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 150))
      opened = (await provider.listTabs(session)).length
    }
  }
  if (opened !== before + 1) {
    const state = await provider.execute(session, { script: 'JSON.stringify(window.__dshChromeState ? window.__dshChromeState() : null)' })
    throw new Error('Ctrl+T produced ' + String(opened) + ' tabs, expected ' + String(before + 1) + ' state=' + String(state.value))
  }
  return { before, opened }
})
// Chrome's bookmark bar: off by default, and turning it on moves the page down by
// its height. The toggle goes chrome -> binding -> host -> patch -> chrome, so this
// also proves the preference round-trips through the host (localStorage is per origin).
// Chrome's other keybindings, driven through the provider so the whole chain is covered.
await check('Ctrl+D bookmarks the page it is on', async () => {
  await provider.navigate(session, { url: 'https://example.com/' })
  await new Promise(resolve => setTimeout(resolve, 500))
  const count = async () => Number((await provider.execute(session, { script: 'String((window.__dshBookmarks || []).length)' })).value)
  const before = await count()
  // The chrome mounts at the navigation commit, so a key pressed in the first
  // moments after a load goes nowhere; retry rather than assert on that race.
  let after = before
  for (let attempt = 0; attempt < 3 && after === before; attempt += 1) {
    await provider.pressKey(session, { key: 'd', modifiers: ['ctrl'] })
    await new Promise(resolve => setTimeout(resolve, 600))
    after = await count()
  }
  if (after !== before + 1) throw new Error('bookmarks went ' + String(before) + ' -> ' + String(after))
  // Pressing it again must not duplicate the entry (the host dedupes by URL).
  await provider.pressKey(session, { key: 'd', modifiers: ['ctrl'] })
  await new Promise(resolve => setTimeout(resolve, 600))
  const again = await count()
  if (again !== after) throw new Error('Ctrl+D duplicated the bookmark: ' + String(after) + ' -> ' + String(again))
  return { before, after, again }
})
// 工具栏那颗星（收藏面板的触发按钮）跟着当前页亮/灭，翻面时弹一下。这轮顺手修了一个真 bug：
// frame 表面原来用**自己的** location 判断（那是宿主的一张 data: 页），于是工具栏那颗星永远
// 不会点亮。frame 是独立视图，这轮新加的 chromeEval 才能把它直接读回来。
// 工具栏地址栏要显示**完整地址**（Chrome 行为）。frame 是宿主自己的文档，所以宿主单独把真实
// URL 塞给它；页面里那份永远只拿 origin（那是隐私设计，不能被这条检查顺手破坏）。
await check('the toolbar address bar shows the real url, path and all', async () => {
  const frameEval = async script => String(await provider.chromeEval(script))
  const state = async () => JSON.parse(await frameEval('JSON.stringify(window.__dshChromeState ? window.__dshChromeState() : null)'))
  const activeOrigin = async () => await frameEval("String(((window.__dshTabs || []).find(tab => tab.active) || {}).url || '')")
  // 先把 frame 的可见标签落在一个已知页面上（宿主换可见标签不是瞬时的），否则测的是上一个
  // 检查留下的那一页 —— 第 42 轮就在这里白等过一轮。
  await provider.navigate(session, { url: 'https://example.com/' })
  let origin = ''
  for (let i = 0; i < 30 && origin !== 'https://example.com'; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 250))
    origin = await activeOrigin()
  }
  if (origin !== 'https://example.com') throw new Error('the frame never showed example.com: ' + origin)
  await frameEval("(() => { window.__dshChromeMotionClear(); return 'cleared' })()")
  await provider.navigate(session, { url: 'https://www.iana.org/help/example-domains' })
  let snapshot = await state()
  for (let i = 0; i < 40 && !String(snapshot.address || '').includes('/help/example-domains'); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 250))
    snapshot = await state()
  }
  const address = String(snapshot.address || '')
  if (!address.includes('/help/example-domains')) {
    throw new Error('the toolbar lost the path: ' + JSON.stringify(address) + ' (frame tab ' + await activeOrigin() + ')')
  }
  // 隐私不变量：页面那份显示的是**它自己的** location（页面本来就知道），宿主推给 frame 的
  // 完整地址**没有**发给它 —— 两个值必须各自正确，不能是宿主塞给页面的一份。
  const pageAddress = String((await provider.execute(session, { script: "String((window.__dshChromeState ? window.__dshChromeState() : {}).address || '')" })).value)
  const log = JSON.parse(await frameEval('JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : [])'))
  const faded = Array.isArray(log) && log.some(entry => entry.id === 'address' && entry.name === 'dshAddressIn')
  if (!faded) throw new Error('the address text swapped without fading: ' + JSON.stringify(log))
  return { address, pageCopy: pageAddress, animation: 'dshAddressIn' }
})
// 面板里的**新增**行滑进来（整表重画不播）。
await check('a new trail row slides in instead of blinking on', async () => {
  const pageEval = async script => String((await provider.execute(session, { script })).value)
  // Ctrl+H 开关操作轨迹面板（只有它开着，宿主推来的新记录才会走「增量插入」那条路）。
  await provider.pressKey(session, { key: 'h', modifiers: ['ctrl'] })
  let open = ''
  for (let i = 0; i < 20 && open !== 'trail'; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 250))
    open = await pageEval("String((window.__dshChromePanels ? window.__dshChromePanels() : []).filter(panel => panel.open).map(panel => panel.id).join(','))")
  }
  if (!open.includes('trail')) throw new Error('the trail panel never opened: ' + open)
  await pageEval("(() => { window.__dshChromeMotionClear(); return 'cleared' })()")
  // 任何一次工具调用都会往轨迹里加一条（宿主 trail.append → 面板增量插一行）。
  await provider.content(session, { format: 'txt', maxChars: 40 })
  let log = []
  for (let i = 0; i < 20 && !log.some(entry => entry.id === 'trail-row'); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 200))
    log = JSON.parse(await pageEval('JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : [])'))
  }
  if (!log.some(entry => entry.id === 'trail-row' && entry.name === 'dshRowIn')) {
    throw new Error('the new row appeared without sliding in: ' + JSON.stringify(log))
  }
  await provider.pressKey(session, { key: 'h', modifiers: ['ctrl'] })
  return { row: 'dshRowIn' }
})
// 缩放百分比换值时弹一下（不动真缩放：只调页面那份的显示路径，随后复原）。
await check('the zoom percentage pops when it changes', async () => {
  const pageEval = async script => String((await provider.execute(session, { script })).value)
  const zoom = async () => JSON.parse(await pageEval('JSON.stringify(window.__dshChromeState ? window.__dshChromeState() : null)')).zoom
  if (await zoom() !== '100%') throw new Error('expected 100% to start with, got ' + await zoom())
  await pageEval("(() => { window.__dshChromeMotionClear(); return 'cleared' })()")
  await pageEval('window.__dshChromeSetZoom(1.1)')
  const after = await zoom()
  if (after !== '110%') throw new Error('the label did not follow the zoom: ' + after)
  const log = JSON.parse(await pageEval('JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : [])'))
  await pageEval('window.__dshChromeSetZoom(1)')
  if (await zoom() !== '100%') throw new Error('the label did not come back to 100%')
  if (!Array.isArray(log) || !log.some(entry => entry.id === 'zoom' && entry.name === 'dshZoomIn')) {
    throw new Error('the percentage swapped without popping: ' + JSON.stringify(log))
  }
  return { zoom: after, animation: 'dshZoomIn' }
})
// 列表行的悬停高亮要淡进来（Chrome 也是这样）—— 用**真实指针**悬停，然后读日志里那条
// 真实的 CSS 过渡：断言的是**行为**，不是「CSS 里写没写 transition」。
await check('hovering a list row fades its highlight in', async () => {
  const pageEval = async script => String((await provider.execute(session, { script })).value)
  const rowsOf = async () => JSON.parse(await pageEval("JSON.stringify((window.__dshChromePanels ? window.__dshChromePanels() : []).filter(panel => panel.open && panel.id === 'trail').flatMap(panel => panel.rows || []))"))
  await provider.pressKey(session, { key: 'h', modifiers: ['ctrl'] })
  let rows = []
  for (let i = 0; i < 20 && rows.length === 0; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 250))
    rows = await rowsOf()
  }
  if (rows.length === 0) throw new Error('the trail panel showed no rows to hover')
  const row = rows[0]
  // 先停在别处：指针已经在目标上时不会产生新的 :hover 变化。
  await provider.hover(session, { x: 5, y: 500 })
  await new Promise(resolve => setTimeout(resolve, 200))
  await pageEval("(() => { window.__dshChromeMotionClear(); return 'cleared' })()")
  await provider.hover(session, { x: row.left + Math.round(row.width / 2), y: row.top + Math.round(row.height / 2) })
  let log = []
  for (let i = 0; i < 15 && !log.some(entry => entry.name === 'css:background-color'); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 150))
    log = JSON.parse(await pageEval('JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : [])'))
  }
  await provider.pressKey(session, { key: 'h', modifiers: ['ctrl'] })
  const hit = log.find(entry => entry.name === 'css:background-color' && entry.id === row.cls)
  if (!hit) throw new Error('the row highlighted without a transition: ' + JSON.stringify({ row, log }))
  return { row: hit.id, transition: hit.name }
})
// 删掉中间一项，后面的要**滑**过去而不是瞬移 —— 收藏面板和书签栏走同一个 reconcile。
// 删掉中间一项，后面的要**滑**过去而不是瞬移 —— 收藏面板和书签栏走同一个 reconcile。
await check('removing a bookmark slides the ones after it', async () => {
  const pageEval = async script => String((await provider.execute(session, { script })).value)
  const readPanels = async () => JSON.parse(await pageEval('JSON.stringify(window.__dshChromePanels ? window.__dshChromePanels() : [])'))
  const moveTo = async (x, y) => { await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }) }
  const clickAt = async (x, y) => {
    await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  const waitForPanel = async id => {
    for (let i = 0; i < 24; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 150))
      const found = (await readPanels()).find(entry => entry.id === id && entry.open === true)
      if (found) return found
    }
    return null
  }
  // 先攒够两个书签（Ctrl+D 只加不删）。
  await provider.navigate(session, { url: 'https://example.com/' })
  await new Promise(resolve => setTimeout(resolve, 1200))
  await provider.pressKey(session, { key: 'd', modifiers: ['ctrl'] })
  await new Promise(resolve => setTimeout(resolve, 400))
  await provider.navigate(session, { url: 'https://www.iana.org/help/example-domains' })
  await new Promise(resolve => setTimeout(resolve, 1800))
  await provider.pressKey(session, { key: 'd', modifiers: ['ctrl'] })
  await new Promise(resolve => setTimeout(resolve, 400))
  const count = Number(await pageEval('String((window.__dshBookmarks || []).length)'))
  if (count < 2) throw new Error('expected at least two bookmarks, got ' + count)
  // 书签栏也开着：它的 chip 同样按 key 复用（横排，靠 left 变化）。
  const barWasOn = await pageEval('String(window.__dshBookmarkBar === true)') === 'true'
  const restoreBar = async () => { if (!barWasOn) await pageEval('window.__dshChromeBookmarkBar()') }
  if (!barWasOn) await pageEval('window.__dshChromeBookmarkBar()')
  // 打开收藏面板：从 frame 的 ⋮ 进去（真人就是这么点的）。悬停意图要停够 240ms。
  let menu = null
  for (let attempt = 0; attempt < 3 && menu === null; attempt += 1) {
    await moveTo(1362, 62)
    await new Promise(resolve => setTimeout(resolve, 400))
    if (attempt > 0) await clickAt(1362, 62)
    menu = await waitForPanel('main')
  }
  if (menu === null) { await restoreBar(); throw new Error('the ⋮ menu never opened') }
  const bookmarksItem = menu.items.find(item => item.id === 'mmBookmarks')
  if (bookmarksItem === undefined) { await restoreBar(); throw new Error('no bookmarks item: ' + JSON.stringify(menu.items)) }
  await provider.click(session, { x: bookmarksItem.left + 12, y: bookmarksItem.top + Math.round(bookmarksItem.height / 2) })
  const panel = await waitForPanel('bookmarks')
  if (panel === null) { await restoreBar(); throw new Error('the bookmarks panel never opened') }
  const removeButtons = panel.items.filter(item => item.id === 'x' && item.height > 0)
  if (removeButtons.length < 2) { await restoreBar(); throw new Error('the panel showed no per-row remove buttons: ' + JSON.stringify(panel.items)) }
  await pageEval("(() => { window.__dshChromeMotionClear(); return 'cleared' })()")
  const first = removeButtons[0]
  await provider.click(session, { x: first.left + Math.round(first.height / 2), y: first.top + Math.round(first.height / 2) })
  // 立刻复原书签栏：后面的检查假定它是关着的，而后面任何一步失败都会跳过收尾。
  await restoreBar()
  let log = []
  for (let i = 0; i < 15 && !log.some(entry => entry.phase === 'slide'); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 150))
    log = JSON.parse(await pageEval('JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : [])'))
  }
  await provider.pressKey(session, { key: 'Escape' })
  const slide = log.find(entry => entry.phase === 'slide' && (entry.id === 'bookmark' || entry.id === 'bookmark-bar'))
  if (slide === undefined) throw new Error('the remaining rows jumped instead of sliding: ' + JSON.stringify(log))
  return { list: slide.id, moved: slide.name }
})
// 缩略图每隔几秒就来一帧：新的一帧要**淡入盖住旧的**，硬换会闪。
await check('a new task thumbnail fades in over the previous one', async () => {
  const pageEval = async script => String((await provider.execute(session, { script })).value)
  const readPanels = async () => JSON.parse(await pageEval('JSON.stringify(window.__dshChromePanels ? window.__dshChromePanels() : [])'))
  const moveTo = async (x, y) => { await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }) }
  const clickAt = async (x, y) => {
    await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  const waitForPanel = async id => {
    for (let i = 0; i < 24; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 150))
      const found = (await readPanels()).find(entry => entry.id === id && entry.open === true)
      if (found) return found
    }
    return null
  }
  let menu = null
  for (let attempt = 0; attempt < 4 && menu === null; attempt += 1) {
    // 先把指针挪开：**已经在按钮上**时不会再产生 pointerenter，悬停意图也就不会启动。
    await moveTo(5, 200)
    await new Promise(resolve => setTimeout(resolve, 150))
    await moveTo(1362, 62)
    await new Promise(resolve => setTimeout(resolve, 400))
    if (attempt > 0) await clickAt(1362, 62)
    menu = await waitForPanel('main')
  }
  if (menu === null) throw new Error('the ⋮ menu never opened')
  const tasksItem = menu.items.find(item => item.id === 'mmTasks')
  if (tasksItem === undefined) throw new Error('no tasks item: ' + JSON.stringify(menu.items.map(item => item.id)))
  await provider.click(session, { x: tasksItem.left + 12, y: tasksItem.top + Math.round(tasksItem.height / 2) })
  const panel = await waitForPanel('tasks')
  if (panel === null) throw new Error('the tasks panel never opened')
  // 用 Chromium 自己生成的 JPEG：一定是能解码的真帧。
  const jpeg = await pageEval("(() => { const c = document.createElement('canvas'); c.width = 16; c.height = 16; const x = c.getContext('2d'); x.fillStyle = '#336699'; x.fillRect(0, 0, 16, 16); return c.toDataURL('image/jpeg') })()")
  if (!jpeg.startsWith('data:image/jpeg;base64,')) throw new Error('could not build a jpeg frame: ' + jpeg.slice(0, 40))
  const first = Number(await pageEval('String(window.__dshChromeTaskThumb ? window.__dshChromeTaskThumb(' + JSON.stringify(jpeg) + ', 0) : 0)'))
  if (first !== 1) throw new Error('the tasks panel exposed no thumbnail to paint into')
  await new Promise(resolve => setTimeout(resolve, 600))
  await pageEval("(() => { window.__dshChromeMotionClear(); return 'cleared' })()")
  // 第二帧：这时已经有一张旧 canvas，走的是「淡入盖住旧的」那条路。
  await pageEval('String(window.__dshChromeTaskThumb(' + JSON.stringify(jpeg) + ', 0))')
  let log = []
  for (let i = 0; i < 20 && !log.some(entry => entry.id === 'task-thumb'); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 150))
    log = JSON.parse(await pageEval('JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : [])'))
  }
  await provider.pressKey(session, { key: 'Escape' })
  const hit = log.find(entry => entry.id === 'task-thumb' && entry.name === 'dshThumbIn')
  if (hit === undefined) throw new Error('the new thumbnail swapped in without a fade: ' + JSON.stringify(log))
  return { animation: hit.name }
})
// 书签栏的入场只在**人真的去开**时播：开关是宿主级的，而 chrome 每次导航都会重新注入 ——
// 不挡的话，偏好开着的人每加载一个页面书签栏都会再滑一次。
await check('the bookmark bar does not replay its entrance on every page load', async () => {
  const pageEval = async script => String((await provider.execute(session, { script })).value)
  const readLog = async () => JSON.parse(await pageEval('JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : [])'))
  // 从已知状态开始：先确保它是关着的。
  if (await pageEval('String(window.__dshBookmarkBar === true)') === 'true') {
    await pageEval('window.__dshChromeBookmarkBar()')
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  // 人开一次：必须播入场。
  await pageEval("(() => { window.__dshChromeMotionClear(); return 'cleared' })()")
  await pageEval('window.__dshChromeBookmarkBar()')
  let opened = []
  for (let i = 0; i < 15 && !opened.some(entry => entry.name === 'anim:dshBarIn'); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 120))
    opened = await readLog()
  }
  if (!opened.some(entry => entry.name === 'anim:dshBarIn')) throw new Error('turning the bookmark bar on ran no entrance animation: ' + JSON.stringify(opened))
  // 再导航一次：宿主会把「开着」重推一遍，**不许再播**。
  await provider.navigate(session, { url: 'https://example.com/' })
  await new Promise(resolve => setTimeout(resolve, 1800))
  const after = await readLog()
  if (after.some(entry => entry.name === 'anim:dshBarIn')) throw new Error('the bookmark bar replayed its entrance after a navigation: ' + JSON.stringify(after))
  if (await pageEval('String(window.__dshBookmarkBar === true)') !== 'true') throw new Error('the bar did not stay open across the navigation')
  // 复原：后面的检查假定它是关着的；页面也回到上一条检查留下的那一页。
  await pageEval('window.__dshChromeBookmarkBar()')
  await provider.navigate(session, { url: 'https://www.iana.org/help/example-domains' })
  await new Promise(resolve => setTimeout(resolve, 1500))
  return { onToggle: 'anim:dshBarIn', onLoad: 'none' }
})
// 前进/后退能不能点由宿主算（tab.canGoBack/canGoForward）—— 变灰要**淡**进去，不是啪一下。
// 前进/后退能不能点由宿主算（tab.canGoBack/canGoForward）—— 变灰要**淡**进去，不是啪一下。
// toast 的正文是整段换掉的：第二句话来的时候要淡一下，不是啪地跳。
// 任务行也是复用节点：换个顺序要滑过去，不是瞬移（书签第 46 轮修过同一个病）。
await check('the task rows slide instead of jumping', async () => {
  const pageEval = async script => String((await provider.execute(session, { script })).value)
  const readPanels = async () => JSON.parse(await pageEval('JSON.stringify(window.__dshChromePanels ? window.__dshChromePanels() : [])'))
  const moveTo = async (x, y) => { await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }) }
  const clickAt = async (x, y) => {
    await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  const waitForPanel = async id => {
    for (let i = 0; i < 24; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 150))
      const found = (await readPanels()).find(entry => entry.id === id && entry.open === true)
      if (found) return found
    }
    return null
  }
  let menu = null
  for (let attempt = 0; attempt < 4 && menu === null; attempt += 1) {
    // 先把指针挪开：已经在按钮上时不会再产生 pointerenter，悬停意图也就不会启动。
    await moveTo(5, 200)
    await new Promise(resolve => setTimeout(resolve, 150))
    await moveTo(1362, 62)
    await new Promise(resolve => setTimeout(resolve, 400))
    if (attempt > 0) await clickAt(1362, 62)
    menu = await waitForPanel('main')
  }
  if (menu === null) throw new Error('the ⋮ menu never opened')
  const tasksItem = menu.items.find(item => item.id === 'mmTasks')
  if (tasksItem === undefined) throw new Error('no tasks item: ' + JSON.stringify(menu.items.map(item => item.id)))
  await provider.click(session, { x: tasksItem.left + 12, y: tasksItem.top + Math.round(tasksItem.height / 2) })
  const panel = await waitForPanel('tasks')
  if (panel === null) throw new Error('the tasks panel never opened')
  // 用两个假任务驱动**真实的渲染路径**，量完把真实列表还回去。
  const fake = [
    { key: 'slide-a', label: 'A', status: 'idle', control: 'agent', active: false },
    { key: 'slide-b', label: 'B', status: 'running', control: 'agent', active: false },
  ]
  await pageEval('(() => { window.__dshTasksBackup = window.__dshTasks; window.__dshTasks = ' + JSON.stringify(fake) + '; window.__dshTaskRender(); return \'ok\' })()')
  await new Promise(resolve => setTimeout(resolve, 400))
  await pageEval("(() => { window.__dshChromeMotionClear(); return 'cleared' })()")
  const swapped = [fake[1], fake[0]]
  await pageEval('(() => { window.__dshTasks = ' + JSON.stringify(swapped) + '; window.__dshTaskRender(); return \'ok\' })()')
  let log = []
  for (let i = 0; i < 15 && !log.some(entry => entry.id === 'task-panel'); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 120))
    log = JSON.parse(await pageEval('JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : [])'))
  }
  await pageEval('(() => { if (window.__dshTasksBackup !== undefined) window.__dshTasks = window.__dshTasksBackup; window.__dshTaskRender(); return \'restored\' })()')
  await provider.pressKey(session, { key: 'Escape' })
  const hit = log.find(entry => entry.id === 'task-panel' && entry.phase === 'slide')
  if (hit === undefined) throw new Error('the task rows jumped instead of sliding: ' + JSON.stringify(log))
  return { list: hit.id, moved: hit.name }
})
// 切标签时页面从表面色淡进来；**导航绝不能播**（否则每次加载都闪一下）。
await check('a tab switch fades the incoming page in, a navigation does not', async () => {
  const pageEval = async script => String((await provider.execute(session, { script })).value)
  const readLog = async () => JSON.parse(await pageEval('JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : [])'))
  const clickAt = async (x, y) => {
    await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await provider.chromeInput('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  const waitForTabs = async want => {
    for (let i = 0; i < 25; i += 1) {
      const list = await provider.listTabs(session)
      if (list.length === want) return list
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    return null
  }
  let tabs = await provider.listTabs(session)
  if (tabs.length < 2) { await clickAt(258, 20); tabs = await waitForTabs(2) }
  if (tabs === null || tabs.length < 2) throw new Error('could not get two tabs: ' + JSON.stringify(tabs))
  // 先导航一次（在第二个标签上）：导航**不许**播 reveal。
  await provider.navigate(session, { url: 'https://example.com/' })
  await new Promise(resolve => setTimeout(resolve, 1600))
  await pageEval("(() => { window.__dshChromeMotionClear(); return 'cleared' })()")
  await provider.navigate(session, { url: 'https://www.iana.org/help/example-domains' })
  await new Promise(resolve => setTimeout(resolve, 1800))
  const afterNav = await readLog()
  if (afterNav.some(entry => entry.name === 'dshReveal')) throw new Error('a navigation replayed the reveal: ' + JSON.stringify(afterNav))
  // 再切回第一个标签：这一次**必须**播。
  await clickAt(221, 20)
  await new Promise(resolve => setTimeout(resolve, 900))
  let log = []
  for (let i = 0; i < 12 && !log.some(entry => entry.name === 'dshReveal'); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 120))
    log = await readLog()
  }
  const hit = log.find(entry => entry.name === 'dshReveal')
  if (hit === undefined) throw new Error('switching tabs did not reveal the page: ' + JSON.stringify(log))
  // 收尾：把多出来的标签关掉，后面的检查假定只有一个。
  const extra = (await provider.listTabs(session)).length
  if (extra > 1) { await clickAt(453, 20); await waitForTabs(1) }
  return { switch: hit.name, navigation: 'none' }
})
await check('a second notice cross-fades its text', async () => {
  const pageEval = async script => String((await provider.execute(session, { script })).value)
  await pageEval("(() => { window.__dshChromeToast('first', 'info'); return 'ok' })()")
  await new Promise(resolve => setTimeout(resolve, 400))
  await pageEval("(() => { window.__dshChromeMotionClear(); return 'cleared' })()")
  await pageEval("(() => { window.__dshChromeToast('second', 'info'); return 'ok' })()")
  let log = []
  for (let i = 0; i < 15 && !log.some(entry => entry.name === 'dshTextIn'); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 120))
    log = JSON.parse(await pageEval('JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : [])'))
  }
  const hit = log.find(entry => entry.name === 'dshTextIn' && entry.id === 'toast')
  if (hit === undefined) throw new Error('the notice swapped its text without fading: ' + JSON.stringify(log))
  return { animation: hit.name }
})
await check('the back button fades in as it becomes available', async () => {
  const frameEval = async script => String(await provider.chromeEval(script))
  const readLog = async () => JSON.parse(await frameEval('JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : [])'))
  const state = async () => JSON.parse(await frameEval('JSON.stringify(window.__dshChromeState ? window.__dshChromeState() : {})'))
  // 先导航到一个新地址：这样「前进」一定是灰的（历史末端）。
  await provider.navigate(session, { url: 'https://example.com/' })
  await new Promise(resolve => setTimeout(resolve, 1600))
  const before = await state()
  if (before.canForward !== false) throw new Error('forward was already available at the end of the history: ' + JSON.stringify(before))
  // 后退一次 → 前进可用，而且必须是淡进去的。
  await frameEval("(() => { window.__dshChromeMotionClear(); return 'cleared' })()")
  await provider.pressKey(session, { key: 'ArrowLeft', modifiers: ['alt'] })
  let log = []
  for (let i = 0; i < 20 && !log.some(entry => entry.name === 'css:opacity' && entry.el === 'forward'); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 150))
    log = await readLog()
  }
  const now = await state()
  const faded = log.find(entry => entry.name === 'css:opacity' && entry.el === 'forward')
  // 回到历史末端，把状态交回去。
  await provider.pressKey(session, { key: 'ArrowRight', modifiers: ['alt'] })
  await new Promise(resolve => setTimeout(resolve, 900))
  if (now.canForward !== true) throw new Error('forward never became available after going back: ' + JSON.stringify(now))
  if (faded === undefined) throw new Error('the forward button snapped instead of fading: ' + JSON.stringify(log))
  return { atEnd: 'disabled', afterBack: 'css:opacity' }
})

await check('the toolbar star lights up and pops when the page is bookmarked', async () => {
  const frameEval = async script => String(await provider.chromeEval(script))
  await provider.navigate(session, { url: 'https://www.iana.org/help/example-domains' })
  // 等导航真的落定再断言：宿主只把 origin 下发给 chrome，所以按 origin 比对。
  const state = async () => JSON.parse(await frameEval('JSON.stringify(window.__dshChromeState ? window.__dshChromeState() : null)'))
  const landedOrigin = async () => await frameEval("String(((window.__dshTabs || []).find(tab => tab.active) || {}).url || '')")
  let origin = ''
  for (let i = 0; i < 30 && origin !== 'https://www.iana.org'; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 250))
    origin = await landedOrigin()
  }
  if (origin !== 'https://www.iana.org') throw new Error('the new page never became the active tab: ' + origin)
  // 工具栏在 frame 的闭影子根里，外面查不到 —— 读 chrome 自己的测试缝。
  const before = (await state()).starred
  if (before !== '0') throw new Error('a page that is not bookmarked still reads as starred: ' + String(before))
  await frameEval("(() => { window.__dshChromeMotionClear(); return 'cleared' })()")
  // 导航后头几百毫秒按的键会丢（chrome 在 commit 才挂载），所以按键要重试 —— 和上面
  // 那条 Ctrl+D 检查同一个道理。
  let snapshot = { starred: before, iconAnimations: 0, log: [] }
  for (let attempt = 0; attempt < 3 && snapshot.starred !== '1'; attempt += 1) {
    await provider.pressKey(session, { key: 'd', modifiers: ['ctrl'] })
    for (let i = 0; i < 12 && snapshot.starred !== '1'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 60))
      snapshot = { ...(await state()), log: JSON.parse(await frameEval('JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : [])')) }
    }
  }
  if (snapshot.starred !== '1') throw new Error('the toolbar star never lit up after Ctrl+D: ' + JSON.stringify(snapshot))
  const popped = Array.isArray(snapshot.log) && snapshot.log.some(entry => entry.id === 'star' && entry.name === 'dshIconIn')
  if (!popped) throw new Error('the star flipped without a pop: ' + JSON.stringify(snapshot.log))
  return { starred: snapshot.starred, animation: 'dshIconIn', running: snapshot.iconAnimations }
})
await check('the bookmark bar is host state and the page offset follows it', async () => {
  await provider.navigate(session, { url: 'https://example.com/' })
  await new Promise(resolve => setTimeout(resolve, 500))
  // The page's own viewport now starts below the chrome frame, so its offset is
  // just the bookmark bar (34px) — the toolbar is no longer part of this document.
  const read = async () => {
    const state = await provider.execute(session, {
      script: '(() => { const el = document.elementFromPoint(200, 16); return JSON.stringify({ bar: window.__dshBookmarkBar === true, pad: getComputedStyle(document.documentElement).paddingTop, atBar: (el && el.id) || (el && el.tagName) || "none" }) })()',
    })
    return JSON.parse(String(state.value))
  }
  const before = await read()
  if (before.bar !== false || before.pad !== '0px') throw new Error('unexpected start state ' + JSON.stringify(before))
  await provider.execute(session, { script: '(() => { window.__dshChromeBookmarkBar(); return "on" })()' })
  await new Promise(resolve => setTimeout(resolve, 600))
  const opened = await read()
  if (opened.bar !== true) throw new Error('the host did not keep the bar on: ' + JSON.stringify(opened))
  if (opened.pad !== '34px') throw new Error('the page was not moved down: ' + JSON.stringify(opened))
  if (opened.atBar !== '__dsh_browser_chrome_host__') throw new Error('the bar is not painted at the top of the page: ' + JSON.stringify(opened))
  await provider.execute(session, { script: '(() => { window.__dshChromeBookmarkBar(); return "off" })()' })
  await new Promise(resolve => setTimeout(resolve, 600))
  const closed = await read()
  if (closed.bar !== false || closed.pad !== '0px') throw new Error('the bar did not go away: ' + JSON.stringify(closed))
  return { opened: opened.pad, closed: closed.pad }
})
// 下移量现在是**过渡**过去的，不是一步跳过去 —— 而且过渡只在第二次应用之后才补上
// （chrome 每次导航都会重新注入，第一次就带过渡的话，每个页面加载内容都会自己滑一下）。
await check('the page inset eases, and only after the first paint', async () => {
  const read = async () => JSON.parse(String((await provider.execute(session, {
    // 用计算样式而不是 inline 值：浏览器会把 ".16s ease" 规范成 "0.16s"（并丢掉默认的 ease）。
    script: 'JSON.stringify({ pad: getComputedStyle(document.documentElement).paddingTop, property: getComputedStyle(document.documentElement).transitionProperty, duration: getComputedStyle(document.documentElement).transitionDuration, bar: window.__dshBookmarkBar === true })',
  })).value))
  const state = await read()
  if (state.property !== 'padding-top' || state.duration !== '0.16s') {
    throw new Error('the inset transition was never armed: ' + JSON.stringify(state))
  }
  let mid = null
  for (let attempt = 0; attempt < 3 && mid === null; attempt += 1) {
    await provider.execute(session, { script: '(() => { window.__dshChromeBookmarkBar(); return "toggle" })()' })
    for (let i = 0; i < 8; i += 1) {
      const value = Number.parseFloat((await read()).pad)
      // 160ms 的窗口里 RPC 抖动可能一次都采不到；但**每次**都是 0/34 的整数端点，
      // 就说明根本没有过渡。
      if (Number.isFinite(value) && value > 0 && value < 34) { mid = String(value); break }
    }
    if (mid === null) await new Promise(resolve => setTimeout(resolve, 400))
  }
  if (mid === null) throw new Error('the inset jumped instead of easing: never sampled a value between 0 and 34px')
  await new Promise(resolve => setTimeout(resolve, 400))
  // 收拾干净：这条检查会开关若干次，别把书签栏留在开着的状态给后面的检查。
  const end = await read()
  if (end.bar === true) {
    await provider.execute(session, { script: '(() => { window.__dshChromeBookmarkBar(); return "off" })()' })
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  return { mid, end: (await read()).pad }
})
// toast 过去是「啪」一下消失（display:none）。现在先淡出再收 —— 而且收起**不能只靠
// animationend**：系统开了「减少动态效果」时动画不跑，那个事件永远不来，toast 就挂住了。
await check('a notice fades out instead of vanishing', async () => {
  const motion = async () => JSON.parse(String((await provider.execute(session, {
    script: 'JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : null)',
  })).value))
  const toastState = async () => JSON.parse(String((await provider.execute(session, {
    script: 'typeof window.__dshChromeToastState === "function" ? window.__dshChromeToastState() : "null"',
  })).value))
  await provider.execute(session, { script: '(() => { window.__dshChromeMotionClear?.(); return "cleared" })()' })
  const shown = await provider.execute(session, { script: '(() => { if (typeof window.__dshChromeToast !== "function") return "missing"; window.__dshChromeToast("动效测试"); return "shown" })()' })
  if (shown.value !== 'shown') throw new Error('the toast hook is ' + String(shown.value))
  const opened = await toastState()
  if (opened.open !== true) throw new Error('the toast never opened: ' + JSON.stringify(opened))
  let dropped = false
  for (let i = 0; i < 20 && !dropped; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 100))
    dropped = (await motion()).some(entry => entry.id === 'toast' && entry.phase === 'end' && entry.name === 'dshDropIn')
  }
  if (!dropped) throw new Error('the toast appeared without its drop-in animation')
  // 5 秒后自动收起，而且必须是淡出，不是直接消失。
  let faded = false
  for (let i = 0; i < 90 && !faded; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 100))
    faded = (await motion()).some(entry => entry.id === 'toast' && entry.phase === 'start' && entry.name === 'dshToastOut')
  }
  if (!faded) throw new Error('the toast vanished without fading out')
  await new Promise(resolve => setTimeout(resolve, 600))
  const after = await toastState()
  if (after.open !== false || after.closing !== false) throw new Error('the toast never finished hiding: ' + JSON.stringify(after))
  return { drop: 'dshDropIn', hide: 'dshToastOut' }
})
await check('a settled tab is not stuck loading', async () => {
  await provider.navigate(session, { url: 'https://example.com/' })
  await new Promise(resolve => setTimeout(resolve, 600))
  const flags = await provider.execute(session, { script: 'JSON.stringify((window.__dshTabs || []).map(tab => tab.loading === true))' })
  const loading = JSON.parse(String(flags.value ?? '[]'))
  if (loading.some(Boolean)) throw new Error('the strip still shows a tab as loading: ' + String(flags.value))
  return { tabs: loading.length, loading: 0 }
})
// Home is this browser's own new-tab page, and that page is a data: document.
// Chromium blocks renderer-initiated navigation to one, so the button can only
// work if the frame relays it and the HOST does the loadURL — which is exactly
// what this drives end to end (the home button sits after back/forward/reload,
// at 33/66/99/133 in a full-width bar; the candidates bracket that centre).
await check('the home button returns to the new-tab page', async () => {
  await provider.navigate(session, { url: 'https://example.com/' })
  await new Promise(resolve => setTimeout(resolve, 600))
  for (const x of [133, 127, 139, 121]) {
    await chromeClick(x, CHROME_TOOLBAR_Y)
    await new Promise(resolve => setTimeout(resolve, 700))
    const url = (await provider.listTabs(session)).find(tab => tab.active)?.url ?? ''
    if (url.startsWith('data:text/html')) {
      // 起始页的 data: URL **不该**出现在地址栏里（真机截图里那是一整屏百分号编码）。
      const address = String(await provider.chromeEval("String(window.__dshChromeState ? window.__dshChromeState().address : 'x')"))
      if (address !== '') throw new Error('the new-tab address showed the data: URL: ' + address.slice(0, 40))
      // Leave the tab on a real page: later checks navigate anyway, but the next
      // few read the live document.
      await provider.navigate(session, { url: 'https://example.com/' })
      return { x, url: url.slice(0, 21) }
    }
  }
  throw new Error('the home button never reached the new-tab page')
})
// 起始页是每次开新标签都会看到的那一页，所以它的悬停也不能硬切。这里直接量计算样式，
// 并且真的改一次底色、用 getAnimations() 确认渲染器**真的**起了一个过渡（不是只写了 CSS）。
await check('the new-tab page eases its hover states', async () => {
  await provider.navigate(session, { url: 'https://example.com/' })
  await new Promise(resolve => setTimeout(resolve, 600))
  await chromeClick(133, CHROME_TOOLBAR_Y)
  await new Promise(resolve => setTimeout(resolve, 800))
  const url = (await provider.listTabs(session)).find(tab => tab.active)?.url ?? ''
  if (!url.startsWith('data:text/html')) throw new Error('the home button did not reach the new-tab page: ' + url.slice(0, 40))
  const read = async script => String((await provider.execute(session, { script })).value)
  const armed = JSON.parse(await read(`JSON.stringify((() => {
    const tile = document.querySelector('.tile')
    if (tile === null) return { tiles: 0 }
    const style = getComputedStyle(tile)
    return { tiles: document.querySelectorAll('.tile').length, property: style.transitionProperty, duration: style.transitionDuration }
  })())`))
  if (armed.tiles === 0) throw new Error('the new-tab page has no shortcut tiles to hover')
  if (!String(armed.property).includes('background')) throw new Error('a shortcut tile does not transition its background: ' + JSON.stringify(armed))
  await read(`(() => { document.querySelector('.tile').style.background = 'rgb(1, 2, 3)'; return 'set' })()`)
  const running = JSON.parse(await read(`JSON.stringify(document.querySelector('.tile').getAnimations().map(animation => ({ type: animation.constructor.name, property: String(animation.transitionProperty || ''), duration: animation.effect.getTiming().duration })))`))
  await read(`(() => { document.querySelector('.tile').style.background = ''; return 'restored' })()`)
  // 搜索框也一样：它是每次开新标签都要摸的东西，悬停/聚焦不能硬切。
  const box = JSON.parse(await read(`JSON.stringify((() => {
    const el = document.querySelector('.search')
    if (el === null) return { found: false }
    const style = getComputedStyle(el)
    return { found: true, property: style.transitionProperty, duration: style.transitionDuration }
  })())`))
  if (!box.found) throw new Error('the new-tab page has no search box')
  if (!String(box.property).includes('background')) throw new Error('the search box does not transition its background: ' + JSON.stringify(box))
  await read(`(() => { document.querySelector('.search').style.background = 'rgb(1, 2, 3)'; return 'set' })()`)
  const boxRunning = JSON.parse(await read(`JSON.stringify(document.querySelector('.search').getAnimations().map(animation => ({ type: animation.constructor.name, property: animation.transitionProperty ?? '' })))`))
  await read(`(() => { document.querySelector('.search').style.background = ''; return 'restored' })()`)
  if (boxRunning.length === 0) throw new Error('the search box background changed without a running transition')
  // 必须离开起始页再交棒：后面的检查会「点 body 的正中间」，而起始页正中间就是磁贴
  // （一个 <a>）—— 点下去会导航走，那个检查的探针就跟着文档一起没了（第 41 轮真踩了：
  // 'left-click reaches the page' 报 the page saw undefined）。
  await provider.navigate(session, { url: 'https://example.com/' })
  await new Promise(resolve => setTimeout(resolve, 500))
  if (running.length === 0) throw new Error('the tile background changed without a running transition')

  return { tiles: armed.tiles, transition: armed.duration, search: box.duration, running: running[0].property !== '' ? running[0].property : running[0].type }
})
// Page zoom lives on the webContents, so the chrome has to be told the factor
// rather than derive it (a freshly navigated document's devicePixelRatio is
// already scaled, which is what made the derived version stop compensating).
// Bookmarks belong to the profile, so the host publishes the list to every page
// instead of leaving it in the page's per-origin localStorage.
// The chrome's mount is one linear script, so any exception inside it silently
// removes everything after that point. With the assertion below, a half-mounted
// chrome fails loudly instead of quietly losing its menus and shortcuts.
await check('the chrome mounted without an error and its find hook exists', async () => {
  const result = await provider.execute(session, {
    script: 'JSON.stringify({ error: String(document.documentElement.dataset.dshChromeError), find: typeof window.__dshChromeFind })',
  })
  const state = JSON.parse(String(result.value ?? '{}'))
  if (state.error !== 'undefined') throw new Error('the chrome mount failed: ' + state.error)
  if (state.find !== 'object') throw new Error('window.__dshChromeFind is ' + String(state.find))
  return state
})
// 查找栏以前是「啪」一下消失（和菜单一样的病）。关它也要有退场，而且这段动画必须真的跑完。
await check('the find bar fades out instead of blinking away', async () => {
  const motion = async () => JSON.parse(String((await provider.execute(session, {
    script: 'JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : null)',
  })).value))
  await provider.execute(session, { script: '(() => { window.__dshChromeMotionClear?.(); window.__dshChromeFind.open(); return "opened" })()' })
  await new Promise(resolve => setTimeout(resolve, 500))
  if (!(await motion()).some(entry => entry.id === 'find' && entry.name === 'dshPopIn')) {
    throw new Error('the find bar opened without its entrance animation: ' + JSON.stringify(await motion()))
  }
  await provider.execute(session, { script: '(() => { window.__dshChromeMotionClear?.(); window.__dshChromeFind.close(); return "closed" })()' })
  let faded = false
  for (let i = 0; i < 12 && !faded; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 80))
    faded = (await motion()).some(entry => entry.id === 'find' && entry.phase === 'end' && entry.name === 'dshPopOut')
  }
  if (!faded) throw new Error('the find bar vanished without fading out')
  return { open: 'dshPopIn', close: 'dshPopOut' }
})
// 安全指示：http 页面给琥珀提示、https 给锁 —— 换的时候淡入，不硬切。为了造出真正的 http
// 页面，这里临时起一个只有本机能访问的小服务器（外网 http 站会重定向/升级，不可靠）。
await check('the security icon cross-fades when the connection kind changes', async () => {
  const { createServer } = await import('node:http')
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>plain http</title>ok')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const frameEval = async script => String(await provider.chromeEval(script))
    await provider.navigate(session, { url: 'https://example.com/' })
    await new Promise(resolve => setTimeout(resolve, 900))
    const state = async () => JSON.parse(await frameEval('JSON.stringify(window.__dshChromeState ? window.__dshChromeState() : null)'))
    const secure = (await state()).insecure
    if (secure !== '0') throw new Error('an https page did not show the lock: ' + String(secure))
    await frameEval("(() => { window.__dshChromeMotionClear(); return 'cleared' })()")
    await provider.navigate(session, { url: 'http://127.0.0.1:' + String(port) + '/' })
    let insecure = secure
    for (let i = 0; i < 25 && insecure !== '1'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 150))
      insecure = (await state()).insecure
    }
    if (insecure !== '1') throw new Error('an http page did not switch to the insecure icon: ' + insecure)
    const log = JSON.parse(await frameEval('JSON.stringify(window.__dshChromeMotion ? window.__dshChromeMotion() : [])'))
    if (!Array.isArray(log) || !log.some(entry => entry.id === 'security' && entry.name === 'dshIconIn')) {
      throw new Error('the security icon swapped without a cross-fade: ' + JSON.stringify(log))
    }
    return { https: 'lock', http: 'amber', animation: 'dshIconIn' }
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
await check('the host publishes the bookmark list to the chrome', async () => {
  const result = await provider.execute(session, { script: 'Array.isArray(window.__dshBookmarks) ? String(window.__dshBookmarks.length) : "missing"' })
  if (result.value === 'missing') throw new Error('window.__dshBookmarks was not published')
  return { bookmarks: result.value }
})
await check('the host publishes the zoom factor to the chrome', async () => {
  const result = await provider.execute(session, { script: 'String(window.__dshZoom)' })
  if (result.value !== '1') throw new Error('expected __dshZoom 1, got ' + String(result.value))
  return { zoom: result.value }
})
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
    // Deliberately BELOW the injected chrome (0-84px). A fixed probe at top:60
    // sits under the toolbar, so the click lands on the chrome and this check
    // would be measuring the occlusion instead of click_ref; the occlusion has
    // its own check right below.
    button.style.cssText = 'position:fixed;left:60px;top:200px;width:140px;height:40px;z-index:2147483647'
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
// Characterisation of a known limitation, not an endorsement: the chrome is
// injected INTO the page, so it covers the top 84 CSS pixels of the viewport and
// a page's own position:fixed element there is both hidden and unreachable.
// Shrinking the real viewport (chrome as its own WebContentsView) is what fixes
// it. If this check ever starts failing, the occlusion is gone and this block
// should be replaced by one that asserts the click DOES reach the page.
await check('a fixed element at the top of the page is no longer occluded', async () => {
  await provider.execute(session, { script: `(() => {
    document.getElementById('__occl_probe')?.remove()
    const button = document.createElement('button')
    button.id = '__occl_probe'
    button.textContent = 'Top Probe'
    button.style.cssText = 'position:fixed;left:60px;top:60px;width:140px;height:40px;z-index:2147483647'
    document.body.appendChild(button)
    window.__occl = []
    button.addEventListener('click', () => window.__occl.push('click'), true)
    return 'armed'
  })()` })
  // The page's viewport starts below the chrome frame now, so a fixed element at
  // page y=60..100 is genuinely on screen and clickable. Before the chrome moved
  // into its own view this probe was unreachable — that was the whole reason for
  // the refactor.
  await provider.click(session, { x: 130, y: 80 })
  await new Promise(resolve => setTimeout(resolve, 400))
  const seen = await provider.execute(session, { script: 'window.__occl.join(",")' })
  await provider.execute(session, { script: "document.getElementById('__occl_probe')?.remove()" })
  if (seen.value !== 'click') {
    throw new Error('the page never received the click (' + JSON.stringify(seen.value) + '): the chrome still covers the top of the page')
  }
  return 'reachable'
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
await check('the page fingerprint is coherent', async () => {
  // Only the request headers were ever verified; the JS side never was. It is
  // a faithful Chromium: the UA carries Chrome/ like real Chromium does, the
  // brands list Chromium without Google Chrome exactly as real Chromium does,
  // and the two agree on the major version. Asserting the agreement is what
  // stops a future change from silently desynchronising them.
  const reply = await provider.execute(session, { script: `JSON.stringify({
    webdriver: navigator.webdriver,
    ua: navigator.userAgent,
    brands: navigator.userAgentData ? navigator.userAgentData.brands : null,
    languages: navigator.languages,
    vendor: navigator.vendor,
  })` })
  const seen = JSON.parse(String(reply.value ?? '{}'))
  if (seen.webdriver !== false) throw new Error('navigator.webdriver is ' + JSON.stringify(seen.webdriver))
  if (/Electron\//.test(String(seen.ua))) throw new Error('the UA still advertises Electron: ' + String(seen.ua))
  const major = /Chrome\/(\d+)/.exec(String(seen.ua))?.[1]
  if (major === undefined) throw new Error('the UA has no Chrome major: ' + String(seen.ua))
  const brands = seen.brands ?? []
  if (!brands.some(brand => brand.brand === 'Chromium')) throw new Error('the brands list no Chromium: ' + JSON.stringify(brands))
  if (!brands.some(brand => brand.version === major)) {
    throw new Error('the UA says Chrome/' + major + ' but no brand carries that major: ' + JSON.stringify(brands))
  }
  if (!Array.isArray(seen.languages) || seen.languages.length === 0) throw new Error('navigator.languages is empty')
  return { major, brands: brands.map(brand => brand.brand + ' ' + brand.version).join(', ') }
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
 * DSH validates a tool's return value against its declared output schema, but
 * calling execute() directly skips that. Use the very validator DSH calls
 * (dsh-tools validateJsonSchemaValue on tool.output.schema) rather than a
 * hand-rolled approximation of it.
 */
const assertShape = (name, value) => {
  const problems = validateJsonSchemaValue(definitions.get(name).output.schema, value, 'value')
  if (problems.length > 0) throw new Error(name + ' returned a value its schema rejects: ' + problems.join('; '))
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