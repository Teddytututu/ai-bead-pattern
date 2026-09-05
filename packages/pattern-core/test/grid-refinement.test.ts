import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { refineGridClusters } from '../src/experimental.js'
import { gridRefinementSchema } from '../src/grid-refinement.js'
import type { Lab, MaterialColor } from '../src/index.js'
import type { ResolvedFeaturePlacement } from '../src/planning/feature-placement.js'

const colors: readonly MaterialColor[] = [
  { id: 'red', name: 'Red', hex: '#ff0000', rgb: [255, 0, 0], lab: [55, 75, 55] },
  { id: 'blue', name: 'Blue', hex: '#0000ff', rgb: [0, 0, 255], lab: [35, 55, -85] },
]

const closeColors: readonly MaterialColor[] = [
  { id: 'dark', name: 'Dark', hex: '#777777', rgb: [119, 119, 119], lab: [50, 0, 0] },
  { id: 'light', name: 'Light', hex: '#787878', rgb: [120, 120, 120], lab: [51, 0, 0] },
]

function labs(size: number, value: Lab = [55, 75, 55]): readonly Lab[] {
  return Array.from({ length: size }, () => value)
}

function placement(
  featureId: string,
  cell: number,
  kind: ResolvedFeaturePlacement['kind'],
  role: ResolvedFeaturePlacement['roles'][number]['role'],
): ResolvedFeaturePlacement {
  return {
    featureId,
    kind,
    templateId: `${kind}-fixture`,
    center: [cell, 1],
    occupiedCells: [cell],
    roles: [{ cell, role }],
    shift: [0, 0],
    score: 1,
  }
}

function fragmentedArcCount(colorIds: readonly string[], width: number, height: number): number {
  const ring = [
    [-1, -1], [0, -1], [1, -1], [1, 0],
    [1, 1], [0, 1], [-1, 1], [-1, 0],
  ] as const
  let count = 0
  for (let y = 1; y + 1 < height; y += 1) {
    for (let x = 1; x + 1 < width; x += 1) {
      const centerId = colorIds[y * width + x]
      const matches = ring.map(([offsetX, offsetY]) => (
        colorIds[(y + offsetY) * width + x + offsetX] === centerId
      ))
      let transitions = 0
      for (let index = 0; index < matches.length; index += 1) {
        if (matches[index] !== matches[(index + 1) % matches.length]) transitions += 1
      }
      count += Math.max(0, transitions - 2)
    }
  }
  return count
}

