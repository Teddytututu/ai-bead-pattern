import { readFile } from 'node:fs/promises'

import { createPatternAlgorithm } from '../dist/index.js'

const paletteUrl = new URL('../../../assets/palettes/generic-24.json', import.meta.url)
const palette = JSON.parse(await readFile(paletteUrl, 'utf8'))
const width = 32
const height = 32
const center = (width - 1) / 2
const radius = width * 0.35
const data = new Uint8ClampedArray(width * height * 4)

for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const index = (y * width + x) * 4
    const inside = (x - center) ** 2 + (y - center) ** 2 < radius ** 2
    data[index] = inside ? 224 : 55
    data[index + 1] = inside ? 83 : 112
    data[index + 2] = inside ? 98 : 180
    data[index + 3] = 255
  }
}

const result = await createPatternAlgorithm().generate({
  image: { width, height, data },
  palette,
  options: {
    canvas: {
      mode: 'auto',
      candidates: [
        { width: 32, height: 32 },
        { width: 48, height: 48 }
      ]
    },
    maxColors: 8,
    maxCandidates: 3,
    styles: ['faithful', 'simple', 'high-contrast'],
    optimization: {
      minRegionSize: 2,
      isolatedPixelPenalty: 1,
      stripePenalty: 1
    }
  }
})

const primary = result.recommended ?? result.bestEffort
if (primary === undefined) throw new Error('Generation produced no candidate')

console.log(JSON.stringify({
  status: result.status,
  recommended: result.recommended?.id,
  bestEffort: result.bestEffort?.id,
  size: [primary.pattern.width, primary.pattern.height],
  colors: primary.materialCounts,
  alternatives: result.alternatives.map((candidate) => candidate.id),
  score: primary.score
}, null, 2))
