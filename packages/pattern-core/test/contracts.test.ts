import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createPatternAlgorithm,
} from '../src/index.js'
import {
  validateCandidateMetricsV2,
  validateCanvasPlan,
  validatePalettePlan,
  validateStructurePlan,
  validateValuePlan,
  type CanvasPlan,
  type FeatureConstraint,
  type PalettePlan,
  type CandidateMetricsV2,
  type StructurePlan,
  type ValuePlan,
} from '../src/experimental.js'

describe('V2 planning contracts', () => {
  it('exports staged planning data structures', () => {
    const feature: FeatureConstraint = {
      id: 'left-eye',
      kind: 'eye',
      sourceCenter: [10, 12],
      targetCenter: [0, 0],
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
      regionIds: new Int32Array([-1]),
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
    assert.doesNotThrow(() => validateCanvasPlan(canvas))
    assert.doesNotThrow(() => validateStructurePlan(structure))
    assert.doesNotThrow(() => validateValuePlan(value))
    assert.doesNotThrow(() => validatePalettePlan(palette))
  })

  it('rejects inconsistent staged planning contracts', () => {
    const invalidCanvas: CanvasPlan = {
      id: 'invalid',
      size: { width: 8, height: 8 },
      crop: { x: 0, y: 0, width: 10, height: 10 },
      occupancyMode: 'subject-shape',
      subjectCoverage: 0.5,
      estimatedBeads: 20,
      featureBudgets: [{
        featureId: 'eye',
        kind: 'eye',
        minimumCells: 4,
        preferredCells: 2,
        maximumCells: 3,
        minimumContrast: 12,
        allowedShiftCells: 1,
        confidence: 1,
      }],
      score: {
        total: 0.5,
        feature: 0.5,
        subject: 0.5,
        composition: 0.5,
        boundary: 0.5,
        beadCost: 0.5,
        buildTimeCost: 0.5,
      },
    }
    const invalidStructure: StructurePlan = {
      width: 2,
      height: 2,
      occupancy: { width: 2, height: 2, values: new Float32Array([1, 1, 1, 1]) },
      sourceMapping: new Float32Array([0, 0]),
      regionIds: new Int32Array([0, 0, 0, 0]),
      boundaryStrength: new Float32Array([0, 0, 0, 2]),
      regions: [],
      featureConstraints: [],
      confidence: 1,
    }

    assert.throws(() => validateCanvasPlan(invalidCanvas), /Feature budget/)
    assert.throws(() => validateStructurePlan(invalidStructure), /sourceMapping/)
  })

  it('exposes only the implemented baseline engine', () => {
    assert.equal(createPatternAlgorithm().engine, 'baseline')
  })

  it('rejects inconsistent region graphs and feature constraints', () => {
    const structure: StructurePlan = {
      width: 2,
      height: 1,
      occupancy: { width: 2, height: 1, values: new Float32Array([1, 1]) },
      sourceMapping: new Float32Array([0, 0, 1, 0]),
      regionIds: new Int32Array([0, 1]),
      boundaryStrength: new Float32Array([1, 1]),
      regions: [
        { id: 0, importance: 1, cellIndices: [0, 1], adjacentRegionIds: [0, 1] },
        { id: 1, importance: 1, cellIndices: [1], adjacentRegionIds: [] },
      ],
      featureConstraints: [
        {
          id: 'eye',
          kind: 'eye',
          sourceCenter: [0, 0],
          targetCenter: [2, 0],
          candidateTemplates: [],
          minimumCells: 1,
          maximumCells: 1,
          allowedShiftCells: -1,
          minimumContrastDeltaE: -1,
          hard: true,
        },
      ],
      confidence: 1,
    }

    assert.throws(() => validateStructurePlan(structure), /region|cell|adjacen|template|target|shift|contrast/i)
  })

  it('validates value, palette, and candidate metric contracts', () => {
    const invalidValue: ValuePlan = {
      roles: [{
        id: 'base',
        regionId: 'face',
        kind: 'base',
        targetLightness: Number.NaN,
        minimumSeparation: 0,
        importance: 1,
      }],
    }
    const invalidPalette: PalettePlan = {
      selectedColorIds: ['red', 'red'],
      assignments: { base: 'blue' },
      allowedColorIdsByRole: { base: ['red'] },
      totalCost: -1,
    }
    const metric = { value: 0.5, confidence: 1, available: true }
    const invalidMetrics: CandidateMetricsV2 = {
      sourceFidelity: metric,
      featureVisibility: metric,
      silhouetteQuality: metric,
      semanticBoundaryQuality: metric,
      regionAdjacencyPreservation: metric,
      valueOrderAccuracy: metric,
      paletteRoleConsistency: metric,
      clusterCleanliness: metric,
      symmetryQuality: metric,
      craftComplexity: metric,
      estimatedBuildMinutes: { value: -1, confidence: 1, available: true },
    }

    assert.throws(() => validateValuePlan(invalidValue), /Value role/)
    assert.throws(() => validatePalettePlan(invalidPalette), /Palette/)
    assert.throws(() => validateCandidateMetricsV2(invalidMetrics), /metric/)
  })
})
