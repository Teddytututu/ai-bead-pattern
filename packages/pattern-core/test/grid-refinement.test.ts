import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { refineGridClusters } from '../src/experimental.js'
import type { Lab, MaterialColor } from '../src/index.js'

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
  })
})
