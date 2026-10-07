import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPatternAlgorithm, type ImageAnalysis, type PatternGenerationRequest } from '../src/index.js'
import { sourceSamplingAnalysis } from '../src/source-sampling-analysis.js'

function request(): PatternGenerationRequest {
  const width = 32
  const data = new Uint8ClampedArray(width * width * 4)
  const values = new Float32Array(width * width)
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const inside = x >= 3 && x < 29 && y >= 3 && y < 29
    values[y * width + x] = Number(inside)
    const color = inside ? (x === 10 && y === 10 ? 110 : 150) : 255
    data.set([color, color, color, 255], (y * width + x) * 4)
  }
  const mask = { width, height: width, values }
  return {
    image: { width, height: width, data },
    palette: { id: 'ordinary-sampling', name: 'Ordinary sampling', colors: [
      { id: 'gray', name: 'Gray', hex: '#969696', rgb: [150, 150, 150] },
      { id: 'dark', name: 'Dark', hex: '#6e6e6e', rgb: [110, 110, 110] },
      { id: 'white', name: 'White', hex: '#ffffff', rgb: [255, 255, 255] },
    ] },
    analysis: { confidence: 1, subjectMask: mask,
      semanticRegions: [{ id: 'body', label: 'subject body', mask, confidence: 1 }],
    },
    options: { width: 16, height: 16, maxColors: 2, styles: ['faithful'], maxCandidates: 1,
      structure: { occupancyMode: 'subject-shape', outlineMode: 'full', valueMode: 'preserve',
        contours: { external: true, internal: false } },
      optimization: { refinementMode: 'quality', minRegionSize: 4, paletteCoherence: 2 },
    },
  }
}

function facialAnalysis(base: ImageAnalysis): ImageAnalysis {
  const mask = { width: 32, height: 32,
    values: Float32Array.from({ length: 1024 }, (_, cell) => Number(cell === 10 * 32 + 10)) }
  return { ...base, semanticRegions: [...base.semanticRegions!,
    { id: 'left_eye', label: 'left eye', mask, confidence: 1, importance: 1 },
    { id: 'nose', label: '鼻子', mask, confidence: 1, importance: 1 },
    { id: 'mouth', label: 'mouth', mask, confidence: 1, importance: 1 },
  ], landmarks: [
    { id: 'left-eye', kind: 'eye', x: 10, y: 10, confidence: 1, priority: 'hard', gridRadiusCells: 2, featureRegionId: 'left_eye', carrierRegionId: 'body', observationState: 'observed' },
    { id: 'nose-tip', kind: 'nose', x: 16, y: 14, confidence: 1, priority: 'hard', gridRadiusCells: 2, featureRegionId: 'nose', carrierRegionId: 'body', observationState: 'observed' },
    { id: 'mouth', kind: 'mouth', x: 16, y: 21, confidence: 1, priority: 'hard', gridRadiusCells: 2, featureRegionId: 'mouth', carrierRegionId: 'body', observationState: 'observed' },
  ] }
}

describe('ordinary sampling of facial pixels', () => {
  it('filters iris and jaw guidance while keeping body evidence and valid region references', () => {
    const mask = { width: 1, height: 1, values: new Float32Array([1]) }
    const analysis: ImageAnalysis = {
      subjectMask: mask,
      semanticRegions: [
        { id: 'r1', label: 'iris', confidence: 1, mask },
        { id: 'r2', label: 'lower_jaw', confidence: 1, mask },
        { id: 'body', label: 'subject body', confidence: 1, mask },
      ],
      landmarks: [
        { id: 'p1', kind: 'custom', structuralRole: 'nose-tip', x: 0, y: 0, confidence: 1, priority: 'hard' },
        { id: 'p2', kind: 'body', structuralRole: 'lower-jaw', x: 0, y: 0, confidence: 1, priority: 'hard' },
        { id: 'shoulder', kind: 'body', structuralRole: 'shoulder', x: 0, y: 0, confidence: 1, priority: 'hard', carrierRegionId: 'r1' },
      ],
    }
    const active = sourceSamplingAnalysis(analysis)!
    assert.deepEqual(active.semanticRegions!.map(region => region.id), ['body'])
    assert.deepEqual(active.landmarks!.map(landmark => landmark.id), ['shoulder'])
    assert.equal(active.landmarks![0]!.carrierRegionId, undefined)
    assert.equal(active.subjectMask, mask)
    assert.equal(analysis.landmarks![2]!.carrierRegionId, 'r1')
  })
  for (const baseline of ['mvp', 'a0', 'a1'] as const) {
    it(`ignores eye/nose/mouth hints for generation, contours and rejection (${baseline})`, async () => {
      const input = request()
      input.options = { ...input.options, baseline }
      const algorithm = createPatternAlgorithm({ clock: () => 123 })
      const plain = await algorithm.generate(input)
      const annotated = await algorithm.generate({ ...input, analysis: facialAnalysis(input.analysis!) })
      const first = plain.recommended ?? plain.bestEffort
      const second = annotated.recommended ?? annotated.bestEffort
      assert.ok(first && second)
      assert.deepEqual(second.pattern, first.pattern)
      assert.deepEqual(second.materialCounts, first.materialCounts)
      assert.deepEqual(second.canvasPlan, first.canvasPlan)
      assert.deepEqual(second.contourPlan, first.contourPlan)
      assert.deepEqual(second.rejectionReasons, first.rejectionReasons)
      assert.equal(second.metrics.featureVisibilityConfidence, 0)
      assert.equal(annotated.generationId, plain.generationId)
    })
  }
  it('retains body landmarks and caller-owned analysis after filtering facial hints', async () => {
    const input = request()
    const analysis = facialAnalysis(input.analysis!)
    const body = { id: 'body-anchor', kind: 'body' as const, x: 16, y: 16, confidence: 1,
      priority: 'hard' as const, observationState: 'observed' as const }
    analysis.landmarks = [...analysis.landmarks!, body]
    const plain = await createPatternAlgorithm({ clock: () => 123 }).generate({
      ...input, analysis: { ...input.analysis, landmarks: [body] },
    })
    const result = await createPatternAlgorithm({ clock: () => 123 }).generate({ ...input, analysis })
    const candidate = result.recommended ?? result.bestEffort
    assert.ok(candidate)
    assert.deepEqual(candidate.pattern, (plain.recommended ?? plain.bestEffort)!.pattern)
    assert.ok(candidate.metrics.featureVisibilityConfidence > 0)
    assert.deepEqual(candidate.canvasPlan!.featureBudgets.map(budget => budget.featureId), ['body-anchor'])
    assert.equal(analysis.landmarks!.length, 4)
    assert.equal(analysis.semanticRegions!.length, 4)
    assert.equal(analysis.landmarks![0]!.featureRegionId, 'left_eye')
  })
})
