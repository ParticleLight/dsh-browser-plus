// Browser icon derivatives builder.
// Reads assets/dsh-browser-plus.svg (plus the -small variant for the sizes where the
// title-bar dots would be sub-pixel), renders 256/512 PNGs and an ICO
// (16/32/48/256 PNG entries) with @resvg/resvg-js, writes them to assets/.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const assetsDir = path.join(root, 'assets')
const svgPath = path.join(assetsDir, 'dsh-browser-plus.svg')

const smallSvgPath = path.join(assetsDir, 'dsh-browser-plus-small.svg')

async function readSvg(file, label) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    console.error(`build-icons: cannot read ${label} at ${file}: ${error.message}`)
    process.exit(1)
  }
}

const svg = await readSvg(svgPath, 'source SVG')
// Falls back to the full-detail art, so a missing variant degrades instead of failing.
const smallSvg = existsSync(smallSvgPath) ? await readSvg(smallSvgPath, 'small SVG') : svg

function renderPng(size, source = svg) {
  const data = new Resvg(source, { fitTo: { mode: 'width', value: size } }).render()
  const buffer = data.asPng()
  if (!buffer || buffer.length === 0) {
    throw new Error(`build-icons: empty render at ${size}px`)
  }
  return buffer
}

function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const entries = Buffer.alloc(images.length * 16)
  let offset = 6 + entries.length
  for (let i = 0; i < images.length; i++) {
    const image = images[i]
    const size = image.size >= 256 ? 0 : image.size
    entries.writeUInt8(size, i * 16)
    entries.writeUInt8(size, i * 16 + 1)
    entries.writeUInt8(0, i * 16 + 2)
    entries.writeUInt8(0, i * 16 + 3)
    entries.writeUInt16LE(1, i * 16 + 4)
    entries.writeUInt16LE(32, i * 16 + 6)
    entries.writeUInt32LE(image.bytes.length, i * 16 + 8)
    entries.writeUInt32LE(offset, i * 16 + 12)
    offset += image.bytes.length
  }
  return Buffer.concat([header, entries, ...images.map((image) => image.bytes)])
}

await mkdir(assetsDir, { recursive: true })

const png256 = renderPng(256)
const png512 = renderPng(512)
const ico = buildIco([
  { size: 16, bytes: renderPng(16, smallSvg) },
  { size: 32, bytes: renderPng(32, smallSvg) },
  { size: 48, bytes: renderPng(48) },
  { size: 256, bytes: png256 },
])

await writeFile(path.join(assetsDir, 'dsh-browser-plus-256.png'), png256)
await writeFile(path.join(assetsDir, 'dsh-browser-plus-512.png'), png512)
await writeFile(path.join(assetsDir, 'dsh-browser-plus.ico'), ico)

console.log(`assets/dsh-browser-plus-256.png ${png256.length} bytes`)
console.log(`assets/dsh-browser-plus-512.png ${png512.length} bytes`)
console.log(`assets/dsh-browser-plus.ico ${ico.length} bytes`)
