import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { enforcePaletteInventory, quantizePalette } from '../src/experimental.js'
import type { MaterialColor } from '../src/index.js'

const colors: readonly MaterialColor[] = [
  { id: 'red', name: 'Red', hex: '#ff0000', rgb: [255, 0, 0], lab: [53, 80, 67] },
  { id: 'gray', name: 'Gray', hex: '#808080', rgb: [128, 128, 128], lab: [53, 0, 0] },
  { id: 'blue', name: 'Blue', hex: '#0000ff', rgb: [0, 0, 255], lab: [32, 79, -108] },
]

describe('palette quantizer', () => {
  it('keeps a required color and honors finite stock on the ordinary image path', () => {
    const result = quantizePalette({
      pixels: [[255, 0, 0], [255, 0, 0], [128, 128, 128]],
      pixelLabs: [[53, 80, 67], [53, 80, 67], [53, 0, 0]],
      weights: [3, 2, 1],
      colors,
      maximumColors: 2,
      baseline: 'mvp',
      distanceMethod: 'delta-e-2000',
      requiredColorIds: ['red'],
      inventory: { red: 1, gray: 2, blue: 0 },
    })

    assert.deepEqual(result.selectedColors.map((color) => color.id), ['red', 'gray'])
    assert.deepEqual(result.colorIds, ['red', 'gray', 'gray'])
  })

  it('counts active cells for inventory capacity while preserving a complete grid result', () => {
    const result = quantizePalette({
      pixels: [[255, 0, 0], [0, 0, 0], [0, 0, 0]],
      pixelLabs: [[53, 80, 67], [0, 0, 0], [0, 0, 0]],
      weights: [1, 1, 1],
      colors: [colors[0]!],
      maximumColors: 1,
      baseline: 'mvp',
      distanceMethod: 'delta-e-2000',
      activeMask: new Uint8Array([1, 0, 0]),
      inventory: { red: 1 },
    })

    assert.deepEqual(result.colorIds, ['red', 'red', 'red'])
  })

  it('rejects stock that cannot cover active cells', () => {
    assert.throws(() => quantizePalette({
      pixels: [[255, 0, 0], [255, 0, 0]],
      pixelLabs: [[53, 80, 67], [53, 80, 67]],
      weights: [1, 1],
      colors: [colors[0]!],
      maximumColors: 1,
      baseline: 'mvp',
      distanceMethod: 'delta-e-2000',
      inventory: { red: 1 },
    }), /inventory/i)
  })

  it('repairs finite-stock overflow introduced by later grid cleanup', () => {
    const result = enforcePaletteInventory({
      colorIds: ['red', 'red', 'gray'],
      width: 3,
      colors: [colors[0]!, colors[1]!].map((color) => ({ ...color, lab: color.lab! })),
      pixelLabs: [[53, 80, 67], [53, 80, 67], [53, 0, 0]],
      activeMask: new Uint8Array([1, 1, 1]),
      importance: [2, 0.1, 1],
      protectedCells: new Set([0]),
      inventory: { red: 1, gray: 2 },
    })

    assert.equal(result.valid, true)
    assert.deepEqual(result.colorIds, ['red', 'gray', 'gray'])
    assert.deepEqual(result.edits.map((edit) => [edit.x, edit.y, edit.reason]), [[1, 0, 'inventory']])
  })

  it('keeps distinct full precision distance matrices in a shared cache', () => {
    const cache = new Map()
    const input: Parameters<typeof quantizePalette>[0] = {
      pixels: [[128, 128, 128]],
      pixelLabs: [[53, 0, 0]],
      weights: [1],
      colors: [colors[1]!],
      maximumColors: 1,
      baseline: 'mvp' as const,
      distanceMethod: 'delta-e-2000' as const,
      distanceMatrixCache: cache,
    }
    quantizePalette(input)
    quantizePalette({ ...input, pixelLabs: [[53.0004, 0, 0]] })
    assert.equal(cache.size, 2)
  })

  it('uses a globally feasible assignment when nearest colours exceed stock', () => {
    const result = quantizePalette({
      pixels: [[255, 0, 0], [255, 0, 0], [128, 128, 128]],
      pixelLabs: [[53, 80, 67], [53, 80, 67], [53, 0, 0]],
      weights: [3, 1, 1],
      colors,
      maximumColors: 3,
      baseline: 'mvp',
      distanceMethod: 'delta-e-2000',
      inventory: { red: 1, gray: 1, blue: 1 },
    })
    const usage = result.colorIds.reduce<Record<string, number>>((counts, id) => {
      counts[id] = (counts[id] ?? 0) + 1
      return counts
    }, {})
    assert.deepEqual(usage, { red: 1, gray: 1, blue: 1 })
  })

  it('solves constrained cells globally instead of consuming a scarce colour greedily', () => {
    const result = quantizePalette({
      pixels: [[255, 0, 0], [128, 128, 128]],
      pixelLabs: [[53, 80, 67], [53, 0, 0]],
      weights: [1, 1],
      colors,
      maximumColors: 2,
      baseline: 'mvp',
      distanceMethod: 'delta-e-2000',
      inventory: { red: 1, gray: 1, blue: 0 },
      allowedColorIdsByCell: [new Set(['red', 'gray']), new Set(['red'])],
    })
    assert.deepEqual(result.colorIds, ['gray', 'red'])
  })

  it('isolates cache entries when edit penalties or substitutions change', () => {
    const cache = new Map()
    const base: Parameters<typeof quantizePalette>[0] = {
      pixels: [[255, 0, 0]],
      pixelLabs: [[53, 80, 67]],
      weights: [1],
      colors: [colors[0]!, colors[1]!],
      maximumColors: 2,
      baseline: 'mvp' as const,
      distanceMethod: 'delta-e-2000' as const,
      initialColorIds: ['gray'],
      distanceMatrixCache: cache,
    }
    quantizePalette({ ...base, editPenalty: 1 })
    quantizePalette({ ...base, editPenalty: 2 })
    quantizePalette({ ...base, editPenalty: 2, substituteColorIds: { gray: ['red'] } })
    assert.equal(cache.size, 3)
  })
})
