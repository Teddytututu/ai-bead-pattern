import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { prepareColors } from '../src/color.js'
import { unifySilhouetteOutlineColor } from '../src/generation/candidate.js'

describe('silhouette outline color', () => {
  it('uses one darkest bead for the outside contour and keeps feature cells intact', () => {
    const palette = prepareColors([
      { id: 'warm-ink', name: 'Warm ink', hex: '#463b36', rgb: [70, 59, 54] },
      { id: 'black', name: 'Black', hex: '#151515', rgb: [21, 21, 21] },
      { id: 'base', name: 'Base', hex: '#d9a06f', rgb: [217, 160, 111] },
    ])
    const activeMask = new Uint8Array([
      0, 1, 1, 0,
      1, 1, 1, 1,
      1, 1, 1, 1,
      0, 1, 1, 0,
    ])
    const colorIds = [
      'base', 'warm-ink', 'base', 'base',
      'warm-ink', 'base', 'warm-ink', 'base',
      'base', 'warm-ink', 'base', 'warm-ink',
      'base', 'warm-ink', 'base', 'base',
    ]
    const result = unifySilhouetteOutlineColor(
      colorIds,
      palette,
      activeMask,
      4,
      4,
      new Set([1, 2, 4, 7, 8, 11, 13, 14]),
      new Set([1]),
    )

    assert.equal(result[1], 'warm-ink')
    assert.equal(result[2], 'black')
    assert.equal(result[4], 'black')
    assert.equal(result[7], 'black')
    assert.equal(result[8], 'black')
    assert.equal(result[11], 'black')
    assert.equal(result[13], 'black')
    assert.equal(result[14], 'black')
  })
})
