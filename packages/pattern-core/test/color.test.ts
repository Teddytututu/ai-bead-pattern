import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { deltaE2000, rgbToLab } from '../src/index.js'

describe('color conversion', () => {
  it('matches the first CIEDE2000 reference pair', () => {
    const distance = deltaE2000(
      [50, 2.6772, -79.7751],
      [50, 0, -82.7485],
    )

    assert.ok(Math.abs(distance - 2.0425) < 0.0001)
  })

  it('maps sRGB black and white to the expected Lab lightness range', () => {
    const black = rgbToLab([0, 0, 0])
    const white = rgbToLab([255, 255, 255])

    assert.ok(Math.abs(black[0]) < 0.0001)
    assert.ok(Math.abs(white[0] - 100) < 0.02)
  })
})
