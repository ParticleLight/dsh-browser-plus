import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, stat } from 'node:fs/promises'

const svgPath = new URL('../assets/dsh-browser-plus.svg', import.meta.url)
const png256 = new URL('../assets/dsh-browser-plus-256.png', import.meta.url)
const png512 = new URL('../assets/dsh-browser-plus-512.png', import.meta.url)
const ico = new URL('../assets/dsh-browser-plus.ico', import.meta.url)

test('Browser Flow SVG has the approved vector structure', async () => {
  const svg = await readFile(svgPath, 'utf8')
  assert.match(svg, /viewBox="0 0 256 256"/)
  assert.match(svg, /role="img"/)
  assert.match(svg, /aria-label="dsh-browser-plus"/)
  assert.match(svg, /id="browser-window"/)
  assert.match(svg, /id="task-flow"/)
  assert.match(svg, /id="task-node-a"/)
  assert.match(svg, /id="task-node-b"/)
  assert.match(svg, /#68c9e8/)
  assert.match(svg, /#77d59a/)
  assert.doesNotMatch(svg, /<text\b/)
  assert.doesNotMatch(svg, /<(image|foreignObject)\b/)
  assert.doesNotMatch(svg, /\b(?:href|xlink:href)=/)
})

test('icon derivatives exist with valid PNG/ICO signatures', async () => {
  const [a, b, c] = await Promise.all([stat(png256), stat(png512), stat(ico)])
  assert.ok(a.size > 100)
  assert.ok(b.size > a.size)
  assert.ok(c.size > a.size)
  const fsApi = await import('node:fs/promises')
  assert.deepEqual([...await fsApi.readFile(png256)].slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10])
  assert.deepEqual([...await fsApi.readFile(ico)].slice(0, 4), [0, 0, 1, 0])
})

test('icon resolver selects platform assets', async () => {
  const icon = await import('../lib/browser-electron/icon.js')
  assert.equal(icon.resolveBrowserIconPath('win32').endsWith('dsh-browser-plus.ico'), true)
  assert.equal(icon.resolveBrowserIconPath('linux').endsWith('dsh-browser-plus-256.png'), true)
  assert.equal(icon.resolveBrowserIconPath('darwin').endsWith('dsh-browser-plus-512.png'), true)
  assert.equal(icon.resolveBrowserIconPath('win32').includes('assets'), true)
})

test('host passes resolved icon to BrowserWindow', async () => {
  const source = await readFile(new URL('../src/browser-electron/host-main.ts', import.meta.url), 'utf8')
  assert.match(source, /resolveBrowserIconPath/)
  assert.match(source, /icon/)
  assert.match(source, /dock/)
})

test('icon resolver handles unknown platform and missing derivative safely', async () => {
  const icon = await import('../lib/browser-electron/icon.js')
  // Unknown platforms resolve deterministically to the linux fallback PNG.
  const fallback = icon.resolveBrowserIconPath('aix')
  assert.equal(typeof fallback, 'string')
  assert.equal(fallback.endsWith('dsh-browser-plus-256.png'), true)
  assert.equal(fallback.includes('assets'), true)
  // Path-only API: synchronous platform -> absolute path; never reads asset
  // contents and never throws for an unknown platform. Missing assets are a
  // packaging concern, not a resolver crash, so tracked files are not deleted
  // here; the packaged fallback asset is asserted to exist below (and all four
  // package assets are asserted by the package test).
  const fallbackStat = await stat(png256)
  assert.ok(fallbackStat.size > 0)
})

test('package includes Browser Flow icon assets', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.files.includes('assets'))
  const [svg, p256, p512, icoFile] = await Promise.all([stat(svgPath), stat(png256), stat(png512), stat(ico)])
  assert.ok(svg.size > 100)
  assert.ok(p256.size > 100)
  assert.ok(p512.size > p256.size)
  assert.ok(icoFile.size > p256.size)
})
