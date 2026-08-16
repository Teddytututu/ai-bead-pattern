import assert from 'node:assert/strict'
import { it } from 'node:test'

import { createPatternAlgorithm, type MaterialPalette, type PixelImage } from '../src/index.js'

function benchmarkImage(size: number): PixelImage {
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
  return { width: size, height: size, data }
}

const benchmarkPalette: MaterialPalette = {
  id: 'benchmark-24',
  name: 'Benchmark 24',
  colors: Array.from({ length: 24 }, (_, index) => {
    const red = index % 4 * 85
    const green = Math.floor(index / 4) % 3 * 127
    const blue = Math.floor(index / 12) * 255
    return {
      id: `c-${index}`,
      name: `Color ${index}`,
      hex: `#${[red, green, blue].map((value) => value.toString(16).padStart(2, '0')).join('')}`,
      rgb: [red, green, blue] as const,
    }
  }),
}

it('stays inside the representative online time and memory budget', async () => {
  const beforeRss = process.memoryUsage().rss
  const startedAt = performance.now()
  const result = await createPatternAlgorithm({ clock: () => 123 }).generate({
    image: benchmarkImage(64),
    palette: benchmarkPalette,
    options: {
      canvas: { mode: 'fixed', size: { width: 64, height: 64 } },
      maxColors: 24,
      maxCandidates: 1,
      styles: ['faithful'],
      optimization: { localSearchIterations: 1 },
    },
  })
  const elapsedMs = performance.now() - startedAt
  const rssGrowth = Math.max(0, process.memoryUsage().rss - beforeRss)

  assert.equal(result.status, 'success')
  assert.equal(result.pattern?.cells.length, 4096)
  assert.ok(elapsedMs < 10_000, `Representative generation took ${elapsedMs.toFixed(0)} ms`)
  assert.ok(rssGrowth < 256 * 1024 * 1024, `RSS grew by ${Math.round(rssGrowth / 1024 / 1024)} MiB`)
})

it('keeps an ordinary nine-candidate load inside the CI budget', async () => {
  const beforeRss = process.memoryUsage().rss
  const startedAt = performance.now()
  const result = await createPatternAlgorithm({ clock: () => 123 }).generate({
    image: benchmarkImage(1024),
    palette: benchmarkPalette,
    options: {
      canvas: {
        mode: 'auto',
        candidates: [
          { width: 32, height: 32 },
          { width: 48, height: 48 },
          { width: 64, height: 64 },
        ],
      },
      maxColors: 24,
      maxCandidates: 9,
      styles: ['faithful', 'simple', 'high-contrast'],
      optimization: { localSearchIterations: 1 },
    },
  })
  const elapsedMs = performance.now() - startedAt
  const rssGrowth = Math.max(0, process.memoryUsage().rss - beforeRss)

  assert.equal(result.status, 'success')
  assert.equal(result.evaluation.rankedCandidateIds.length, 9)
  assert.ok(elapsedMs < 30_000, `Nine-candidate generation took ${elapsedMs.toFixed(0)} ms`)
  assert.ok(rssGrowth < 512 * 1024 * 1024, `RSS grew by ${Math.round(rssGrowth / 1024 / 1024)} MiB`)
})
