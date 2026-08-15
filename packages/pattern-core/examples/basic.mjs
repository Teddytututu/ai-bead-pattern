import { readFile } from 'node:fs/promises'

import { createPatternAlgorithm } from '../dist/index.js'

const paletteUrl = new URL('../../../assets/palettes/generic-24.json', import.meta.url)
const palette = JSON.parse(await readFile(paletteUrl, 'utf8'))
const width = 8
const height = 8
const data = new Uint8ClampedArray(width * height * 4)

for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const index = (y * width + x) * 4
    const inside = (x - 3.5) ** 2 + (y - 3.5) ** 2 < 10
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
        { width: 8, height: 8 },
        { width: 12, height: 12 }
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

console.log(JSON.stringify({
  recommended: result.recommended.id,
  size: [result.pattern.width, result.pattern.height],
  colors: result.materialCounts,
  alternatives: result.alternatives.map((candidate) => candidate.id),
  score: result.recommended.score
}, null, 2))
