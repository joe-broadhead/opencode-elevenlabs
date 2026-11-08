#!/usr/bin/env node
// Draws the plugin's 128 and 256 PNG icons from the same geometry as assets/icon.svg, with no dependency: an 8-bit
// RGBA PNG, IHDR/IDAT/IEND only, which is what scripts/check-icons.mjs requires. Run after changing the SVG:
//   node scripts/make-icons.mjs
import { deflateSync } from "node:zlib"
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

/** The mark: three bars of different heights on the brand's near-black, the shortest on the left. */
const BACKGROUND = [17, 17, 17, 255]
const BAR = [255, 255, 255, 255]
/** Fractions of the canvas: [x, width] for each bar, all with the same baseline. */
const BARS = [
  [0.26, 0.1, 0.4],
  [0.44, 0.1, 0.66],
  [0.62, 0.1, 0.28],
]

function render(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const radius = Math.round(size * 0.22)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4
      // The rounded square: outside the corner circles is transparent.
      const dx = x < radius ? radius - x : x >= size - radius ? x - (size - radius - 1) : 0
      const dy = y < radius ? radius - y : y >= size - radius ? y - (size - radius - 1) : 0
      if (dx > 0 && dy > 0 && dx * dx + dy * dy > radius * radius) continue
      const colour = barAt(x / size, y / size) ? BAR : BACKGROUND
      pixels[offset] = colour[0]
      pixels[offset + 1] = colour[1]
      pixels[offset + 2] = colour[2]
      pixels[offset + 3] = colour[3]
    }
  }
  return pixels
}

function barAt(fx, fy) {
  for (const [left, width, height] of BARS) {
    const top = 0.5 - height / 2
    if (fx >= left && fx <= left + width && fy >= top && fy <= top + height) return true
  }
  return false
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

const TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

for (const size of [128, 256]) {
  const pixels = render(size)
  // One filter byte (0: none) before each row.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
  writeFileSync(`${root}assets/icon-${size}.png`, png)
  console.log(`assets/icon-${size}.png: ${png.length} bytes`)
}
