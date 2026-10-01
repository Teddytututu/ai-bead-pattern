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

    confidence: 1,
  }
}

function semanticStructurePlan(): StructurePlan {
  return {
    width: 5,
    height: 1,
    occupancy: { width: 5, height: 1, values: new Float32Array([1, 1, 1, 1, 1]) },
    sourceMapping: new Float32Array([0, 0, 1, 0, 2, 0, 3, 0, 4, 0]),
    regionIds: new Int32Array([0, 1, 2, 3, 4]),
    boundaryStrength: new Float32Array([0, 0, 0, 0, 0]),
    regions: [
      { id: 0, sourceRegionId: 'face-skin', label: 'face skin', importance: 1, cellIndices: [0], adjacentRegionIds: [1, 2] },
      { id: 1, sourceRegionId: 'hair', label: 'hair', importance: 0.9, cellIndices: [1], adjacentRegionIds: [0] },
      { id: 2, sourceRegionId: 'eye', label: 'eye', importance: 1, cellIndices: [2], adjacentRegionIds: [0] },
      { id: 3, sourceRegionId: 'subject-body', label: 'subject body', importance: 0.9, cellIndices: [3], adjacentRegionIds: [4] },
      { id: 4, sourceRegionId: 'background', label: 'background', importance: 0.3, cellIndices: [4], adjacentRegionIds: [3] },
    ],

    confidence: 1,
  }
}

function outlinedSquareStructurePlan(): StructurePlan {
  const width = 5
  const height = 5
  const boundaryStrength = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        boundaryStrength[y * width + x] = 1
      }
    }
  }
  return {
    width,
    height,
    occupancy: { width, height, values: new Float32Array(width * height).fill(1) },
    sourceMapping: new Float32Array(width * height * 2),
    regionIds: new Int32Array(width * height),
    boundaryStrength,
    regions: [{
      id: 0,
      sourceRegionId: 'pet-body',
      label: 'pet body',
      importance: 0.8,
      cellIndices: Array.from({ length: width * height }, (_, index) => index),
      adjacentRegionIds: [],
    }],

    confidence: 1,
  }
}

function splitOutlineStructurePlan(sharedSourceRegion: boolean): StructurePlan {
  const width = 5
  const height = 5
  const regionIds = new Int32Array(width * height)
  const boundaryStrength = new Float32Array(width * height)
  const leftCells: number[] = []
  const rightCells: number[] = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cell = y * width + x
      const left = x < 2
      regionIds[cell] = left ? 0 : 1
      ;(left ? leftCells : rightCells).push(cell)
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1
        || x === 1 || x === 2) {
        boundaryStrength[cell] = 1
      }
    }
  }
  return {
    width,
    height,
    occupancy: { width, height, values: new Float32Array(width * height).fill(1) },
    sourceMapping: new Float32Array(width * height * 2),
    regionIds,
    boundaryStrength,
    regions: [
      {
        id: 0,
        sourceRegionId: 'pet-fur',
        label: 'pet fur shadow',
        importance: 0.8,
        cellIndices: leftCells,
        adjacentRegionIds: [1],
      },
      {
        id: 1,
        sourceRegionId: sharedSourceRegion ? 'pet-fur' : 'pet-muzzle',
        label: sharedSourceRegion ? 'pet fur light' : 'pet muzzle',
        importance: 0.8,
        cellIndices: rightCells,
        adjacentRegionIds: [0],
      },
    ],

    confidence: 1,
  }
}

