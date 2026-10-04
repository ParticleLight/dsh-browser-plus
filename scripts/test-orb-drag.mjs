/**
 * 真正驱动指针事件的悬浮球拖动测试（审查要的那条）。
 *
 * 单元测试只能断言「生成的脚本文本里有某个公式」，抓不到 H2 那类错误 ——
 * 慢速拖动曾经因为阈值拿「上一帧已应用的位置」当基准，永远不算拖动：
 * 位置不落盘、松手还会误触 click。这里用离屏 Electron 跑真脚本、派发真指针事件。
 *
 *   node scripts/test-orb-drag.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const chrome = require('../lib/browser-electron/page-chrome.js')
const dir = mkdtempSync(join(tmpdir(), 'orb-drag-'))
const W = 620
const H = 480
const CENTER = { x: W - 18 - 22, y: H - 18 - 22 }

const probe = [
  'window.__moves = [];',
  'window.__seen = [];',
  'window.addEventListener("pointerdown", e => window.__seen.push(["down", e.buttons, Math.round(e.clientX)]), true);',
  'window.addEventListener("pointermove", e => window.__seen.push(["move", e.buttons, Math.round(e.clientX)]), true);',
  'window.__dshChromeToken = "t";',
  'window.__dshChromeTaskKey = "default";',
  'window.__dshBrowserTaskAction = function (payload) { try { const a = JSON.parse(payload); if (a && a.type === "orb-move") window.__moves.push(a) } catch {} };',
  'window.__dshChromeBootstrap = ' + JSON.stringify({
    kind: 'bootstrap', epoch: 1, revision: 1, selectedTaskKey: 'default',
    panels: { tasks: false, trail: false },
    tasks: [{ key: 'default', label: '', active: true, tabs: 1, status: 'running', updatedAt: Date.now() }],
    tabs: [], trail: [], bookmarks: [], bookmarkBar: false,
  }) + ';',
].join('')

const html = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#202124}</style></head><body>'
  + '<scr' + 'ipt>' + probe + '</scr' + 'ipt>'
  + '<scr' + 'ipt>' + chrome.buildPageChromeScript('t', 'page') + '</scr' + 'ipt>'
  + '</body></html>'

const driver = `
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const file = process.argv[2]
const out = process.argv[3]
const center = JSON.parse(process.argv[4])
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: ${W}, height: ${H}, show: false, webPreferences: { offscreen: true } })
  await win.loadFile(file)
  await new Promise(r => setTimeout(r, 700))
  const send = (type, x, y, buttons) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', buttons, clickCount: 1 })
  send('mouseDown', center.x, center.y, 1)
  await new Promise(r => setTimeout(r, 80))
  // 每步之间等一帧多一点：Chromium 会把挨得太近的 pointermove 合并掉，
  // 合并之后「每帧位移」就超过阈值了，测不出 H2 那种慢速拖动。
  for (let i = 1; i <= 60; i++) { send('mouseMove', center.x - i * 2, center.y - i, 1); await new Promise(r => setTimeout(r, 25)) }
  send('mouseUp', center.x - 120, center.y - 60, 0)
  await new Promise(r => setTimeout(r, 250))
  fs.writeFileSync(out, JSON.stringify({
    moves: await win.webContents.executeJavaScript('window.__moves'),
    seen: await win.webContents.executeJavaScript('window.__seen.slice(0, 3)'),
    total: await win.webContents.executeJavaScript('window.__seen.length'),
  }))
  console.log('DRIVER_DONE')
  app.quit()
})
`
writeFileSync(join(dir, 'page.html'), html)
writeFileSync(join(dir, 'drive.cjs'), driver)
const out = join(dir, 'result.json')
const run = spawnSync(process.execPath, [require.resolve('electron/cli.js'), join(dir, 'drive.cjs'), join(dir, 'page.html'), out, JSON.stringify(CENTER)], { encoding: 'utf8' })
const text = String(run.stdout ?? '') + String(run.stderr ?? '')
if (!text.includes('DRIVER_DONE')) { console.error('driver did not finish:\n' + text.slice(-900)); process.exit(1) }
const result = JSON.parse(readFileSync(out, 'utf8'))
console.log('page saw ' + result.total + ' pointer events; first 3: ' + JSON.stringify(result.seen))
const moves = result.moves
if (moves.length === 0) { console.error('FAIL: a slow drag produced no orb-move — the position would not be persisted'); process.exit(1) }
const last = moves[moves.length - 1]
if (!(last.x < CENTER.x) || !(last.y < CENTER.y)) { console.error('FAIL: the orb did not move up-left: ' + JSON.stringify(last)); process.exit(1) }
console.log('OK: slow drag persisted ' + moves.length + ' move(s), last ' + last.x + ',' + last.y)
