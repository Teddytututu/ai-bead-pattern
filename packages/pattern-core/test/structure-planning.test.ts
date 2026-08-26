import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildStructurePlan,
  validateStructurePlan,
  type ResolvedFeaturePlacement,
} from '../src/experimental.js'
import { sourcePointForGridCell } from '../src/image.js'
import type { Lab } from '../src/index.js'

function guidance(width: number, height: number) {
  return {
    width,
    height,
    importance: new Float32Array(width * height),
    edge: new Float32Array(width * height),
  }
}

function placement(cell: number): ResolvedFeaturePlacement {
  return {
    featureId: 'left-eye-center',
    kind: 'eye',
    templateId: 'eye-e1',
    center: [cell, 0],
    occupiedCells: [cell],
    roles: [{ cell, role: 'eye-dark' }],
    shift: [0, 0],
    score: 1,
  }
}

describe('StructurePlan', () => {
  it('builds symmetric adjacency between connected semantic regions', () => {
    const plan = buildStructurePlan({
      width: 4,
      height: 1,
      crop: { x: 0, y: 0, width: 4, height: 1 },
      fit: { x: 0, y: 0, width: 4, height: 1 },
      activeMask: new Uint8Array([1, 1, 1, 1]),
      pixelLabs: [
        [60, 20, 20], [60, 20, 20], [30, 0, 0], [30, 0, 0],
      ],
      semanticRegionIds: ['face-skin', 'face-skin', 'hair', 'hair'],
      importance: [0.8, 0.8, 0.7, 0.7],
      sourceGuidance: guidance(4, 1),
      featurePlacements: [],
      featureConstraints: [],
    })

    assert.equal(plan.regions.length, 2)
    assert.deepEqual(plan.regions[0]?.adjacentRegionIds, [1])
    assert.deepEqual(plan.regions[1]?.adjacentRegionIds, [0])
    assert.doesNotThrow(() => validateStructurePlan(plan))
  })

  it('merges a small same-semantic tone fragment while preserving a feature cell', () => {
    const labs: readonly Lab[] = [[70, 20, 20], [63, 20, 20], [70, 20, 20]]
    const common = {
      width: 3,
      height: 1,
      crop: { x: 0, y: 0, width: 3, height: 1 },
      fit: { x: 0, y: 0, width: 3, height: 1 },
      activeMask: new Uint8Array([1, 1, 1]),
      pixelLabs: labs,
      semanticRegionIds: ['face-skin', 'face-skin', 'face-skin'],
      importance: [0.5, 0.2, 0.5],
      sourceGuidance: guidance(3, 1),
      featureConstraints: [],
    }
    const merged = buildStructurePlan({ ...common, featurePlacements: [] })
    const protectedPlan = buildStructurePlan({ ...common, featurePlacements: [placement(1)] })

    assert.equal(merged.regions.length, 1)
    assert.ok(protectedPlan.regions.length > 1)
    assert.notEqual(protectedPlan.regionIds[1], protectedPlan.regionIds[0])
  })

  it('continues merging later regions when an earlier fragment has no legal target', () => {
    const plan = buildStructurePlan({
      width: 5,
      height: 1,
      crop: { x: 0, y: 0, width: 5, height: 1 },
      fit: { x: 0, y: 0, width: 5, height: 1 },
      activeMask: new Uint8Array([1, 1, 1, 1, 1]),
      pixelLabs: [
        [20, 0, 0],
        [70, 20, 20],
        [63, 20, 20],
        [70, 20, 20],
        [70, 20, 20],
      ],
      semanticRegionIds: ['hair', 'face-skin', 'face-skin', 'face-skin', 'face-skin'],
      importance: [0.5, 0.5, 0.2, 0.5, 0.5],
      sourceGuidance: guidance(5, 1),
      featurePlacements: [],
      featureConstraints: [],
      minimumRegionCells: 2,
    })

    assert.ok(
      plan.regionIds[2] === plan.regionIds[1] || plan.regionIds[2] === plan.regionIds[3],
      'The later face fragment should merge with a legal face neighbor',
    )
  })

  it('keeps bounded source mapping inside the proportional fitted content', () => {
    const sourceGuidance = guidance(8, 4)
    sourceGuidance.importance[1 * 8 + 3] = 1
    const plan = buildStructurePlan({
      width: 4,
      height: 4,
      crop: { x: 0, y: 0, width: 8, height: 4 },
      fit: { x: 0, y: 1, width: 4, height: 2 },
      activeMask: new Uint8Array([
        0, 0, 0, 0,
        1, 1, 1, 1,
        1, 1, 1, 1,
        0, 0, 0, 0,
      ]),
      pixelLabs: Array.from({ length: 16 }, () => [50, 0, 0] as Lab),
      semanticRegionIds: new Array(16).fill('subject'),
      importance: new Array(16).fill(0.5),
      sourceGuidance,
      featurePlacements: [],
      featureConstraints: [],
      maximumSourceShiftCells: 0.4,
    })
    const cell = 1 * 4 + 1
    const mappedX = plan.sourceMapping[cell * 2]!
    const mappedY = plan.sourceMapping[cell * 2 + 1]!

    assert.ok(mappedX >= 2.5 && mappedX <= 3.3)
    assert.ok(mappedY >= 0.5 && mappedY <= 1.3)
    assert.equal(plan.regionIds[0], -1)
  })

  it('limits each source mapping displacement to the configured cell radius', () => {
    const sourceGuidance = guidance(30, 30)
    sourceGuidance.importance[18 * 30 + 18] = 1
    const crop = { x: 0, y: 0, width: 30, height: 30 }
    const fit = { x: 0, y: 0, width: 3, height: 3 }
    const plan = buildStructurePlan({
      width: 3,
      height: 3,
      crop,
      fit,
      activeMask: new Uint8Array(9).fill(1),
      pixelLabs: Array.from({ length: 9 }, () => [50, 0, 0] as Lab),
      semanticRegionIds: new Array(9).fill('subject'),
      importance: new Array(9).fill(0.5),
      sourceGuidance,
      featurePlacements: [],
      featureConstraints: [],
      maximumSourceShiftCells: 0.35,
    })
    const cell = 4
    const sourcePoint = sourcePointForGridCell(crop, fit, 1, 1)!
    const deltaCells = Math.hypot(
      (plan.sourceMapping[cell * 2]! - sourcePoint[0]) / (crop.width / fit.width),
      (plan.sourceMapping[cell * 2 + 1]! - sourcePoint[1]) / (crop.height / fit.height),
    )

    assert.ok(deltaCells <= 0.35 + 1e-6, `Source mapping moved ${deltaCells} cells`)
  })

  it('keeps feature placement cells fixed in the source mapping', () => {
    const sourceGuidance = guidance(30, 30)
    sourceGuidance.importance[18 * 30 + 18] = 1
    const crop = { x: 0, y: 0, width: 30, height: 30 }
    const fit = { x: 0, y: 0, width: 3, height: 3 }
    const plan = buildStructurePlan({
      width: 3,
      height: 3,
      crop,
      fit,
      activeMask: new Uint8Array(9).fill(1),
      pixelLabs: Array.from({ length: 9 }, () => [50, 0, 0] as Lab),
      semanticRegionIds: new Array(9).fill('face-skin'),
      importance: new Array(9).fill(0.5),
      sourceGuidance,
      featurePlacements: [placement(4)],
      featureConstraints: [],
      maximumSourceShiftCells: 0.35,
    })
    const sourcePoint = sourcePointForGridCell(crop, fit, 1, 1)!

    assert.ok(Math.abs(plan.sourceMapping[8]! - sourcePoint[0]) < 1e-6)
    assert.ok(Math.abs(plan.sourceMapping[9]! - sourcePoint[1]) < 1e-6)
  })
})
