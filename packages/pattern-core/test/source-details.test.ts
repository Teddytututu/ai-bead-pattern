import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPatternAlgorithm, projectFeatureShape, type PatternGenerationRequest } from '../src/index.js'

function request(size: number, painted = false): PatternGenerationRequest {
  const width = 256
  const data = new Uint8ClampedArray(width * width * 4)
  for (let i = 0; i < width * width; i++) data.set([216, 168, 136, 255], i * 4)
  if (painted) {
    for (const [left, top, w, h] of [[64, 80, 16, 8], [160, 96, 8, 16], [104, 168, 24, 8]]) {
      for (let y = top!; y < top! + h!; y++) for (let x = left!; x < left! + w!; x++) data.set([32, 32, 32, 255], (y * width + x) * 4)
    }
  }
  const mask = { width, height: width, values: new Float32Array(width * width).fill(1) }
  return {
    image: { width, height: width, data },
    palette: { id: 'source-details', name: 'Source details', colors: [
      { id: 'skin', name: 'Skin', hex: '#d8a888', rgb: [216, 168, 136] },
      { id: 'dark', name: 'Dark', hex: '#202020', rgb: [32, 32, 32] },
      { id: 'white', name: 'White', hex: '#ffffff', rgb: [255, 255, 255] },
    ] },
    analysis: { subjectMask: mask, confidence: 1,
      semanticRegions: [{ id: 'face', label: 'face skin', mask, confidence: 1 }],
      landmarks: [
        { id: 'left-eye', kind: 'eye', x: 68, y: 84, confidence: 1, priority: 'hard', gridRadiusCells: 0, observationState: 'observed', carrierRegionId: 'face', symmetryGroup: 'eyes' },
        { id: 'right-eye', kind: 'eye', x: 164, y: 100, confidence: 1, priority: 'hard', gridRadiusCells: 0, observationState: 'observed', carrierRegionId: 'face', symmetryGroup: 'eyes' },
        { id: 'mouth', kind: 'mouth', x: 108, y: 172, confidence: 1, priority: 'hard', gridRadiusCells: 0, observationState: 'observed', carrierRegionId: 'face' },
      ],
    },
    options: { canvas: { mode: 'fixed', size: { width: size, height: size } }, maxColors: 3,
      maxCandidates: 1, styles: ['faithful'], structure: { occupancyMode: 'full-frame', outlineMode: 'off', valueMode: 'preserve' },
      optimization: { refinementMode: 'quality' } },
  }
}

describe('source-only facial details', () => {
  for (const size of [32, 64]) {
    it(`does not paint eyes, mouth or highlights onto a uniform source at ${size} cells`, async () => {
      const result = await createPatternAlgorithm().generate(request(size))
      const candidate = result.recommended ?? result.bestEffort
      assert.ok(candidate)
      assert.deepEqual([...new Set(candidate.pattern.cells.map(cell => cell.colorId))], ['skin'])
      assert.equal(Object.hasOwn(candidate, 'featurePlacements'), false)
      assert.ok(candidate.edits.every(edit => edit.reason !== ('feature-placement' as string)))
    })
    it(`samples source eyes and mouth with the ordinary pixel cleanup at ${size} cells`, async () => {
      const input = request(size, true)
      const result = await createPatternAlgorithm().generate(input)
      const candidate = result.recommended ?? result.bestEffort
      assert.ok(candidate)
      const ordinary = await createPatternAlgorithm().generate({
        ...input, analysis: { ...input.analysis, landmarks: [] },
      })
      const sampled = ordinary.recommended ?? ordinary.bestEffort
      assert.ok(sampled)
      assert.deepEqual(candidate.pattern.cells, sampled.pattern.cells)
      assert.deepEqual(candidate.materialCounts, sampled.materialCounts)
      assert.equal(candidate.metrics.featureVisibilityConfidence, 0)
      assert.equal(candidate.pattern.cells.some(cell => cell.colorId === 'white'), false)
    })
  }
  it('keeps scheduling independent of generation identity and pixels', async () => {
    const input = request(32, true)
    const direct = await createPatternAlgorithm({ clock: () => 123 }).generate(input)
    let yields = 0
    const scheduled = await createPatternAlgorithm({ clock: () => 123, yieldControl: async () => { yields++ } }).generate(input)
    assert.ok(yields > 1)
    assert.equal(direct.generationId, scheduled.generationId)
    assert.deepEqual((direct.recommended ?? direct.bestEffort)?.pattern, (scheduled.recommended ?? scheduled.bestEffort)?.pattern)
  })
  it('preserves observed shape axes and anchors when projecting analysis', () => {
    const projected = projectFeatureShape({ widthPx: 10, heightPx: 2, angleDegrees: 90, anchors: [{ x: 10, y: 20 }] }, 0.5, 0.25, 3, 7)
    assert.equal(projected.widthPx, 2.5)
    assert.equal(projected.heightPx, 1)
    assert.equal(projected.angleDegrees, 90)
    assert.deepEqual(projected.anchors, [{ x: 7.75, y: 11.625 }])
  })
})
