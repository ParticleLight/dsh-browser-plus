// Browser Flow icon derivatives builder.
// Reads assets/dsh-browser-plus.svg, renders 256/512 PNGs and an ICO
// (16/32/48/256 PNG entries) with @resvg/resvg-js, writes them to assets/.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const assetsDir = path.join(root, 'assets')
const svgPath = path.join(assetsDir, 'dsh-browser-plus.svg')

let svg
try {
  svg = await readFile(svgPath, 'utf8')
} catch (error) {
  console.error(`build-icons: cannot read source SVG at ${svgPath}: ${error.message}`)
  process.exit(1)
}

function renderPng(size) {
  const data = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render()
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
  { size: 16, bytes: renderPng(16) },
  { size: 32, bytes: renderPng(32) },
  { size: 48, bytes: renderPng(48) },
  { size: 256, bytes: png256 },
])

await writeFile(path.join(assetsDir, 'dsh-browser-plus-256.png'), png256)
await writeFile(path.join(assetsDir, 'dsh-browser-plus-512.png'), png512)
await writeFile(path.join(assetsDir, 'dsh-browser-plus.ico'), ico)

console.log(`assets/dsh-browser-plus-256.png ${png256.length} bytes`)
console.log(`assets/dsh-browser-plus-512.png ${png512.length} bytes`)
console.log(`assets/dsh-browser-plus.ico ${ico.length} bytes`)
