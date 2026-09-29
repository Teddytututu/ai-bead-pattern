import { cpus, platform } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { getPalette } from '../../packages/material-palettes/dist/index.js'
import { createPatternAlgorithm } from '../../packages/pattern-core/dist/index.js'
import sharp from 'sharp'
const full = process.argv.includes('--full')
const caseIndex = process.argv.indexOf('--case')
const selected = caseIndex < 0 ? undefined : process.argv.slice(caseIndex + 1, caseIndex + 6)
const repeats = full ? 3 : 1
const size = 128
const gradient = new Uint8ClampedArray(size * size * 4)
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) gradient.set([x * 2, y * 2, (x + y) % 256, 255], (y * size + x) * 4)
const cat = await sharp(fileURLToPath(new URL('../../apps/demo/assets/sample-cat.png', import.meta.url))).resize(256, 256, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const inputs = [{ name: 'gradient', image: { width: size, height: size, data: gradient } },
  { name: 'cat-photo', image: { width: cat.info.width, height: cat.info.height, data: new Uint8ClampedArray(cat.data) } }]
const transparent = new Uint8ClampedArray(gradient)
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (((x - 64) / 48) ** 2 + ((y - 64) / 54) ** 2 > 1 || (x + y) % 17 === 0) transparent[(y * size + x) * 4 + 3] = 0
inputs.push({ name: 'transparent-edges', image: { width: size, height: size, data: transparent } })
const algorithm = createPatternAlgorithm({ clock: () => 123 })
const rows = []
for (const paletteId of ['generic-24', 'perler-123', 'mard-291']) {
  if (selected && selected[0] !== paletteId) continue
  const palette = await getPalette(paletteId)
  await algorithm.generate({ image: inputs[0].image, palette, options: { width: 32, height: 32, maxColors: 20, styles: ['faithful'], maxCandidates: 1 } })
  for (const input of inputs) for (const side of full ? [32, 48, 64, 96] : [64]) for (const mode of full ? ['fast', 'quality'] : ['fast']) for (const count of full ? [1, 3] : [1]) {
    if (selected && [input.name, String(side), mode, String(count)].some((value, i) => value !== selected[i + 1])) continue
    const durations = [], rss = []
    let result
    for (let repeat = 0; repeat < repeats; repeat++) {
      const before = process.memoryUsage().rss, start = performance.now()
      result = await algorithm.generate({ image: input.image, palette, options: { width: side, height: side, maxColors: 20, styles: count === 1 ? ['faithful'] : ['faithful', 'simple', 'high-contrast'], maxCandidates: count, optimization: { refinementMode: mode, localSearchIterations: 1 } } })
      durations.push(Math.round(performance.now() - start)); rss.push(Math.max(0, process.memoryUsage().rss - before))
    }
    const row = { paletteId, input: input.name, side, mode, candidates: count, durationsMs: durations, maxRssGrowthMiB: Math.round(Math.max(...rss) / 1024 / 1024), status: result.status, colors: (result.recommended ?? result.bestEffort)?.materialCounts.length }
    if (selected) row.processPeakRssMiB = Math.round(process.resourceUsage().maxRSS / 1024)
    rows.push(row); console.log(JSON.stringify(row))
  }
}
if (!selected) {
  await mkdir(new URL('../../output/benchmarks/', import.meta.url), { recursive: true })
  await writeFile(new URL('../../output/benchmarks/palette-benchmark.json', import.meta.url), JSON.stringify({ date: new Date().toISOString(), node: process.version, cpu: cpus()[0].model, platform: platform(), full, repeats, memoryMetric: 'RSS growth after each run; not sampled peak', rows }, null, 2))
}
