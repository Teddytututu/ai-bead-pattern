import { performance } from 'node:perf_hooks'

import { createPatternAlgorithm } from '../dist/index.js'

const maximumLoad = process.argv.includes('--max')
const size = maximumLoad ? 2000 : 64
const data = new Uint8ClampedArray(size * size * 4)
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const index = (y * size + x) * 4
    data[index] = Math.round(x / (size - 1) * 255)
    data[index + 1] = Math.round(y / (size - 1) * 255)
    data[index + 2] = Math.round((x + y) / (2 * size - 2) * 255)
    data[index + 3] = 255
  }
}

const paletteSize = maximumLoad ? 128 : 24
const palette = {
  id: `benchmark-${paletteSize}`,
  name: `Benchmark ${paletteSize}`,
  colors: Array.from({ length: paletteSize }, (_, index) => {
    const rgb = [index * 53 % 256, index * 97 % 256, index * 193 % 256]
    return {
      id: `c-${index}`,
      name: `Color ${index}`,
      hex: `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`,
      rgb,
    }
  }),
}

const beforeRss = process.memoryUsage().rss
const startedAt = performance.now()
const result = await createPatternAlgorithm().generate({
  image: { width: size, height: size, data },
  palette,
  options: {
    canvas: maximumLoad
      ? {
        mode: 'auto',
        candidates: [48, 64, 80, 96].map((side) => ({ width: side, height: side })),
      }
      : { mode: 'fixed', size: { width: size, height: size } },
    maxColors: maximumLoad ? 48 : 24,
    maxCandidates: maximumLoad ? 20 : 1,
    styles: maximumLoad
      ? ['faithful', 'cute', 'simple', 'high-contrast', 'soft']
      : ['faithful'],
    optimization: { localSearchIterations: maximumLoad ? 2 : 1 },
  },
})

const primary = result.recommended ?? result.bestEffort
if (primary === undefined) throw new Error('Benchmark produced no candidate')

console.log(JSON.stringify({
  mode: maximumLoad ? 'maximum' : 'representative',
  status: result.status,
  elapsedMs: Math.round(performance.now() - startedAt),
  rssGrowthMiB: Math.round(Math.max(0, process.memoryUsage().rss - beforeRss) / 1024 / 1024),
  candidates: result.evaluation.rankedCandidateIds.length,
  beads: primary.pattern.metadata.totalBeads,
  colors: primary.metrics.uniqueColors,
}, null, 2))
