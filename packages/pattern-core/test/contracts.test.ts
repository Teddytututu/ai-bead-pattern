import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createPatternAlgorithm,
  type CanvasPlan,
  type FeatureConstraint,
  type PalettePlan,
  type StructurePlan,
  type ValuePlan,
} from '../src/index.js'

describe('V2 planning contracts', () => {
  it('exports staged planning data structures', () => {
    const feature: FeatureConstraint = {
      id: 'left-eye',
      kind: 'eye',
      sourceCenter: [10, 12],
      targetCenter: [4, 5],
      candidateTemplates: ['eye-1x1'],
      minimumCells: 1,
      maximumCells: 2,
      allowedShiftCells: 1,
      minimumContrastDeltaE: 18,
      hard: true,
      symmetryGroup: 'eyes',
    }
    const canvas: CanvasPlan = {
      id: '48-square',
      size: { width: 48, height: 48 },
      crop: { x: 0, y: 0, width: 100, height: 100 },
      occupancyMode: 'subject-shape',
      subjectCoverage: 0.7,
      estimatedBeads: 1_600,
      featureBudgets: [],
      score: {
        total: 0.8,
        feature: 0.9,
        subject: 0.8,
        composition: 0.8,
        boundary: 0.7,
        beadCost: 0.2,
        buildTimeCost: 0.2,
      },
    }
    const structure: StructurePlan = {
      width: 1,
      height: 1,
      occupancy: { width: 1, height: 1, values: new Float32Array([1]) },
      sourceMapping: new Float32Array([0, 0]),
      regionIds: new Int32Array([0]),
      boundaryStrength: new Float32Array([0]),
      regions: [],
      featureConstraints: [feature],
      confidence: 1,
    }
    const value: ValuePlan = { roles: [] }
    const palette: PalettePlan = {
      selectedColorIds: [],
      assignments: {},
      allowedColorIdsByRole: {},
      totalCost: 0,
    }

    assert.equal(canvas.size.width, 48)
    assert.equal(structure.featureConstraints[0]?.id, 'left-eye')
    assert.deepEqual(value.roles, [])
    assert.deepEqual(palette.selectedColorIds, [])
  })

  it('accepts an explicit engine selection', () => {
    assert.equal(createPatternAlgorithm({ engine: 'legacy' }).engine, 'legacy')
    assert.equal(createPatternAlgorithm({ engine: 'v2' }).engine, 'v2')
  })
})
