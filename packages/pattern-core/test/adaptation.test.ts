import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createPatternAlgorithm,
  type BeadPattern,
  type MaterialPalette,
} from '../src/index.js'

const palette: MaterialPalette = {
  id: 'adaptation',
  name: 'Adaptation',
  colors: [
    { id: 'red', name: 'Red', hex: '#ff0000', rgb: [255, 0, 0] },
    { id: 'blue', name: 'Blue', hex: '#0000ff', rgb: [0, 0, 255] },
  ],
}

const target: BeadPattern = {
  width: 3,
  height: 1,
  palette: palette.colors,
  cells: [
    { x: 0, y: 0, colorId: 'red' },
    { x: 1, y: 0, colorId: 'red' },
    { x: 2, y: 0, colorId: 'red' },
  ],
  metadata: {
    sourceWidth: 3,
    sourceHeight: 1,
    totalBeads: 3,
    generatedAt: 1,
    algorithmVersion: 'test',
    aiEnhanced: false,
    style: 'faithful',
    baseline: 'mvp',
  },
}

describe('handicraft pattern adaptation', () => {
  it('locks completed cells and replans editable neighbors around an observed mistake', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })

    const result = await algorithm.adapt({
      pattern: target,
      palette,
      fixedCells: [{ x: 1, y: 0, colorId: 'blue' }],
      editableMask: { width: 3, height: 1, values: new Float32Array([1, 0, 1]) },
      maxChangedCells: 2,
      coherence: 3,
    })

    assert.deepEqual(result.pattern.cells.map((cell) => cell.colorId), ['blue', 'blue', 'blue'])
    assert.equal(result.changes.length, 2)
    assert.equal(result.fixedCellsPreserved, 1)
  })

  it('rejects non-finite adaptation controls', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })

    await assert.rejects(() => algorithm.adapt({
      pattern: target,
      palette,
      fixedCells: [{ x: 1, y: 0, colorId: 'blue' }],
      coherence: Number.NaN,
    }), /coherence/)
  })
})