describe('ValuePlan', () => {
  it('retains distinct local chroma and exactly bypasses all tones in preserve or zero strength', () => {
    const labs: Lab[] = [[50, 50, 30], [50, -20, -30], [5, 0, 0], [95, 0, 0]]
    for (const policy of [{ mode: 'preserve' as const }, { mode: 'stylized' as const, strength: 0 }]) {
      const result = buildValuePlan({ structurePlan: structurePlan(), pixelLabs: labs,
        activeMask: new Uint8Array(4).fill(1), levels: 3, outlineMode: 'off',
        lighting: { direction: [1, 0], intensity: 1, ambientLight: 1 }, materialByRegionId: { 'face-skin': 'metal' }, ...policy })
      assert.deepEqual(result.plannedLabs, labs)
      assert.equal(result.diagnostics.maximumNonOutlineDeltaE, 0)
    }
  })

  it('never averages opposing hues even when bounded enhancement is enabled', () => {
    const labs: Lab[] = [[50, 50, 30], [50, -20, -30], [50, 50, 30], [50, -20, -30]]
    const result = buildValuePlan({ structurePlan: structurePlan(), pixelLabs: labs, activeMask: new Uint8Array(4).fill(1), levels: 3 })
    assert.deepEqual(result.plannedLabs, labs)
  })

  it('does not brighten any interior cell when adding a full outline', () => {
    const input = { structurePlan: outlinedSquareStructurePlan(), pixelLabs: Array.from({ length: 25 }, () => [50, 0, 0] as Lab), activeMask: new Uint8Array(25).fill(1), levels: 3 as const }
    for (const mode of ['preserve', 'adaptive', 'stylized'] as const) {
      const off = buildValuePlan({ ...input, mode, outlineMode: 'off' })
      const full = buildValuePlan({ ...input, mode, outlineMode: 'full' })
      for (const cell of [6, 7, 8, 11, 12, 13, 16, 17, 18]) assert.deepEqual(full.plannedLabs[cell], off.plannedLabs[cell])
      assert.ok(full.plannedLabs[0]![0] < off.plannedLabs[0]![0])
    }
  })

  it('bounds a light eye on dark skin and ignores non-adjacent semantic regions', () => {
    const structure = semanticStructurePlan()
    const labs: Lab[] = [[35, 15, 10], [45, 0, 0], [70, 0, 0], [50, 0, 0], [50, 0, 0]]
    const input = { structurePlan: structure, pixelLabs: labs, activeMask: new Uint8Array(5).fill(1), levels: 3 as const }
    const adaptive = buildValuePlan(input)
    assert.ok(adaptive.plannedLabs[2]![0] >= 64)
    assert.ok(adaptive.diagnostics.maximumNonOutlineDeltaE <= 6)
    assert.deepEqual(buildValuePlan({ ...input, mode: 'preserve' }).plannedLabs, labs)
    for (const region of structure.regions) region.adjacentRegionIds = []
    assert.equal(buildValuePlan(input).diagnostics.semanticGaps.length, 0)
  })

  it('rejects invalid tonal controls and leaves inactive cells untouched', () => {
    const input = { structurePlan: structurePlan(), pixelLabs: Array.from({ length: 4 }, () => [50, 20, 10] as Lab), activeMask: new Uint8Array([1, 0, 1, 0]), levels: 3 as const }
    for (const strength of [-1, 1.01, NaN, Infinity]) assert.throws(() => buildValuePlan({ ...input, strength }), RangeError)
    const result = buildValuePlan({ ...input, mode: 'stylized', outlineMode: 'full' })
    assert.deepEqual(result.plannedLabs[1], input.pixelLabs[1])
    assert.deepEqual(result.plannedLabs[3], input.pixelLabs[3])
  })
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

  it('shares one value-role family across disconnected regions from the same source region', () => {
    const structure = structurePlan()
    structure.regionIds = new Int32Array([0, 0, 1, 1])
    structure.regions = [
      {
        ...structure.regions[0]!,
        id: 0,
        cellIndices: [0, 1],
        adjacentRegionIds: [1],
      },
      {
        ...structure.regions[0]!,
        id: 1,
        cellIndices: [2, 3],
        adjacentRegionIds: [0],
      },
    ]
    const result = buildValuePlan({
      structurePlan: structure,
      pixelLabs: [
        [20, 15, 12],
        [40, 15, 12],
        [60, 15, 12],
        [80, 15, 12],
      ] as readonly Lab[],
      activeMask: new Uint8Array([1, 1, 1, 1]),
      levels: 3,
    })

    assert.equal(result.plan.roles.length, 3)
    assert.equal(new Set(result.plan.roles.map((role) => role.regionId)).size, 1)
    assert.ok(new Set(result.roleIdsByCell.filter((role) => role !== undefined)).size <= 3)
  })

  it('keeps outline, deep shadow, shadow, base, and light in strict order at four levels', () => {
    const result = buildValuePlan({
      structurePlan: structurePlan(),
      pixelLabs: [
        [18, 0, 0],
        [42, 0, 0],
        [64, 0, 0],
        [86, 0, 0],
      ],
      activeMask: new Uint8Array([1, 1, 1, 1]),
      levels: 4,
    })

    const ordered = [...result.plan.roles].sort((first, second) =>
      first.targetLightness - second.targetLightness)
    assert.deepEqual(ordered.map((role) => role.kind), [
      'outline',
      'deep-shadow',
      'shadow',
      'base',
      'light',
    ])
    for (let index = 1; index < ordered.length; index += 1) {
      assert.ok(ordered[index]!.targetLightness - ordered[index - 1]!.targetLightness
        >= ordered[index]!.minimumSeparation)
    }
    assert.equal(result.diagnostics.roleOrderAccuracy, 1)
  })

  it('adds a one-cell full outline to a three-level value plan', () => {
    const structure = outlinedSquareStructurePlan()
    const result = buildValuePlan({
      structurePlan: structure,
      pixelLabs: Array.from({ length: 25 }, () => [62, 4, 3] as Lab),
      activeMask: new Uint8Array(25).fill(1),
      levels: 3,
      outlineMode: 'full',
      lighting: { direction: [-1, -1], intensity: 0.7, ambientLight: 0.25 },
    })
    const outline = result.plan.roles.find((role) => role.kind === 'outline')

    assert.ok(outline)
    assert.equal(result.roleIdsByCell.filter((roleId) => roleId === outline.id).length, 16)
    assert.notEqual(result.roleIdsByCell[12], outline.id)
    assert.equal(result.diagnostics.outline.mode, 'full')
    assert.equal(result.diagnostics.outline.selectedOutlineCells, 16)
  })

  it('keeps tonal regions from the same semantic source out of internal outlines', () => {
    const result = buildValuePlan({
      structurePlan: splitOutlineStructurePlan(true),
      pixelLabs: Array.from({ length: 25 }, (_, cell) =>
        [cell % 5 < 2 ? 34 : 70, 4, 3] as Lab),
      activeMask: new Uint8Array(25).fill(1),
      levels: 3,
      outlineMode: 'full',
    })

    assert.equal(result.diagnostics.outline.internalBoundaryCells, 0)
    assert.equal(result.diagnostics.outline.selectedOutlineCells, 16)
  })

  it('retains an internal outline between different semantic regions', () => {
    const result = buildValuePlan({
      structurePlan: splitOutlineStructurePlan(false),
      pixelLabs: Array.from({ length: 25 }, (_, cell) =>
        [cell % 5 < 2 ? 34 : 70, 4, 3] as Lab),
      activeMask: new Uint8Array(25).fill(1),
      levels: 3,
      outlineMode: 'full',
    })

    assert.equal(result.diagnostics.outline.internalBoundaryCells, 10)
    assert.equal(result.diagnostics.outline.selectedOutlineCells, 22)
  })

  it('removes the outline role when four-level planning explicitly selects off', () => {
    const result = buildValuePlan({
      structurePlan: outlinedSquareStructurePlan(),
      pixelLabs: Array.from({ length: 25 }, () => [62, 4, 3] as Lab),
      activeMask: new Uint8Array(25).fill(1),
      levels: 4,
      outlineMode: 'off',
    })

    assert.equal(result.plan.roles.some((role) => role.kind === 'outline'), false)
    assert.equal(result.diagnostics.outline.selectedOutlineCells, 0)
  })

  it('relaxes impossible semantic gaps instead of exceeding the source lightness budget', () => {
    const result = buildValuePlan({
      structurePlan: semanticStructurePlan(),
      pixelLabs: Array.from({ length: 5 }, () => [52, 0, 0] as Lab),
      activeMask: new Uint8Array([1, 1, 1, 1, 1]),
      levels: 3,
      minimumSemanticGaps: {
        eyeSkin: 18,
        faceHair: 12,
        subjectBackground: 14,
      },
    })
    const baseBySource = new Map(result.diagnostics.groups.map((group) => [
      group.sourceRegionId,
      result.plan.roles.find((role) => role.regionId === group.groupId && role.kind === 'base')!.targetLightness,
    ]))

    for (const lightness of baseBySource.values()) assert.ok(Math.abs(lightness - 52) <= 6)
    assert.ok(result.diagnostics.semanticGapAccuracy < 1)
    assert.ok(result.diagnostics.maximumNonOutlineLightnessShift <= 6)
    assert.ok(result.diagnostics.maximumNonOutlineDeltaE <= 6)
  })

  it('applies bounded light direction, ambient light, and material reflection adjustments', () => {
    const structure: StructurePlan = {
      width: 2,
      height: 1,
      occupancy: { width: 2, height: 1, values: new Float32Array([1, 1]) },
      sourceMapping: new Float32Array([0, 0, 1, 0]),
      regionIds: new Int32Array([0, 1]),
      boundaryStrength: new Float32Array([0, 0]),
      regions: [
        { id: 0, sourceRegionId: 'metal', label: 'metal', importance: 1, cellIndices: [0], adjacentRegionIds: [1] },
        { id: 1, sourceRegionId: 'fabric', label: 'fabric', importance: 1, cellIndices: [1], adjacentRegionIds: [0] },
      ],

      confidence: 1,
    }
    const baseline = buildValuePlan({
      structurePlan: structure,
      pixelLabs: [[50, 0, 0], [50, 0, 0]],
      activeMask: new Uint8Array([1, 1]),
      levels: 3,
    })
    const planned = buildValuePlan({
      structurePlan: structure,
      pixelLabs: [[50, 0, 0], [50, 0, 0]],
      activeMask: new Uint8Array([1, 1]),
      levels: 3,
      lighting: { direction: [-1, 0], intensity: 1, ambientLight: 1 },
      materialByRegionId: { metal: 'metal', fabric: 'fabric' },
    })
    const role = (result: typeof planned, source: string, kind: 'light' | 'shadow') => {
      const group = result.diagnostics.groups.find((entry) => entry.sourceRegionId === source)!
      return result.plan.roles.find((entry) => entry.regionId === group.groupId && entry.kind === kind)!
    }

    assert.ok(role(planned, 'metal', 'light').targetLightness
      > role(planned, 'fabric', 'light').targetLightness)
    assert.ok(role(planned, 'metal', 'shadow').targetLightness
      > role(baseline, 'metal', 'shadow').targetLightness)
    assert.ok(planned.diagnostics.maximumLightingAdjustment <= 4)
    assert.ok(planned.diagnostics.maximumMaterialAdjustment <= 5)
    assert.equal(planned.diagnostics.roleOrderAccuracy, 1)
  })
})