describe('unified grid refinement', () => {
  it('pins the reviewed RAG and skeleton-branch sources', () => {
    assert.equal(gridRefinementSchema.id, 'semantic-rag-branch-refinement-v2')
    assert.deepEqual(gridRefinementSchema.sources, [
      'scikit-image/scikit-image@ee0a7a3ebd9ac8c2602f40e55bc015a3c8a81ae8',
      'jni/skan@94ec591f4a2763795b84141d6a85cb6fd0ab6b2a',
      'e-koch/FilFinder@bbb06edc167d177f61fccf600fb812fdf904ddb6',
    ])
    assert.deepEqual(gridRefinementSchema.licenses, ['BSD-3-Clause', 'BSD-3-Clause', 'MIT'])
  })

  it('removes an unsupported color when the unified energy improves', () => {
    const result = refineGridClusters({
      colorIds: [
        'red', 'red', 'red',
        'red', 'blue', 'red',
        'red', 'red', 'red',
      ],
      width: 3,
      height: 3,
      activeMask: new Uint8Array(9).fill(1),
      protectedCells: new Set(),
      pixelLabs: labs(9),
      colors,
      boundaryStrength: new Float32Array(9),
      importance: new Array(9).fill(0.5),
      featurePlacements: [],
      distanceMethod: 'delta-e-2000',
      mode: 'fast',
    })

    assert.equal(result.colorIds[4], 'red')
    assert.equal(result.changedCells, 1)
    assert.ok(result.energyAfter < result.energyBefore)
    assert.equal(result.diagnosticsBefore.smallComponents, 1)
    assert.equal(result.diagnosticsAfter.smallComponents, 0)
    assert.ok(result.diagnosticsAfter.singleCellBands <= result.diagnosticsBefore.singleCellBands)
  })

  it('keeps protected feature cells fixed', () => {
    const result = refineGridClusters({
      colorIds: [
        'red', 'red', 'red',
        'red', 'blue', 'red',
        'red', 'red', 'red',
      ],
      width: 3,
      height: 3,
      activeMask: new Uint8Array(9).fill(1),
      protectedCells: new Set([4]),
      pixelLabs: labs(9),
      colors,
      boundaryStrength: new Float32Array(9),
      importance: new Array(9).fill(0.5),
      featurePlacements: [],
      distanceMethod: 'delta-e-2000',
      mode: 'quality',
    })

    assert.equal(result.colorIds[4], 'blue')
  })

  it('locks model-planned eyes, nose, ear tips, mouth cells, and structural endpoints', () => {
    const featureCells = [12, 14, 16, 18, 20]
    const result = refineGridClusters({
      colorIds: Array.from({ length: 33 }, (_, cell) => featureCells.includes(cell) ? 'blue' : 'red'),
      width: 11,
      height: 3,
      activeMask: new Uint8Array(33).fill(1),
      protectedCells: new Set(),
      pixelLabs: labs(33),
      colors,
      boundaryStrength: new Float32Array(33),
      importance: new Array(33).fill(0),
      featurePlacements: [
        placement('left-eye', 12, 'eye', 'eye-dark'),
        placement('nose-tip', 14, 'nose', 'nose-base'),
        placement('left-ear-tip', 16, 'ear', 'ear-tip'),
        placement('left-mouth-corner', 18, 'mouth', 'mouth-dark'),
        placement('tail-tip', 20, 'custom', 'endpoint-dark'),
      ],
      distanceMethod: 'delta-e-2000',
      mode: 'quality',
    })

    assert.deepEqual(featureCells.map((cell) => result.colorIds[cell]), new Array(5).fill('blue'))
  })

  it('keeps a small color region when a strong boundary marks semantic separation', () => {
    const boundaryStrength = new Float32Array(9)
    boundaryStrength[4] = 1
    const result = refineGridClusters({
      colorIds: [
        'red', 'red', 'red',
        'red', 'blue', 'red',
        'red', 'red', 'red',
      ],
      width: 3,
      height: 3,
      activeMask: new Uint8Array(9).fill(1),
      protectedCells: new Set(),
      pixelLabs: labs(9),
      colors,
      boundaryStrength,
      importance: new Array(9).fill(0.4),
      featurePlacements: [],
      distanceMethod: 'delta-e-2000',
      mode: 'quality',
    })

    assert.equal(result.colorIds[4], 'blue')
    assert.equal(result.diagnosticsAfter.smallComponents, 1)
  })

  it('merges a weak two-cell region and removes its one-cell-wide color band', () => {
    const colorIds = [
      'dark', 'dark', 'dark', 'dark', 'dark',
      'dark', 'light', 'light', 'dark', 'dark',
      'dark', 'dark', 'dark', 'dark', 'dark',
    ]
    const result = refineGridClusters({
      colorIds,
      width: 5,
      height: 3,
      activeMask: new Uint8Array(15).fill(1),
      protectedCells: new Set(),
      pixelLabs: Array.from({ length: 15 }, () => [50, 0, 0] as Lab),
      colors: closeColors,
      boundaryStrength: new Float32Array(15),
      importance: new Array(15).fill(0.1),
      featurePlacements: [],
      distanceMethod: 'delta-e-2000',
      mode: 'quality',
    })

    assert.equal(result.diagnosticsBefore.smallComponents, 1)
    assert.ok(result.diagnosticsBefore.singleCellBands >= 2)
    assert.equal(result.diagnosticsAfter.smallComponents, 0)
    assert.equal(result.diagnosticsAfter.singleCellBands, 0)
    assert.deepEqual(result.colorIds, new Array(15).fill('dark'))
  })

  it('keeps the graph-diameter trunk and prunes a weak side branch', () => {
    const trunk = [2, 7, 12, 17, 22]
    const sideBranch = 13
    const darkCells = new Set([...trunk, sideBranch])
    const result = refineGridClusters({
      colorIds: Array.from({ length: 25 }, (_, cell) => darkCells.has(cell) ? 'dark' : 'light'),
      width: 5,
      height: 5,
      activeMask: new Uint8Array(25).fill(1),
      protectedCells: new Set(),
      pixelLabs: Array.from({ length: 25 }, () => [50.5, 0, 0] as Lab),
      colors: closeColors,
      boundaryStrength: new Float32Array(25),
      importance: new Array(25).fill(0.05),
      featurePlacements: [
        placement('line-start', trunk[0]!, 'custom', 'endpoint-dark'),
        placement('line-end', trunk.at(-1)!, 'custom', 'endpoint-dark'),
      ],
      distanceMethod: 'delta-e-2000',
      mode: 'quality',
    })

    assert.deepEqual(trunk.map((cell) => result.colorIds[cell]), new Array(trunk.length).fill('dark'))
    assert.equal(result.colorIds[sideBranch], 'light')
    assert.ok(result.diagnosticsAfter.localNoiseCells < result.diagnosticsBefore.localNoiseCells)
  })

  it('cleans a high-importance shade band while preserving a semantic endpoint path', () => {
    const width = 9
    const height = 7
    const shadeBand = [10, 11, 12, 13, 14]
    const structuralPath = [46, 47, 48, 49, 50]
    const darkCells = new Set([...shadeBand, ...structuralPath])
    const importance = new Array(width * height).fill(0.05)
    for (const cell of shadeBand) importance[cell] = 0.95

    const result = refineGridClusters({
      colorIds: Array.from({ length: width * height }, (_, cell) => (
        darkCells.has(cell) ? 'dark' : 'light'
      )),
      width,
      height,
      activeMask: new Uint8Array(width * height).fill(1),
      protectedCells: new Set(),
      pixelLabs: Array.from({ length: width * height }, () => [50.5, 0, 0] as Lab),
      colors: closeColors,
      boundaryStrength: new Float32Array(width * height),
      importance,
      featurePlacements: [
        placement('structure-start', structuralPath[0]!, 'custom', 'endpoint-dark'),
        placement('structure-end', structuralPath.at(-1)!, 'custom', 'endpoint-dark'),
      ],
      distanceMethod: 'delta-e-2000',
      mode: 'quality',
    })

    assert.deepEqual(
      shadeBand.map((cell) => result.colorIds[cell]),
      new Array(shadeBand.length).fill('light'),
    )
    assert.deepEqual(
      structuralPath.map((cell) => result.colorIds[cell]),
      new Array(structuralPath.length).fill('dark'),
    )
  })

  it('uses semantic endpoints rather than a longer nuisance branch to select the protected path', () => {
    const width = 7
    const height = 7
    const structuralPath = [8, 15, 22, 29, 36]
    const nuisanceBranch = [23, 24, 25, 26, 27]
    const darkCells = new Set([...structuralPath, ...nuisanceBranch])

    const result = refineGridClusters({
      colorIds: Array.from({ length: width * height }, (_, cell) => (
        darkCells.has(cell) ? 'dark' : 'light'
      )),
      width,
      height,
      activeMask: new Uint8Array(width * height).fill(1),
      protectedCells: new Set(),
      pixelLabs: Array.from({ length: width * height }, () => [51, 0, 0] as Lab),
      colors: closeColors,
      boundaryStrength: new Float32Array(width * height),
      importance: new Array(width * height).fill(0.05),
      featurePlacements: [
        placement('structure-start', structuralPath[0]!, 'custom', 'endpoint-dark'),
        placement('structure-end', structuralPath.at(-1)!, 'custom', 'endpoint-dark'),
      ],
      distanceMethod: 'delta-e-2000',
      mode: 'quality',
    })

    assert.deepEqual(
      structuralPath.map((cell) => result.colorIds[cell]),
      new Array(structuralPath.length).fill('dark'),
    )
  })

  for (const [size, branchLength] of [[32, 2], [48, 3], [64, 4]] as const) {
    it(`prunes a ${branchLength}-cell weak side branch at ${size}x${size}`, () => {
      const centerX = Math.floor(size / 2)
      const centerY = Math.floor(size / 2)
      const trunk = Array.from({ length: size - 8 }, (_, offset) => (offset + 4) * size + centerX)
      const sideBranch = Array.from({ length: branchLength }, (_, offset) => (
        centerY * size + centerX + offset + 1
      ))
      const darkCells = new Set([...trunk, ...sideBranch])
      const result = refineGridClusters({
        colorIds: Array.from({ length: size * size }, (_, cell) => darkCells.has(cell) ? 'dark' : 'light'),
        width: size,
        height: size,
        activeMask: new Uint8Array(size * size).fill(1),
        protectedCells: new Set(),
        pixelLabs: Array.from({ length: size * size }, () => [50.5, 0, 0] as Lab),
        colors: closeColors,
        boundaryStrength: new Float32Array(size * size),
        importance: new Array(size * size).fill(0.05),
        featurePlacements: [
          placement(`line-start-${size}`, trunk[0]!, 'custom', 'endpoint-dark'),
          placement(`line-end-${size}`, trunk.at(-1)!, 'custom', 'endpoint-dark'),
        ],
        distanceMethod: 'delta-e-2000',
        mode: 'quality',
      })

      assert.deepEqual(trunk.map((cell) => result.colorIds[cell]), new Array(trunk.length).fill('dark'))
      assert.deepEqual(sideBranch.map((cell) => result.colorIds[cell]), new Array(branchLength).fill('light'))
      assert.ok(result.diagnosticsAfter.singleCellBands < result.diagnosticsBefore.singleCellBands)
    })
  }

  it('keeps quality refinement deterministic and at least as low-energy as fast refinement', () => {
    const input = {
      colorIds: [
        'red', 'blue', 'red', 'blue',
        'blue', 'red', 'blue', 'red',
        'red', 'blue', 'red', 'blue',
        'blue', 'red', 'blue', 'red',
      ],
      width: 4,
      height: 4,
      activeMask: new Uint8Array(16).fill(1),
      protectedCells: new Set<number>(),
      pixelLabs: labs(16),
      colors,
      boundaryStrength: new Float32Array(16),
      importance: new Array(16).fill(0.2),
      featurePlacements: [],
      distanceMethod: 'delta-e-2000' as const,
    }
    const fast = refineGridClusters({ ...input, mode: 'fast' })
    const first = refineGridClusters({ ...input, mode: 'quality' })
    const second = refineGridClusters({ ...input, mode: 'quality' })

    assert.ok(first.energyAfter <= fast.energyAfter + 1e-6)
    assert.deepEqual(first.colorIds, second.colorIds)
    assert.equal(first.energyAfter, second.energyAfter)
  })

  it('reduces fragmented contour arcs when source colors are nearly equivalent', () => {
    const colorIds = [
      'light', 'dark', 'dark', 'light',
      'light', 'dark', 'light', 'light',
      'dark', 'dark', 'dark', 'dark',
      'dark', 'dark', 'dark', 'dark',
    ]
    const result = refineGridClusters({
      colorIds,
      width: 4,
      height: 4,
      activeMask: new Uint8Array(16).fill(1),
      protectedCells: new Set(),
      pixelLabs: colorIds.map((colorId) => colorId === 'dark' ? [50, 0, 0] : [51, 0, 0]),
      colors: closeColors,
      boundaryStrength: new Float32Array(16).fill(1),
      importance: new Array(16).fill(0),
      featurePlacements: [],
      distanceMethod: 'delta-e-2000',
      mode: 'quality',
    })

    assert.ok(fragmentedArcCount(result.colorIds, 4, 4) < fragmentedArcCount(colorIds, 4, 4))
    assert.ok(result.energyAfter < result.energyBefore)
    assert.ok(result.diagnosticsAfter.fragmentedArcSegments
      < result.diagnosticsBefore.fragmentedArcSegments)
  })

  it('uses quality budgets to reduce transition, dither, switch, and local-noise violations', () => {
    const colorIds = [
      'dark', 'light', 'dark', 'light',
      'light', 'dark', 'light', 'dark',
      'dark', 'light', 'dark', 'light',
      'light', 'dark', 'light', 'dark',
    ]
    const result = refineGridClusters({
      colorIds,
      width: 4,
      height: 4,
      activeMask: new Uint8Array(16).fill(1),
      protectedCells: new Set(),
      pixelLabs: Array.from({ length: 16 }, () => [50.5, 0, 0] as Lab),
      colors: closeColors,
      boundaryStrength: new Float32Array(16),
      importance: new Array(16).fill(0),
      featurePlacements: [],
      distanceMethod: 'delta-e-2000',
      mode: 'quality',
      budgets: {
        transitionCells: 0,
        ditherPatterns: 0,
        maximumColorSwitches: 0,
        localNoiseCells: 0,
      },
    })

    assert.ok(result.budgetViolationsBefore.total > 0)
    assert.ok(result.budgetViolationsAfter.total < result.budgetViolationsBefore.total)
    assert.ok(result.diagnosticsAfter.colorSwitches < result.diagnosticsBefore.colorSwitches)
    assert.ok(result.diagnosticsAfter.localNoiseCells <= result.diagnosticsBefore.localNoiseCells)
    assert.ok(result.diagnosticsAfter.ditherPatterns <= result.diagnosticsBefore.ditherPatterns)
  })

  it('treats a protected pixel-perfect diagonal as an outline transition instead of dithering', () => {
    const result = refineGridClusters({
      colorIds: [
        'dark', 'light',
        'light', 'dark',
      ],
      width: 2,
      height: 2,
      activeMask: new Uint8Array(4).fill(1),
      protectedCells: new Set([0, 3]),
      pixelLabs: [
        [50, 0, 0], [51, 0, 0],
        [51, 0, 0], [50, 0, 0],
      ],
      colors: closeColors,
      boundaryStrength: new Float32Array(4).fill(1),
      importance: new Array(4).fill(0),
      featurePlacements: [],
      distanceMethod: 'delta-e-2000',
      mode: 'quality',
      budgets: {
        transitionCells: 4,
        ditherPatterns: 0,
        maximumColorSwitches: 4,
        localNoiseCells: 4,
      },
    })

    assert.deepEqual(result.colorIds, ['dark', 'light', 'light', 'dark'])
    assert.equal(result.diagnosticsBefore.ditherPatterns, 0)
    assert.equal(result.diagnosticsBefore.protectedDiagonalTransitions, 1)
    assert.equal(result.diagnosticsAfter.protectedDiagonalTransitions, 1)
  })
})
