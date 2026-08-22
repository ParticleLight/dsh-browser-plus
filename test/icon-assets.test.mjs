import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const svgPath = new URL('../assets/dsh-browser-plus.svg', import.meta.url)

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
