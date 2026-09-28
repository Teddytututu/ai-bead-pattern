import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { createPatternAlgorithm } from '../packages/pattern-core/dist/index.js'
import { deltaE2000, prepareColors, rgbToLab } from '../packages/pattern-core/dist/color.js'
import { resizePixels } from '../packages/pattern-core/dist/image.js'
import { getPalette } from '../packages/material-palettes/dist/index.js'

const sharp = createRequire(new URL('../services/ai-gateway/package.json', import.meta.url))('sharp')
const argument = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback
const input = argument('--input', 'apps/demo/assets/sample-cat.png')
const label = argument('--label', 'current').replace(/[^a-z0-9_-]/gi, '_')
const bytes = await readFile(resolve(input))
const photo = await sharp(bytes).resize(256, 256, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const image = { width: photo.info.width, height: photo.info.height, data: new Uint8ClampedArray(photo.data) }
const configuration = {
  width: 48, height: 48, baseline: 'mvp', styles: ['faithful'], maxCandidates: 1, refinementMode: 'fast',
  structure: { valueMode: 'preserve', outlineMode: 'off', occupancyMode: 'full-frame' },
}
const sampled = resizePixels(image, { x: 0, y: 0, width: image.width, height: image.height }, 48, 48, 'cell-aware')
const sourceLabs = sampled.pixels.filter((_, cell) => sampled.activeMask[cell] === 1).map(rgbToLab)
const directory = resolve('output/color-fidelity-triage', label)
await mkdir(directory, { recursive: true })
const rows = [], fullPaletteReferences = []

for (const paletteId of ['generic-24', 'perler-123', 'mard-291']) {
  const palette = await getPalette(paletteId)
  // Reference only: mirror the faithful route's current eligibility policy, without a used-color budget.
  const eligible = prepareColors(palette.colors.filter(color => color.automaticMatch !== false
    && (paletteId !== 'mard-291' || color.id !== 'H7')))
  const errors = sourceLabs.map(lab => Math.min(...eligible.map(color => deltaE2000(lab, color.lab)))).sort((a, b) => a - b)
  fullPaletteReferences.push({ paletteId, paletteVersion: palette.version, eligibleColors: eligible.length,
    meanDeltaE: errors.reduce((sum, error) => sum + error, 0) / errors.length,
    p95DeltaE: errors[Math.floor(errors.length * 0.95)] })

  for (const maxColors of [20, Math.min(48, palette.automaticColorCount)]) for (const evidence of [false, true]) {
    // Synthetic evidence isolates the semantic planning path; it does not measure a neural model.
    const analysis = evidence ? { confidence: 1, semanticRegions: [{ id: 'subject-body', label: 'subject body',
      confidence: 1, importance: 0.8, mask: { width: image.width, height: image.height,
        values: new Uint8Array(image.width * image.height).fill(1) } }] } : undefined
    const result = await createPatternAlgorithm({ clock: () => 123 }).generate({ image, palette,
      ...(analysis ? { analysis } : {}), options: { ...configuration, maxColors } })
    const candidate = result.recommended ?? result.bestEffort
    if (!candidate) throw new Error(`No comparable candidate: ${paletteId}/${maxColors}/${evidence}`)
    const filename = `${paletteId}-${maxColors}-${evidence ? 'semantic' : 'plain'}.png`
    const pixels = Buffer.alloc(candidate.pattern.width * candidate.pattern.height * 4)
    const byId = new Map(palette.colors.map(color => [color.id, color.rgb]))
    for (const cell of candidate.pattern.cells) pixels.set([...byId.get(cell.colorId), 255], (cell.y * candidate.pattern.width + cell.x) * 4)
    await sharp(pixels, { raw: { width: candidate.pattern.width, height: candidate.pattern.height, channels: 4 } })
      .resize(480, 480, { kernel: 'nearest' }).png().toFile(resolve(directory, filename))
    const row = { paletteId, paletteVersion: palette.version, maxColors, evidence, status: result.status,
      usedColors: candidate.pattern.palette.length, version: candidate.pattern.metadata.algorithmVersion,
      metrics: candidate.metrics, colorDiagnostics: candidate.colorDiagnostics, image: filename }
    rows.push(row)
    console.log(JSON.stringify({ paletteId, maxColors, evidence, status: row.status, usedColors: row.usedColors,
      quantizationMeanDeltaE: row.colorDiagnostics?.quantization.meanDeltaE, finalMeanDeltaE: row.colorDiagnostics?.final.meanDeltaE }))
  }
}
await writeFile(resolve(directory, 'report.json'), JSON.stringify({ input,
  inputSha256: createHash('sha256').update(bytes).digest('hex'), configuration,
  note: 'Synthetic full-frame subject-body evidence probes a code path. This is not neural-mask quality, physical bead calibration, or reproduction of an unavailable contributor failure sample.',
  fullPaletteReferences, rows }, null, 2) + '\n')
