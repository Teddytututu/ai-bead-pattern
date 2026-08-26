import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createFeatureConstraint,
  searchFeaturePlacements,
  validateResolvedFeaturePlacement,
  type CanvasPlan,
  type FeatureBudget,
} from '../src/experimental.js'
import type { BinaryMask, ImageLandmark } from '../src/index.js'

function canvasPlan(): CanvasPlan {
  return {
    id: 'wide-48',
    size: { width: 48, height: 48 },
    crop: { x: 0, y: 0, width: 100, height: 50 },
    occupancyMode: 'full-frame',
    subjectCoverage: 0.5,
    estimatedBeads: 1_152,
    featureBudgets: [],
    feasible: true,
    rejectionReasons: [],
    score: {
      total: 1,
      feature: 1,
      subject: 1,
      composition: 1,
      boundary: 1,
      beadCost: 0.2,
      buildTimeCost: 0.2,
    },
  }
}

const eyeBudget: FeatureBudget = {
  featureId: 'left-eye-center',
  kind: 'eye',
  hard: true,
  minimumCells: 1,
  preferredCells: 2,
  maximumCells: 4,
  allocatedCells: 4,
  feasible: true,
  minimumContrast: 18,
  allowedShiftCells: 1,
  confidence: 0.95,
  symmetryGroup: 'eyes',
}

const eye: ImageLandmark = {
  id: 'left-eye-center',
  kind: 'eye',
  x: 50,
  y: 25,
  confidence: 0.95,
  priority: 'hard',
  symmetryGroup: 'eyes',
  affectsOccupancy: false,
}

function mask(width: number, height: number, active: readonly number[]): BinaryMask {
  const values = new Float32Array(width * height)
  for (const cell of active) values[cell] = 1
  return { width, height, values }
}

describe('feature placement search', () => {
  it('maps a wide source into the centered square content area without stretching', () => {
    const constraint = createFeatureConstraint(eyeBudget, eye, canvasPlan())
    const placements = searchFeaturePlacements({
      canvasPlan: canvasPlan(),
      budget: eyeBudget,
      landmark: eye,
    })

    assert.deepEqual(constraint.targetCenter, [24, 24])
    assert.ok(placements.length > 0)
    assert.deepEqual(placements[0]?.center, [24, 24])
    assert.doesNotThrow(() => validateResolvedFeaturePlacement(placements[0]!, canvasPlan().size))
  })

  it('uses carrier occupancy and blocked cells to choose a legal shifted placement', () => {
    const plan = canvasPlan()
    const idealCell = 24 * 48 + 24
    const legalCell = 24 * 48 + 25
    const placements = searchFeaturePlacements({
      canvasPlan: plan,
      budget: { ...eyeBudget, allocatedCells: 1, maximumCells: 1 },
      landmark: eye,
      carrierMask: mask(48, 48, [legalCell]),
      blockedCells: new Set([idealCell]),
    })

    assert.equal(placements[0]?.templateId, 'eye-e1')
    assert.deepEqual(placements[0]?.center, [25, 24])
    assert.deepEqual(placements[0]?.occupiedCells, [legalCell])
  })

  it('returns zero candidates when a hard feature has no legal carrier cells', () => {
    const placements = searchFeaturePlacements({
      canvasPlan: canvasPlan(),
      budget: { ...eyeBudget, allocatedCells: 1, maximumCells: 1 },
      landmark: eye,
      carrierMask: mask(48, 48, []),
    })

    assert.deepEqual(placements, [])
  })

  it('returns zero candidates for a landmark outside the selected crop', () => {
    const placements = searchFeaturePlacements({
      canvasPlan: canvasPlan(),
      budget: eyeBudget,
      landmark: { ...eye, x: 120 },
    })

    assert.deepEqual(placements, [])
  })
})
