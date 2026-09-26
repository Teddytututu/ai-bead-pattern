import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { createPatternAlgorithm } from '../packages/pattern-core/dist/index.js'
import { getPalette } from '../packages/material-palettes/dist/index.js'
const sharp = createRequire(new URL('../services/ai-gateway/package.json', import.meta.url))('sharp')
const argument = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback
const label = argument('--label', 'current').replace(/[^a-z0-9_-]/gi, '_')
const input = argument('--input', 'apps/demo/assets/sample-cat.png')
const photo = await sharp(resolve(input)).resize(256, 256, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const image = { width: photo.info.width, height: photo.info.height, data: new Uint8ClampedArray(photo.data) }
const directory = resolve('output/value-fidelity', label)
await mkdir(directory, { recursive: true })
const rows = []
for (const paletteId of ['generic-24', 'mard-291']) for (const evidence of [false, true]) {
  const palette = await getPalette(paletteId)
  const analysis = evidence ? { confidence: 1, semanticRegions: [{ id: 'subject-body', label: 'subject body', confidence: 1, importance: 0.8, mask: { width: image.width, height: image.height, values: new Uint8Array(image.width * image.height).fill(1) } }] } : undefined
  const start = performance.now()
  const result = await createPatternAlgorithm({ clock: () => 123 }).generate({ image, palette, ...(analysis ? { analysis } : {}), options: { width: 48, height: 48, maxColors: 20, styles: ['faithful'], maxCandidates: 1, structure: { outlineMode: 'off', occupancyMode: 'full-frame' } } })
  const candidate = result.recommended ?? result.bestEffort
  if (!candidate) throw new Error(`No comparable candidate for ${paletteId}; generation status: ${result.status}`)
  const row = { paletteId, evidence, elapsedMs: Math.round(performance.now() - start), status: result.status, version: candidate.pattern.metadata.algorithmVersion, metrics: candidate.metrics, score: candidate.score, colorDiagnostics: candidate.colorDiagnostics }
  rows.push(row)
  const pixels = Buffer.alloc(48 * 48 * 4)
  const byId = new Map(palette.colors.map(color => [color.id, color.rgb]))
  for (const cell of candidate.pattern.cells) pixels.set([...byId.get(cell.colorId), 255], (cell.y * 48 + cell.x) * 4)
  await sharp(pixels, { raw: { width: 48, height: 48, channels: 4 } }).resize(480, 480, { kernel: 'nearest' }).png().toFile(resolve(directory, `${paletteId}-${evidence ? 'semantic' : 'plain'}.png`))
  console.log(JSON.stringify({ paletteId, evidence, elapsedMs: row.elapsedMs, sourceDeltaE: row.metrics.sourceMeanColorDistance, planDeltaE: row.metrics.planMeanColorDistance }))
}
await writeFile(resolve(directory, 'report.json'), JSON.stringify({ input, label, configuration: { side: 48, maxColors: 20, style: 'faithful', outline: 'off' }, rows }, null, 2))
