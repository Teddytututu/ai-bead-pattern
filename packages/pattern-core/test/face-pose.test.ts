import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPatternAlgorithm, type FeatureOverride, type ImageLandmark, type PatternGenerationRequest } from '../src/index.js'
import { searchFaceFeatureGroup } from '../src/planning/face-feature-search.js'
import { searchFeaturePairs } from '../src/planning/feature-pair-search.js'
import { prepareFeatureEvidence, projectFeatureShape } from '../src/planning/feature-evidence.js'
import type { ResolvedFeaturePlacement } from '../src/planning/feature-placement.js'

function placement(id: string, center: readonly [number, number], score = 1, template = 'eye-e1'): ResolvedFeaturePlacement {
  const cell = center[1] * 32 + center[0]
  return { featureId: id, kind: 'eye', templateId: template, center, score, shift: [0, 0], occupiedCells: [cell], roles: [{ cell, role: 'eye-dark' }] }
}
function request(overrides: readonly FeatureOverride[] = [], landmarks: readonly ImageLandmark[] = []): PatternGenerationRequest {
  const data = new Uint8ClampedArray(32 * 32 * 4)
  for (let i = 0; i < 32 * 32; i++) data.set([215, 169, 140, 255], i * 4)
  // Material selection also sees the reference dark/highlight colors.
  data.set([0, 0, 0, 255], 0); data.set([255, 255, 255, 255], 4)
  return { image: { width: 32, height: 32, data }, palette: { id: 'pose', name: 'Pose', colors: [
    { id: 'skin', name: 'Skin', hex: '#d7a98c', rgb: [215, 169, 140] },
    { id: 'black', name: 'Black', hex: '#000000', rgb: [0, 0, 0] },
    { id: 'white', name: 'White', hex: '#ffffff', rgb: [255, 255, 255] },
  ] }, analysis: { landmarks }, options: { canvas: { mode: 'fixed', size: { width: 32, height: 32 } }, maxColors: 3,
    styles: ['faithful'], maxCandidates: 1, featureOverrides: overrides, structure: { outlineMode: 'off', occupancyMode: 'full-frame' } } }
}
async function generate(overrides: readonly FeatureOverride[], landmarks: readonly ImageLandmark[] = []) {
  const result = await createPatternAlgorithm().generate(request(overrides, landmarks))
  const candidate = result.recommended ?? result.bestEffort
  assert.ok(candidate)
  return candidate
}

