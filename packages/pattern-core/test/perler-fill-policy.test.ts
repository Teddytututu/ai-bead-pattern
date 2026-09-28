import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createPatternAlgorithm } from '../src/index.js'
import type { MaterialPalette, PatternGenerationRequest, RGB } from '../src/types.js'

const palette = JSON.parse(readFileSync(new URL('../../../../assets/palettes/perler-123.json', import.meta.url), 'utf8')) as MaterialPalette
const black = palette.colors.find(color => color.name === 'Black')!
const white = palette.colors.find(color => color.name === 'White')!
const gray = palette.colors.find(color => color.name === 'Gray')!

function request(semantic: boolean): PatternGenerationRequest {
  const width = 32, height = 32, data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const rgb: RGB = (x === 10 || x === 20) && y >= 10 && y <= 12 ? black.rgb
      : x === 16 && y === 20 ? white.rgb : gray.rgb
    data.set([...rgb, 255], (y * width + x) * 4)
  }
  return { image: { width, height, data }, palette,
    ...(semantic ? { analysis: { confidence: 1, semanticRegions: [{ id: 'body', label: 'subject body',
      confidence: 1, mask: { width, height, values: new Float32Array(width * height).fill(1) } }] } } : {}),
    options: { width, height, maxColors: 3, maxCandidates: 1, styles: ['faithful'],
      structure: { valueMode: 'preserve', outlineMode: 'off', occupancyMode: 'full-frame' },
      optimization: { refinementMode: 'quality', paletteCoherence: 2, minRegionSize: 4, isolatedPixelPenalty: 1, stripePenalty: 1 } } }
}

describe('Perler 123 source fill', () => {
  for (const semantic of [false, true]) it(`keeps source-supported black and white details after cleanup (${semantic ? 'semantic' : 'plain'})`, async () => {
    const result = await createPatternAlgorithm().generate(request(semantic))
    const candidate = (result.recommended ?? result.bestEffort)!
    const byCell = new Map(candidate.pattern.cells.map(cell => [cell.y * 32 + cell.x, cell.colorId]))
    assert.equal(byCell.get(11 * 32 + 10), black.id, 'cleanup must retain the left dark stripe')
    assert.equal(byCell.get(11 * 32 + 20), black.id, 'cleanup must retain the right dark stripe')
    assert.equal(byCell.get(20 * 32 + 16), white.id, 'cleanup must retain the isolated light detail')
    assert.equal(candidate.pattern.cells.length, 32 * 32)
    assert.ok(candidate.pattern.palette.length <= 3)
    assert.ok(candidate.pattern.cells.every(cell => palette.colors.some(color => color.id === cell.colorId && color.automaticMatch !== false)))
    assert.ok(candidate.metrics.sourceMeanColorDistance < 0.5)
  })

  for (const sparse of [false, true]) it(`preserves an annotated low-contrast identity mark (${sparse ? 'sparse' : 'complete'} masks)`, async () => {
    const input = request(false), width = 32, height = 32, markCell = 16 * width + 16
    const body = palette.colors.find(color => color.name === 'Orchid')!
    const mark = palette.colors.find(color => color.name === 'Faded Rose')!
    const data = new Uint8ClampedArray(width * height * 4)
    for (let cell = 0; cell < width * height; cell++) data.set([...(cell === markCell ? mark.rgb : body.rgb), 255], cell * 4)
    const markMask = new Float32Array(width * height); markMask[markCell] = 1
    const bodyMask = new Float32Array(width * height).fill(1); bodyMask[markCell] = 0
    const analysis = { confidence: 1, semanticRegions: [
      ...(sparse ? [] : [{ id: 'body', label: 'subject body', confidence: 1, importance: 0.6,
        mask: { width, height, values: bodyMask } }]),
      { id: 'identity-mark', label: 'identity mark', confidence: 1, importance: 1, mask: { width, height, values: markMask } },
    ] }
    const result = await createPatternAlgorithm().generate({ ...input, image: { width, height, data }, analysis })
    const candidate = (result.recommended ?? result.bestEffort)!
    assert.equal(candidate.pattern.cells.find(cell => cell.x === 16 && cell.y === 16)!.colorId, mark.id)
  })

  it('keeps A0/A1 and other material catalogs outside the Perler repair', async () => {
    for (const baseline of ['a0', 'a1'] as const) {
      const input = request(false)
      const perler = await createPatternAlgorithm().generate({ ...input, options: { ...input.options, baseline } })
      const generic = await createPatternAlgorithm().generate({ ...input, palette: { ...palette, id: 'test-catalog' }, options: { ...input.options, baseline } })
      assert.deepEqual((perler.recommended ?? perler.bestEffort)!.pattern.cells, (generic.recommended ?? generic.bestEffort)!.pattern.cells)
      assert.equal((perler.recommended ?? perler.bestEffort)!.metrics.fillFidelityRestoredCells, undefined)
    }
  })
})
