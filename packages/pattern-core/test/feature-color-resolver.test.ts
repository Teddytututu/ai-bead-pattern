import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { colorDistance, rgbToLab } from '../src/color.js'
import {
  resolveFeatureColors,
  type ResolvedFeaturePlacement,
} from '../src/experimental.js'
import type { MaterialColor } from '../src/index.js'

const colors: readonly MaterialColor[] = [
  { id: 'black', name: 'Black', hex: '#000000', rgb: [0, 0, 0] },
  { id: 'skin', name: 'Skin', hex: '#d7a98c', rgb: [215, 169, 140] },
  { id: 'rose', name: 'Rose', hex: '#a44256', rgb: [164, 66, 86] },
  { id: 'white', name: 'White', hex: '#ffffff', rgb: [255, 255, 255] },
]

const leftEye: ResolvedFeaturePlacement = {
  featureId: 'left-eye-center',
  kind: 'eye',
  templateId: 'eye-highlight',
  center: [1, 1],
  occupiedCells: [4, 5, 7, 8],
  roles: [
    { cell: 4, role: 'eye-dark' },
    { cell: 5, role: 'eye-dark' },
    { cell: 7, role: 'eye-dark' },
    { cell: 8, role: 'eye-highlight' },
  ],
  shift: [0, 0],
  score: 1,
}

const rightEye: ResolvedFeaturePlacement = {
  ...leftEye,
  featureId: 'right-eye-center',
  center: [4, 1],
  occupiedCells: [10, 11, 13, 14],
  roles: [
    { cell: 10, role: 'eye-dark' },
    { cell: 11, role: 'eye-dark' },
    { cell: 13, role: 'eye-dark' },
    { cell: 14, role: 'eye-highlight' },
  ],
}

describe('feature role color resolution', () => {
  it('gives eye-dark cells the requested contrast against their carrier color', () => {
    const result = resolveFeatureColors({
      placements: [leftEye],
      initialColorIds: new Array(18).fill('skin'),
      colors,
      width: 6,
      height: 3,
      minimumContrastByFeature: new Map([['left-eye-center', 18]]),
      distanceMethod: 'delta-e-2000',
    })

    const eyeColor = colors.find((color) => color.id === result.colorIds[4])!
    assert.ok(colorDistance(rgbToLab(eyeColor.rgb), rgbToLab(colors[1]!.rgb), 'delta-e-2000') >= 18)
  })

  it('keeps eye highlights lighter than the eye body', () => {
    const result = resolveFeatureColors({
      placements: [leftEye],
      initialColorIds: new Array(18).fill('skin'),
      colors,
      width: 6,
      height: 3,
      distanceMethod: 'delta-e-2000',
    })

    const eyeDark = colors.find((color) => color.id === result.colorIds[4])!
    const highlight = colors.find((color) => color.id === result.colorIds[8])!
    assert.ok(rgbToLab(highlight.rgb)[0] > rgbToLab(eyeDark.rgb)[0])
  })

  it('uses one role color across a paired set of eyes', () => {
    const initialColorIds = new Array(18).fill('skin')
    initialColorIds[10] = 'rose'
    initialColorIds[11] = 'rose'
    initialColorIds[13] = 'rose'
    initialColorIds[14] = 'rose'
    const result = resolveFeatureColors({
      placements: [leftEye, rightEye],
      initialColorIds,
      colors,
      width: 6,
      height: 3,
      distanceMethod: 'delta-e-2000',
    })

    assert.equal(result.colorIds[4], result.colorIds[10])
    assert.equal(result.colorIds[8], result.colorIds[14])
  })

  it('records each changed feature cell as a feature placement edit', () => {
    const result = resolveFeatureColors({
      placements: [leftEye],
      initialColorIds: new Array(18).fill('skin'),
      colors,
      width: 6,
      height: 3,
      distanceMethod: 'delta-e-2000',
    })

    assert.equal(result.edits.length, result.colorIds.filter((colorId) => colorId !== 'skin').length)
    assert.equal(result.edits.every((edit) => edit.reason === 'feature-placement'), true)
  })

  it('rejects a placement outside the target grid', () => {
    assert.throws(() => resolveFeatureColors({
      placements: [{
        ...leftEye,
        occupiedCells: [18],
        roles: [{ cell: 18, role: 'eye-dark' }],
      }],
      initialColorIds: new Array(18).fill('skin'),
      colors,
      width: 6,
      height: 3,
      distanceMethod: 'delta-e-2000',
    }), /outside/i)
  })
})
