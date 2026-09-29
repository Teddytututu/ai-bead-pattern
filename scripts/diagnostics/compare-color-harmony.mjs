// Local visual regression: original catalog RGBs, fixed inputs, no model calls.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPatternAlgorithm } from '../../packages/pattern-core/dist/index.js'
import { getPalette } from '../../packages/material-palettes/dist/index.js'

import sharp from 'sharp'
const argument = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback
const label = argument('--label', 'current').replace(/[^a-z0-9_-]/gi, '_')
const baseline = argument('--baseline', undefined)
const palette = await getPalette(argument('--palette', 'mard-291'))
const variants = baseline ? [['Before', (await import(pathToFileURL(resolve(baseline)).href)).createPatternAlgorithm], ['After', createPatternAlgorithm]]
  : [['Current', createPatternAlgorithm]]
const reference = argument('--reference', undefined)
if (reference) variants.push(['Reference', createPatternAlgorithm, await getPalette(reference)])
const directory = resolve('output/diagnostics/color-harmony', label)
await mkdir(directory, { recursive: true })
const sources = [['cat', 'apps/demo/assets/sample-cat.png'], ['kitten', 'tests/fixtures/images/kitten.jfif'], ['frog', 'tests/fixtures/images/frog.jpg']]
const options = { width: 64, height: 64, maxColors: 20, maxCandidates: 1, styles: ['faithful'],
  structure: { outlineMode: 'off', occupancyMode: 'full-frame', valueMode: 'preserve' },
  optimization: { minRegionSize: 2, isolatedPixelPenalty: 1, stripePenalty: 1, aliasPenalty: 1,
    paletteCoherence: 1.15, localSearchIterations: 2, edgeProtection: 0.8, refinementMode: 'quality' } }
const rows = [], panels = [], titles = [], panelWidth = 264, panelHeight = 288

for (const [name, file] of sources) {
  const bytes = await readFile(resolve(file))
  const decoded = await sharp(bytes).resize(256, 256, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const image = { width: decoded.info.width, height: decoded.info.height, data: new Uint8ClampedArray(decoded.data) }
  const fullMask = { width: image.width, height: image.height, values: new Float32Array(image.width * image.height).fill(1) }
  const scenarios = [['plain', undefined, options.structure], ['semantic', { confidence: 1,
    semanticRegions: [{ id: 'body', label: 'subject body', confidence: 1, importance: 0.8, mask: fullMask }] }, options.structure]]
  if (name === 'cat') {
    const rawMask = await sharp('apps/demo/assets/sample-cat-mask.png').resize(image.width, image.height).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const mask = { width: image.width, height: image.height,
      values: Float32Array.from({ length: image.width * image.height }, (_, cell) => rawMask.data[cell * rawMask.info.channels] / 255) }
    scenarios.push(['subject', { imageType: 'pet', confidence: 0.96, subjectMask: mask,
      subjectMaskEvidence: { mask, confidence: 0.96, source: 'ai', revision: 'demo:bundled-birefnet:cat-v1' },
      semanticRegions: [{ id: 'subject', label: 'subject', mask, confidence: 0.96, importance: 0.9 }] },
    { ...options.structure, outlineMode: 'full', occupancyMode: 'subject-shape' }])
  }
  for (const [scenario, analysis, structure] of scenarios) {
    const results = []
    for (const [variant, algorithm, comparisonPalette = palette] of variants) {
      const result = await algorithm({ clock: () => 123 }).generate({ image, palette: comparisonPalette,
        ...(analysis ? { analysis } : {}), options: { ...options, structure } })
      const candidate = result.recommended ?? result.bestEffort
      assert.ok(candidate, `${name}/${scenario}/${variant} needs a comparable candidate`)
      assert.ok(candidate.pattern.palette.length <= options.maxColors)
      const byId = new Map(comparisonPalette.colors.map(color => [color.id, color.rgb]))
      assert.ok(candidate.pattern.cells.every(cell => comparisonPalette.colors.some(color => color.id === cell.colorId && color.automaticMatch !== false)))
      if (comparisonPalette.id === 'mard-291') assert.ok(candidate.pattern.cells.every(cell => cell.colorId !== 'H7'))
      const pixels = Buffer.alloc(64 * 64 * 4)
      for (const cell of candidate.pattern.cells) pixels.set([...byId.get(cell.colorId), 255], (cell.y * 64 + cell.x) * 4)
      const png = await sharp(pixels, { raw: { width: 64, height: 64, channels: 4 } }).resize(248, 248, { kernel: 'nearest' }).png().toBuffer()
      const filename = `${name}-${scenario}-${variant.toLowerCase()}.png`
      await writeFile(resolve(directory, filename), png)
      results.push({ name, scenario, variant, paletteId: comparisonPalette.id, paletteVersion: comparisonPalette.version,
        input: file, inputSha256: createHash('sha256').update(bytes).digest('hex'),
        configuration: { ...options, structure }, status: result.status, pattern: candidate.pattern,
        metrics: candidate.metrics, contourPlan: candidate.contourPlan, colorDiagnostics: candidate.colorDiagnostics, image: filename, png })
      console.log(JSON.stringify({ name, scenario, variant, isolated: candidate.metrics.isolatedCells,
        meanDeltaE00: candidate.metrics.sourceMeanColorDistance, usedColors: candidate.pattern.palette.length }))
    }
    if (baseline) assert.deepEqual(results[1].pattern.cells.map(cell => [cell.x, cell.y]),
      results[0].pattern.cells.map(cell => [cell.x, cell.y]), 'color cleanup must not change occupancy')
    rows.push(...results.map(({ png, ...record }) => record))
    // Show the plain-photo matrix and the actual bundled-mask route; synthetic evidence stays in JSON.
    if (scenario === 'semantic') continue
    const row = titles.length
    titles.push(`${name}${scenario === 'subject' ? ' (subject mask + contour)' : ''}`)
    panels.push({ input: await sharp(bytes).resize(248, 248, { fit: 'contain', background: '#f5f4ef' }).png().toBuffer(), left: 8, top: row * panelHeight + 32 })
    results.forEach((record, column) => panels.push({ input: record.png, left: (column + 1) * panelWidth + 8, top: row * panelHeight + 32 }))
  }
}
const width = panelWidth * (variants.length + 1), height = panelHeight * titles.length
const headers = ['Source', ...variants.map(([name]) => name)]
const text = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${titles.flatMap((title, row) =>
  headers.map((header, column) => `<text x="${column * panelWidth + 8}" y="${row * panelHeight + 23}" font-family="Arial" font-size="13" fill="#333">${title}: ${header}</text>`)).join('')}</svg>`)
await sharp({ create: { width, height, channels: 4, background: '#f5f4ef' } }).composite([...panels, { input: text, left: 0, top: 0 }]).png().toFile(resolve(directory, 'comparison.png'))
await writeFile(resolve(directory, 'report.json'), JSON.stringify({ paletteId: palette.id, paletteVersion: palette.version, baseline,
  note: 'Semantic full-frame evidence is synthetic and exercises planning only. The subject case reuses the bundled cat mask. Screens represent catalog RGBs, not physically calibrated beads.', rows }, null, 2) + '\n')
