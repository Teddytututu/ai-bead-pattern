import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildValuePlan,
  validateValuePlan,
  type StructurePlan,
} from '../src/experimental.js'
import type { Lab } from '../src/index.js'

function structurePlan(): StructurePlan {
  return {
    width: 4,
    height: 1,
    occupancy: { width: 4, height: 1, values: new Float32Array([1, 1, 1, 1]) },
    sourceMapping: new Float32Array([0, 0, 1, 0, 2, 0, 3, 0]),
    regionIds: new Int32Array([0, 0, 0, 0]),
    boundaryStrength: new Float32Array([0, 0, 0, 0]),
    regions: [{
      id: 0,
      sourceRegionId: 'face-skin',
      label: 'face-skin',
      importance: 0.9,
      cellIndices: [0, 1, 2, 3],
      adjacentRegionIds: [],
    }],
    featureConstraints: [],
    confidence: 1,
  }
}

describe('ValuePlan', () => {
  it('turns a region lightness range into ordered shadow, base, and light roles', () => {
    const result = buildValuePlan({
      structurePlan: structurePlan(),
      pixelLabs: [
        [20, 15, 12],
        [42, 15, 12],
        [61, 15, 12],
        [82, 15, 12],
      ] as readonly Lab[],
      activeMask: new Uint8Array([1, 1, 1, 1]),
      levels: 3,
    })

    assert.doesNotThrow(() => validateValuePlan(result.plan))
    const roles = [...result.plan.roles].sort((first, second) =>
      first.targetLightness - second.targetLightness)
    assert.deepEqual(roles.map((role) => role.kind), ['shadow', 'base', 'light'])
    assert.ok(roles[1]!.targetLightness - roles[0]!.targetLightness >= 6)
    assert.ok(roles[2]!.targetLightness - roles[1]!.targetLightness >= 6)
    assert.equal(result.roleIdsByCell[0], roles[0]!.id)
    assert.equal(result.roleIdsByCell[3], roles[2]!.id)
    assert.ok(result.plannedLabs[0]![0] < result.plannedLabs[3]![0])
  })

  it('keeps inactive cells outside the value-role assignment', () => {
    const structure = structurePlan()
    structure.occupancy = { width: 4, height: 1, values: new Float32Array([1, 1, 0, 0]) }
    structure.regionIds = new Int32Array([0, 0, -1, -1])
    structure.regions = [{
      ...structure.regions[0]!,
      cellIndices: [0, 1],
    }]
    const result = buildValuePlan({
      structurePlan: structure,
      pixelLabs: Array.from({ length: 4 }, () => [50, 0, 0] as Lab),
      activeMask: new Uint8Array([1, 1, 0, 0]),
      levels: 2,
    })

    assert.equal(result.roleIdsByCell[2], undefined)
    assert.equal(result.roleIdsByCell[3], undefined)
  })
})
