import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createPatternAlgorithm } from '../src/index.js'
import { prepareColors, rgbToLab } from '../src/color.js'
import { isBlackFill, isDeepSaturatedInk, selectSingleInk, preserveFillEvidence } from '../src/planning/mard-fill-policy.js'
import type { ImageAnalysis, MaterialPalette, PatternGenerationRequest, RGB } from '../src/types.js'

const palette = JSON.parse(readFileSync(new URL('../../../../assets/palettes/mard-291.json', import.meta.url), 'utf8')) as MaterialPalette
const inkColors = palette.colors.filter(isDeepSaturatedInk)
function stripedRequest(paletteId = 'mard-291'): PatternGenerationRequest {
  const width = 32, height = 32, data = new Uint8ClampedArray(width * height * 4)
  const values = new Float32Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const cell = y * width + x, inside = x >= 3 && x <= 28 && y >= 2 && y <= 29 && !(x > 21 && y > 22)
    values[cell] = Number(inside)
    const rgb: RGB = x >= 17 && x <= 19 ? [206, 69, 111] : y % 4 === 0 ? [52, 38, 24] : [187, 149, 110]
    data.set(inside ? [...rgb, 255] : [255, 255, 255, 255], cell * 4)
  }
  const mask = { width, height, values }
  const analysis: ImageAnalysis = { confidence: 1, subjectMask: mask,
    subjectMaskEvidence: { mask, source: 'ai', confidence: 1, revision: 'synthetic-mask' },
    semanticRegions: [{ id: 'body', label: 'subject', mask, confidence: 1 },
      { id: 'tail', label: 'tail', confidence: 1, mask: { width, height, values: Float32Array.from(values, (value, i) => i % width >= 24 ? value : 0) } }],
  }
  return { image: { width, height, data }, analysis, palette: { ...palette, id: paletteId }, options: {
    canvas: { mode: 'fixed', size: { width, height } }, maxColors: 12, maxCandidates: 1, styles: ['faithful'],
    structure: { occupancyMode: 'subject-shape', valueMode: 'preserve' },
    optimization: { refinementMode: 'quality', paletteCoherence: 2, minRegionSize: 4, stripePenalty: 2 },
  } }
}
describe('MARD 291 single ink and source fill', () => {
  it('uses only the catalog deep saturated subset and excludes nominal H7 black', () => {
    assert.deepEqual(inkColors.map(c => c.id).sort(), ['B22', 'B23', 'C12', 'C18', 'D10', 'D15', 'D22', 'D4', 'F11', 'F7', 'G8', 'R22'])
    assert.ok(isBlackFill(palette.colors.find(c => c.id === 'H7')!))
    assert.ok(!isBlackFill(palette.colors.find(c => c.id === 'H16')!))
  })
  it('chooses a darkened subject hue once and ignores a different colored background', () => {
    for (const [rgb, expected] of [[[175, 115, 66], 'G8'], [[46, 114, 164], 'C12'], [[20, 133, 116], 'B22'], [[160, 20, 57], 'F7']] as const) {
      const id = selectSingleInk({ colors: palette.colors, pixelLabs: [rgbToLab(rgb), rgbToLab([210, 60, 220])],
        referenceMask: new Uint8Array([1, 0]), contourCells: [0] })
      assert.equal(id, expected)
    }
  })
  it('rejects light/neutral overrides and never combines insufficient ink stocks', () => {
    const base = { colors: palette.colors, pixelLabs: [rgbToLab([175, 115, 66])], referenceMask: new Uint8Array([1]), contourCells: [0, 1, 2] }
    for (const colorId of ['H7', 'H6', 'A1']) assert.throws(() => selectSingleInk({ ...base, colorId }), /deep saturated/)
    assert.throws(() => selectSingleInk({ ...base, inventory: Object.fromEntries(inkColors.map(c => [c.id, 2])) }), /entire contour/)
  })
  it('keeps one ink, non-black fill, stripes, an unusual color patch and source occupancy after quality cleanup', async () => {
    const request = stripedRequest()
    const result = await createPatternAlgorithm().generate(request)
    const candidate = (result.recommended ?? result.bestEffort)!
    assert.ok(candidate)
    const ink = new Set(Object.values(candidate.contourPlan!.colorByCell))
    assert.equal(ink.size, 1)
    assert.ok(candidate.contourPlan!.internalCells.length > 0)
    assert.ok(candidate.contourPlan!.externalCells.length > 0)
    assert.ok(inkColors.some(c => ink.has(c.id)))
    assert.equal(candidate.contourPlan!.diagnostics.retainedCells, candidate.contourPlan!.diagnostics.selectedCells)
    assert.ok(candidate.pattern.cells.every(c => c.colorId !== 'H7'))
    assert.ok(candidate.pattern.palette.length <= 12)
    const byCell = new Map(candidate.pattern.cells.map(c => [c.y * 32 + c.x, c.colorId]))
    for (const y of [8, 12, 16, 20]) assert.notEqual(byCell.get(y * 32 + 11), byCell.get((y + 1) * 32 + 11))
    assert.notEqual(byCell.get(13 * 32 + 18), byCell.get(13 * 32 + 11))
    assert.ok(!byCell.has(26 * 32 + 26), 'preserve the concavity in the body mask')
    assert.ok(candidate.metrics.subjectCoverageIoU >= 0.95)
  })
  it('reserves the single ink even at a one-color limit and rejects unavailable non-black materials', async () => {
    const request = stripedRequest()
    const result = await createPatternAlgorithm().generate({ ...request, options: { ...request.options, maxColors: 1 } })
    const candidate = (result.recommended ?? result.bestEffort)!
    assert.equal(candidate.pattern.palette.length, 1)
    assert.ok(isDeepSaturatedInk(candidate.pattern.palette[0]!))
    await assert.rejects(() => createPatternAlgorithm().generate({ ...request, palette: { ...palette,
      inventory: Object.fromEntries(palette.colors.map(c => [c.id, c.id === 'H7' ? 10000 : 0])) } }), /non-black/)
  })
  it('restores a source-supported detail erased by cleanup but leaves facial and contour cells alone', () => {
    const colors = prepareColors(palette.colors)
    const reference = colors.find(c => c.id === 'G8')!, changed = colors.find(c => c.id === 'A1')!
    const result = preserveFillEvidence({ width: 2, activeMask: new Uint8Array([1, 1]), excludedCells: new Set([1]),
      sourceLabs: [reference.lab, reference.lab], referenceColorIds: ['G8', 'G8'], colorIds: ['A1', 'A1'], colors: [reference, changed] })
    assert.deepEqual(result.colorIds, ['G8', 'A1'])
    assert.equal(result.edits.length, 1)
  })
  it('keeps the previous outline behavior for other palette modes', async () => {
    const request = stripedRequest('generic-compatibility')
    const result = await createPatternAlgorithm().generate(request)
    const candidate = (result.recommended ?? result.bestEffort)!
    assert.equal(candidate.contourPlan!.colorPolicy, undefined)
    assert.equal(candidate.metrics.fillFidelityRestoredCells, undefined)
  })
})
