import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildPalettePlan,
  validatePalettePlan,
  type ResolvedFeaturePlacement,
  type StructurePlan,
  type ValuePlan,
} from '../src/experimental.js'
import type { MaterialColor } from '../src/index.js'

const colors: readonly MaterialColor[] = [20, 50, 80].map((value) => ({
  id: `gray-${value}`,
  name: `Gray ${value}`,
  hex: `#${value.toString(16).padStart(2, '0').repeat(3)}`,
  rgb: [value, value, value] as const,
  lab: [value, 0, 0] as const,
}))

function structurePlan(): StructurePlan {
  return {
    width: 3,
    height: 1,
    occupancy: { width: 3, height: 1, values: new Float32Array([1, 1, 1]) },
    sourceMapping: new Float32Array([0, 0, 1, 0, 2, 0]),
    regionIds: new Int32Array([0, 0, 0]),
    boundaryStrength: new Float32Array([0, 0, 0]),
    regions: [{ id: 0, importance: 1, cellIndices: [0, 1, 2], adjacentRegionIds: [] }],
    featureConstraints: [],
    confidence: 1,
  }
}

function valuePlan(): ValuePlan {
  return {
    roles: [
      { id: 'region-0:shadow', regionId: '0', kind: 'shadow', targetLightness: 20, minimumSeparation: 6, importance: 1 },
      { id: 'region-0:base', regionId: '0', kind: 'base', targetLightness: 50, minimumSeparation: 6, importance: 1 },
      { id: 'region-0:light', regionId: '0', kind: 'light', targetLightness: 80, minimumSeparation: 6, importance: 1 },
    ],
  }
}

describe('PalettePlan', () => {
  it('assigns ordered material colors to value roles within the global color limit', () => {
    const result = buildPalettePlan({
      valuePlan: valuePlan(),
      roleIdsByCell: ['region-0:shadow', 'region-0:base', 'region-0:light'],
      plannedLabs: [[20, 0, 0], [50, 0, 0], [80, 0, 0]],
      structurePlan: structurePlan(),
      colors,
      maximumColors: 3,
      distanceMethod: 'delta-e-2000',
      featurePlacements: [],
    })

    assert.doesNotThrow(() => validatePalettePlan(result.plan))
    assert.deepEqual(result.plan.selectedColorIds, ['gray-20', 'gray-50', 'gray-80'])
    assert.deepEqual(result.colorIds, ['gray-20', 'gray-50', 'gray-80'])
  })

  it('uses a shared subset when the material color budget is smaller than the role count', () => {
    const placement: ResolvedFeaturePlacement = {
      featureId: 'left-eye-center',
      kind: 'eye',
      templateId: 'eye-e1',
      center: [1, 0],
      occupiedCells: [1],
      roles: [{ cell: 1, role: 'eye-dark' }],
      shift: [0, 0],
      score: 1,
    }
    const result = buildPalettePlan({
      valuePlan: valuePlan(),
      roleIdsByCell: ['region-0:shadow', 'region-0:base', 'region-0:light'],
      plannedLabs: [[20, 0, 0], [50, 0, 0], [80, 0, 0]],
      structurePlan: structurePlan(),
      colors,
      maximumColors: 2,
      distanceMethod: 'delta-e-2000',
      featurePlacements: [placement],
    })

    assert.equal(result.plan.selectedColorIds.length, 2)
    assert.equal(result.plan.selectedColorIds.includes('gray-20'), true)
    assert.equal(new Set(result.colorIds).size <= 2, true)
    for (const colorId of Object.values(result.plan.assignments)) {
      assert.equal(result.plan.selectedColorIds.includes(colorId), true)
    }
  })

  it('charges incompatible selected colors against the higher-weight role', () => {
    const weightedStructure: StructurePlan = {
      width: 4,
      height: 1,
      occupancy: { width: 4, height: 1, values: new Float32Array([1, 1, 1, 1]) },
      sourceMapping: new Float32Array([0, 0, 1, 0, 2, 0, 3, 0]),
      regionIds: new Int32Array([0, 0, 0, 1]),
      boundaryStrength: new Float32Array(4),
      regions: [
        { id: 0, importance: 1, cellIndices: [0, 1, 2], adjacentRegionIds: [1] },
        { id: 1, importance: 0.5, cellIndices: [3], adjacentRegionIds: [0] },
      ],
      featureConstraints: [],
      confidence: 1,
    }
    const weightedValues: ValuePlan = {
      roles: [
        { id: 'region-0:base', regionId: '0', kind: 'base', targetLightness: 50, minimumSeparation: 6, importance: 1 },
        { id: 'region-1:base', regionId: '1', kind: 'base', targetLightness: 50, minimumSeparation: 6, importance: 0.5 },
      ],
    }
    const result = buildPalettePlan({
      valuePlan: weightedValues,
      roleIdsByCell: ['region-0:base', 'region-0:base', 'region-0:base', 'region-1:base'],
      plannedLabs: [[50, 70, 50], [50, 70, 50], [50, 70, 50], [50, 30, -70]],
      structurePlan: weightedStructure,
      colors: [
        { id: 'a-blue', name: 'Blue', hex: '#0044ff', rgb: [0, 68, 255], lab: [50, 30, -70] },
        { id: 'z-red', name: 'Red', hex: '#ff3300', rgb: [255, 51, 0], lab: [50, 70, 50] },
      ],
      maximumColors: 1,
      distanceMethod: 'delta-e-2000',
      featurePlacements: [],
    })

    assert.deepEqual(result.plan.selectedColorIds, ['z-red'])
  })
})