describe('source-relative face pose', () => {
  it('allows the browser to yield without changing generation identity or final cells', async () => {
    const input = request([{ id: 'eye', kind: 'eye', x: 12, y: 10, templateId: 'eye-e1' }])
    const normal = await createPatternAlgorithm({ clock: () => 123 }).generate(input)
    let yielded = 0
    const scheduled = await createPatternAlgorithm({ clock: () => 123, yieldControl: async () => { yielded++ } }).generate(input)
    assert.ok(yielded > 1)
    assert.equal(normal.generationId, scheduled.generationId)
    assert.deepEqual((normal.recommended ?? normal.bestEffort)?.pattern, (scheduled.recommended ?? scheduled.bestEffort)?.pattern)
  })
  it('projects component shape axes and anchors through a nonuniform proposal frame', () => {
    const projected = projectFeatureShape({ widthPx: 10, heightPx: 2, angleDegrees: 90, anchors: [{ x: 10, y: 20 }] }, 0.5, 0.25, 3, 7)
    assert.equal(projected.widthPx, 2.5); assert.equal(projected.heightPx, 1)
    assert.equal(projected.angleDegrees, 90)
    assert.deepEqual(projected.anchors, [{ x: 7.75, y: 11.625 }])
  })
  it('ranks the original eye vector above an artificially level pair, without a shared-template bonus', () => {
    const result = searchFeaturePairs({ expectedLeftCenter: [8, 8], expectedRightCenter: [21, 11],
      leftCandidates: [placement('left', [8, 8])], rightCandidates: [placement('right', [21, 8]), placement('right', [21, 11], 0.95, 'eye-e2-h')] })
    assert.deepEqual(result[0]?.right.center, [21, 11])
    assert.equal(result[0]?.heightError, 0)
    assert.notEqual(result[0]?.left.templateId, result[0]?.right.templateId)
  })
  it('accepts vertically arranged eyes after a 90 degree roll', () => {
    const result = searchFeaturePairs({ expectedLeftCenter: [16, 7], expectedRightCenter: [16, 22],
      leftCandidates: [placement('left', [16, 7])], rightCandidates: [placement('right', [16, 22])] })
    assert.equal(result.length, 1)
    assert.equal(result[0]?.spacingError, 0)
  })
  it('jointly resolves a whole face without filling another component’s reserved space', () => {
    const first = { ...placement('left', [8, 8]), reservedCells: [8 * 32 + 9] }
    const result = searchFaceFeatureGroup([
      { featureId: 'left', expectedCenter: [8, 8], candidates: [first], hard: true },
      { featureId: 'right', expectedCenter: [11, 9], candidates: [placement('right', [9, 8]), placement('right', [11, 9], 0.9)], hard: true },
      { featureId: 'mouth', expectedCenter: [10, 15], candidates: [{ ...placement('mouth', [10, 15]), kind: 'mouth' }], hard: true },
    ])
    assert.equal(result.length, 3)
    assert.deepEqual(result.find(entry => entry.featureId === 'right')?.center, [11, 9])
  })
  it('preserves sloping anchors and different eye sizes through final cleanup', async () => {
    const candidate = await generate([
      { id: 'near-eye', kind: 'eye', x: 8, y: 9, templateId: 'eye-open-3x3' },
      { id: 'far-eye', kind: 'eye', x: 23, y: 14, templateId: 'eye-e1' },
    ])
    const near = candidate.featurePlacements!.find(entry => entry.featureId === 'near-eye')!
    const far = candidate.featurePlacements!.find(entry => entry.featureId === 'far-eye')!
    assert.deepEqual(near.center, [8, 9]); assert.deepEqual(far.center, [23, 14])
    assert.equal(near.occupiedCells.length, 5); assert.equal(far.occupiedCells.length, 1)
    assert.equal(candidate.metrics.hardFeatureCompleteness, 1)
    assert.ok(candidate.edits.some(edit => edit.reason === 'feature-placement'))
    for (const p of [near, far]) assert.ok(candidate.edits.every(edit => edit.reason === 'feature-placement' || !p.occupiedCells.includes(edit.y * 32 + edit.x)))
  })
  it('does not manufacture an occluded, hidden, or inferred second eye', async () => {
    const candidate = await generate([{ id: 'visible', kind: 'eye', x: 9, y: 12, templateId: 'eye-e2-h' },
      { id: 'hidden', kind: 'eye', x: 22, y: 10, hidden: true }], [
      { id: 'inferred', kind: 'eye', x: 24, y: 12, confidence: 0.9, priority: 'hard', observationState: 'inferred' },
    ])
    assert.deepEqual(candidate.featurePlacements!.map(entry => entry.featureId), ['visible'])
    assert.equal(candidate.metrics.hardFeatureCompleteness, 1)
  })
  it('rotates a larger manual template without collapsing cells, with locked center', async () => {
    const candidate = await generate([{ id: 'eye', kind: 'eye', x: 16, y: 16, templateId: 'eye-open-4x4',
      shape: { widthPx: 4, heightPx: 4, angleDegrees: 45 } }])
    const p = candidate.featurePlacements![0]!
    assert.equal(p.rotationDegrees, 45)
    assert.equal(p.occupiedCells.length, 12)
    assert.equal(new Set(p.occupiedCells).size, 12)
    assert.deepEqual(p.center, [16, 16])
    assert.equal(p.reservedCells?.some(cell => p.occupiedCells.includes(cell)), false)
  })
  it('collapses legacy mouth corners once per instance without changing the supplied analysis', () => {
    const landmarks = ['a', 'b'].flatMap(instanceId => [
      { id: `${instanceId}:mouth-left`, kind: 'mouth' as const, x: 10, y: 20, confidence: 1, priority: 'hard' as const, instanceId },
      { id: `${instanceId}:mouth-right`, kind: 'mouth' as const, x: 16, y: 23, confidence: 1, priority: 'hard' as const, instanceId },
    ])
    const original = request([], landmarks)
    const normalized = prepareFeatureEvidence(original)
    assert.equal(original.analysis?.landmarks?.length, 4)
    assert.equal(normalized.analysis?.landmarks?.length, 2)
    assert.ok(normalized.analysis?.landmarks?.every(entry => entry.x === 13 && entry.y === 21.5 && entry.featureShape?.anchors?.length === 2))
  })
  it('rejects conflicting manual template kind and invalid source coordinates', async () => {
    await assert.rejects(() => generate([{ id: 'mouth', kind: 'mouth', x: 12, y: 12, templateId: 'eye-e1' }]), /template/i)
    await assert.rejects(() => generate([{ id: 'eye', kind: 'eye', x: 32, y: 12 }]), /override/i)
  })
})
