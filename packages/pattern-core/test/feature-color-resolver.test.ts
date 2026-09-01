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
  { id: 'olive', name: 'Olive iris', hex: '#596c1f', rgb: [89, 108, 31] },
  { id: 'iris-light', name: 'Iris highlight', hex: '#c3d158', rgb: [195, 209, 88] },
  { id: 'brown', name: 'Brown', hex: '#75452a', rgb: [117, 69, 42] },
  { id: 'coral', name: 'Coral', hex: '#ee6d68', rgb: [238, 109, 104] },
  { id: 'pink', name: 'Pink', hex: '#e98cb2', rgb: [233, 140, 178] },
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

  it('combines paired source colors into dark pupils and one shared chromatic iris', () => {
    const initialColorIds = new Array(18).fill('white')

    const result = resolveFeatureColors({
      placements: [leftEye, rightEye],
      initialColorIds,
      colors,
      width: 6,
      height: 3,
      minimumContrastByFeature: new Map([
        ['left-eye-center', 12],
        ['right-eye-center', 12],
      ]),
      preferredColorIdsByFeature: new Map([
        ['left-eye-center', 'olive'],
        ['right-eye-center', 'black'],
      ]),
      distanceMethod: 'delta-e-2000',
    })

    assert.equal(result.roleColorIds['eye-dark'], 'black')
    assert.equal(result.roleColorIds['eye-highlight'], 'olive')
  })

  it('uses the source-derived material color for a nose when it meets the contrast budget', () => {
    const nose: ResolvedFeaturePlacement = {
      featureId: 'nose-tip',
      kind: 'nose',
      templateId: 'nose-n1',
      center: [1, 1],
      occupiedCells: [4],
      roles: [{ cell: 4, role: 'nose-base' }],
      shift: [0, 0],
      score: 1,
    }
    const initialColorIds = new Array(9).fill('white')
    initialColorIds[4] = 'brown'

    const result = resolveFeatureColors({
      placements: [nose],
      initialColorIds,
      colors,
      width: 3,
      height: 3,
      minimumContrastByFeature: new Map([['nose-tip', 8]]),
      preferredColorIdsByFeature: new Map([['nose-tip', 'rose']]),
      distanceMethod: 'delta-e-2000',
    })

    assert.equal(result.roleColorIds['nose-base'], 'rose')
  })

  it('selects a warm red or pink nose on a light pet face when the initial grid is brown', () => {
    const nose: ResolvedFeaturePlacement = {
      featureId: 'nose-tip',
      kind: 'nose',
      templateId: 'nose-n1',
      center: [1, 1],
      occupiedCells: [4],
      roles: [{ cell: 4, role: 'nose-base' }],
      shift: [0, 0],
      score: 1,
    }
    const initialColorIds = new Array(9).fill('white')
    initialColorIds[4] = 'brown'

    const result = resolveFeatureColors({
      placements: [nose],
      initialColorIds,
      colors,
      width: 3,
      height: 3,
      minimumContrastByFeature: new Map([['nose-tip', 8]]),
      distanceMethod: 'delta-e-2000',
    })

    assert.ok(['coral', 'pink', 'rose'].includes(result.roleColorIds['nose-base'] ?? ''))
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
