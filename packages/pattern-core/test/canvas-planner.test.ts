import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  planCanvases,
  validateCanvasPlan,
  type CanvasPlanningInput,
} from '../src/experimental.js'
import type { BinaryMask, ImageLandmark } from '../src/index.js'

function solidMask(width: number, height: number, inset = 0): BinaryMask {
  return {
    width,
    height,
    values: Float32Array.from({ length: width * height }, (_, index) => {
      const x = index % width
      const y = Math.floor(index / width)
      return x >= inset && y >= inset && x < width - inset && y < height - inset ? 1 : 0
    }),
  }
}

function portraitInput(landmarks: readonly ImageLandmark[]): CanvasPlanningInput {
  return {
    image: { width: 96, height: 96 },
    analysis: {
      confidence: 1,
      subjectMask: solidMask(96, 96, 8),
      landmarks,
    },
    crop: { x: 0, y: 0, width: 96, height: 96 },
    candidates: [{ width: 12, height: 12 }, { width: 48, height: 48 }],
    occupancyMode: 'subject-shape',
  }
}

describe('V2 canvas planning', () => {
  it('allocates more feature cells when a larger canvas can express them', () => {
    const plans = planCanvases(portraitInput([
      { id: 'eye', kind: 'eye', x: 32, y: 34, confidence: 1, priority: 'hard' },
      { id: 'mouth', kind: 'mouth', x: 48, y: 58, confidence: 1, priority: 'hard' },
    ]))

    const smallEye = plans[0]!.featureBudgets.find((budget) => budget.featureId === 'eye')!
    const largeEye = plans[1]!.featureBudgets.find((budget) => budget.featureId === 'eye')!
    const smallMouth = plans[0]!.featureBudgets.find((budget) => budget.featureId === 'mouth')!
    const largeMouth = plans[1]!.featureBudgets.find((budget) => budget.featureId === 'mouth')!

    assert.ok(largeEye.allocatedCells > smallEye.allocatedCells)
    assert.ok(largeMouth.allocatedCells > smallMouth.allocatedCells)
    assert.ok(plans[1]!.score.feature > plans[0]!.score.feature)
  })

  it('marks paired hard features infeasible when they collapse into one cell', () => {
    const plans = planCanvases(portraitInput([
      { id: 'left-eye', kind: 'eye', x: 42, y: 34, confidence: 1, priority: 'hard', symmetryGroup: 'eyes' },
      { id: 'right-eye', kind: 'eye', x: 46, y: 34, confidence: 1, priority: 'hard', symmetryGroup: 'eyes' },
    ]))

    assert.equal(plans[0]!.featureBudgets.every((budget) => budget.feasible), false)
    assert.equal(plans[1]!.featureBudgets.every((budget) => budget.feasible), true)
  })

  it('turns hard feature infeasibility into a canvas veto with a specific reason', () => {
    const plans = planCanvases(portraitInput([
      { id: 'left-eye', kind: 'eye', x: 42, y: 34, confidence: 1, priority: 'hard', symmetryGroup: 'eyes' },
      { id: 'right-eye', kind: 'eye', x: 46, y: 34, confidence: 1, priority: 'hard', symmetryGroup: 'eyes' },
    ]))

    assert.equal(plans[0]!.feasible, false)
    assert.deepEqual(plans[0]!.rejectionReasons, ['canvas-hard-feature-collision'])
    assert.equal(plans[1]!.feasible, true)
    assert.deepEqual(plans[1]!.rejectionReasons, [])
    assert.ok(plans[0]!.featureBudgets.every((budget) => budget.hard))
  })

  it('keeps a soft underbudget feature as a score penalty', () => {
    const input = portraitInput([
      { id: 'face', kind: 'face-contour', x: 48, y: 42, confidence: 1, priority: 'soft' },
    ])
    const plan = planCanvases({
      ...input,
      candidates: [{ width: 4, height: 4 }],
    })[0]!

    assert.equal(plan.featureBudgets[0]!.feasible, false)
    assert.equal(plan.featureBudgets[0]!.hard, false)
    assert.equal(plan.feasible, true)
    assert.deepEqual(plan.rejectionReasons, [])
  })

  it('reports a multi-cell contour as infeasible on a tiny canvas', () => {
    const input = portraitInput([
      { id: 'face', kind: 'face-contour', x: 48, y: 42, confidence: 1, priority: 'hard' },
    ])
    const plans = planCanvases({
      ...input,
      candidates: [{ width: 4, height: 4 }, { width: 48, height: 48 }],
    })
    const small = plans[0]!.featureBudgets[0]!
    const large = plans[1]!.featureBudgets[0]!

    assert.ok(small.allocatedCells < small.minimumCells)
    assert.equal(small.feasible, false)
    assert.equal(large.feasible, true)
  })

  it('removes zero-confidence landmarks from feature-score normalization', () => {
    const eye = { id: 'eye', kind: 'eye', x: 32, y: 34, confidence: 1, priority: 'hard' } as const
    const base = planCanvases(portraitInput([eye]))
    const withUnknown = planCanvases(portraitInput([
      eye,
      { id: 'unknown-face', kind: 'face-contour', x: 48, y: 42, confidence: 0, priority: 'soft' },
    ]))

    assert.equal(withUnknown[0]!.score.feature, base[0]!.score.feature)
    assert.equal(withUnknown[1]!.score.feature, base[1]!.score.feature)
  })

  it('limits feature allocation to active subject cells near the landmark', () => {
    const mask = new Float32Array(96 * 96)
    for (let y = 8; y < 24; y += 1) {
      for (let x = 8; x < 24; x += 1) mask[y * 96 + x] = 1
    }
    const plan = planCanvases({
      image: { width: 96, height: 96 },
      analysis: {
        confidence: 1,
        subjectMask: { width: 96, height: 96, values: mask },
        landmarks: [{ id: 'eye', kind: 'eye', x: 72, y: 72, confidence: 1, priority: 'hard' }],
      },
      candidates: [{ width: 48, height: 48 }],
      occupancyMode: 'subject-shape',
    })[0]!

    assert.equal(plan.featureBudgets[0]!.allocatedCells, 0)
    assert.equal(plan.featureBudgets[0]!.feasible, false)
    assert.equal(plan.feasible, false)
    assert.deepEqual(plan.rejectionReasons, ['canvas-hard-feature-underbudget'])
  })

  it('uses subject occupancy to estimate bead count', () => {
    const shaped = planCanvases({
      image: { width: 20, height: 20 },
      analysis: { subjectMask: solidMask(20, 20, 5), confidence: 1 },
      candidates: [{ width: 20, height: 20 }],
      occupancyMode: 'subject-shape',
    })[0]!
    const full = planCanvases({
      image: { width: 20, height: 20 },
      analysis: { subjectMask: solidMask(20, 20, 5), confidence: 1 },
      candidates: [{ width: 20, height: 20 }],
      occupancyMode: 'full-frame',
    })[0]!

    assert.ok(shaped.estimatedBeads < full.estimatedBeads)
    assert.equal(shaped.subjectCoverage, full.subjectCoverage)
  })

  it('keeps the smallest sufficient canvas ahead when no feature needs more cells', () => {
    const plans = planCanvases({
      image: { width: 64, height: 64 },
      candidates: [{ width: 24, height: 24 }, { width: 48, height: 48 }, { width: 96, height: 96 }],
      occupancyMode: 'full-frame',
    })
    const ranked = [...plans].sort((first, second) => second.score.total - first.score.total)

    assert.deepEqual(ranked[0]!.size, { width: 24, height: 24 })
    assert.ok(plans[2]!.score.beadCost > plans[0]!.score.beadCost)
  })

  it('produces plans that satisfy the public V2 contract', () => {
    const input = portraitInput([
      { id: 'eye', kind: 'eye', x: 32, y: 34, confidence: 0.9, priority: 'hard' },
    ])
    const plans = planCanvases({ ...input, beadDiameterMm: 5 })

    assert.ok(plans.length > 0)
    for (const plan of plans) assert.doesNotThrow(() => validateCanvasPlan(plan))
    assert.equal(plans[0]!.estimatedWidthMm, 60)
    assert.equal(plans[1]!.estimatedHeightMm, 240)
  })

  it('rejects malformed planning input at the public boundary', () => {
    assert.throws(() => planCanvases({
      image: { width: 20, height: 20 },
      crop: { x: 0, y: 0, width: Number.NaN, height: 10 },
      candidates: [{ width: 12, height: 12 }],
    }), /crop/i)
    assert.throws(() => planCanvases({
      image: { width: 20, height: 20 },
      candidates: [],
    }), /candidate/i)
    assert.throws(() => planCanvases({
      image: { width: 20, height: 20 },
      candidates: [{ width: 97, height: 20 }],
    }), /processing limit/i)
    assert.throws(() => planCanvases({
      image: { width: 2, height: 1 },
      analysis: {
        subjectMask: { width: 2, height: 1, values: new Float32Array([1, Number.NaN]) },
      },
      candidates: [{ width: 12, height: 12 }],
    }), /mask values/i)
  })

  it('counts fitted content or the whole board according to occupancy mode', () => {
    const base = {
      image: { width: 20, height: 10 },
      candidates: [{ width: 20, height: 20 }],
    } as const
    const fitted = planCanvases({ ...base, occupancyMode: 'full-frame' })[0]!
    const solid = planCanvases({ ...base, occupancyMode: 'solid-background' })[0]!

    assert.equal(fitted.estimatedBeads, 200)
    assert.equal(solid.estimatedBeads, 400)
  })

  it('uses crop and occupancy identity in stable canvas plan ids', () => {
    const base = {
      image: { width: 40, height: 40 },
      candidates: [{ width: 24, height: 24 }],
    } as const
    const first = planCanvases({
      ...base,
      crop: { x: 0, y: 0, width: 30, height: 30 },
      occupancyMode: 'full-frame',
    })[0]!
    const repeated = planCanvases({
      ...base,
      crop: { x: 0, y: 0, width: 30, height: 30 },
      occupancyMode: 'full-frame',
    })[0]!
    const shifted = planCanvases({
      ...base,
      crop: { x: 5, y: 5, width: 30, height: 30 },
      occupancyMode: 'full-frame',
    })[0]!

    assert.equal(first.id, repeated.id)
    assert.notEqual(first.id, shifted.id)
  })
})
