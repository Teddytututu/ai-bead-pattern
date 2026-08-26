import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createPatternAlgorithm,
  type MaterialPalette,
  type PixelImage,
} from '../src/index.js'
import { validateStructurePlan } from '../src/experimental.js'

const palette: MaterialPalette = {
  id: 'feature-test',
  name: 'Feature test',
  colors: [
    { id: 'black', name: 'Black', hex: '#000000', rgb: [0, 0, 0] },
    { id: 'skin', name: 'Skin', hex: '#d7a98c', rgb: [215, 169, 140] },
    { id: 'white', name: 'White', hex: '#ffffff', rgb: [255, 255, 255] },
  ],
}

function portrait(): PixelImage {
  const width = 16
  const height = 16
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 215
    data[index * 4 + 1] = 169
    data[index * 4 + 2] = 140
    data[index * 4 + 3] = 255
  }
  return { width, height, data }
}

describe('feature planning pipeline integration', () => {
  it('resolves eyes and mouth before cleanup and protects every occupied feature cell', async () => {
    const source = portrait()
    const faceValues = new Float32Array(source.width * source.height).fill(1)
    const result = await createPatternAlgorithm().generate({
      image: source,
      palette,
      analysis: {
        subjectMask: { width: source.width, height: source.height, values: faceValues },
        semanticRegions: [{
          id: 'face-skin',
          label: 'face-skin',
          mask: { width: source.width, height: source.height, values: faceValues },
          confidence: 1,
        }],
        landmarks: [
          { id: 'left-eye-center', kind: 'eye', x: 5, y: 6, confidence: 1, priority: 'hard', symmetryGroup: 'eyes', carrierRegionId: 'face-skin' },
          { id: 'right-eye-center', kind: 'eye', x: 11, y: 6, confidence: 1, priority: 'hard', symmetryGroup: 'eyes', carrierRegionId: 'face-skin' },
          { id: 'mouth-center', kind: 'mouth', x: 8, y: 10, confidence: 1, priority: 'hard', carrierRegionId: 'face-skin' },
        ],
      },
      options: {
        canvas: { mode: 'fixed', size: { width: 16, height: 16 } },
        structure: { occupancyMode: 'full-frame' },
        maxColors: 3,
        maxCandidates: 1,
        styles: ['simple'],
      },
    })
    const candidate = result.recommended ?? result.bestEffort
    assert.ok(candidate !== undefined)
    assert.ok(candidate.structurePlan !== undefined)
    assert.doesNotThrow(() => validateStructurePlan(candidate.structurePlan!))
    assert.deepEqual(candidate.featurePlacements?.map((entry) => entry.featureId), [
      'left-eye-center',
      'mouth-center',
      'right-eye-center',
    ])
    const occupied = new Set(candidate.featurePlacements?.flatMap((entry) => entry.occupiedCells))
    assert.equal(occupied.size > 0, true)
    const featureEdits = candidate.edits.filter((edit) => edit.reason === 'feature-placement')
    assert.equal(featureEdits.length > 0, true)
    assert.equal(candidate.edits.some((edit) =>
      edit.reason !== 'feature-placement'
        && occupied.has(edit.y * candidate.pattern.width + edit.x)), false)
    for (const edit of featureEdits) {
      assert.equal(candidate.pattern.cells.find((entry) =>
        entry.x === edit.x && entry.y === edit.y)?.colorId, edit.toColorId)
    }
  })
})
