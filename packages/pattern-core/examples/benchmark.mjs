import { performance } from 'node:perf_hooks'

import { createPatternAlgorithm } from '../dist/index.js'

const size = 64
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

const palette = {
  id: 'benchmark-24',
  name: 'Benchmark 24',
  colors: Array.from({ length: 24 }, (_, index) => {
    const rgb = [index % 4 * 85, Math.floor(index / 4) % 3 * 127, Math.floor(index / 12) * 255]
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
    canvas: { mode: 'fixed', size: { width: size, height: size } },
    maxColors: 24,
    maxCandidates: 1,
    styles: ['faithful'],
    optimization: { localSearchIterations: 1 },
  },
})

console.log(JSON.stringify({
  elapsedMs: Math.round(performance.now() - startedAt),
  rssGrowthMiB: Math.round(Math.max(0, process.memoryUsage().rss - beforeRss) / 1024 / 1024),
  beads: result.pattern.metadata.totalBeads,
  colors: result.metrics.uniqueColors,
}, null, 2))
