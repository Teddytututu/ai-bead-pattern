import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { inferPetAnalysis } from '../src/pet-analysis.js'
import type { BinaryMask, PixelImage } from '../src/types.js'

function twoPetFixture(): { image: PixelImage; mask: BinaryMask } {
  const width = 80
  const height = 40
  const data = new Uint8ClampedArray(width * height * 4)
  const values = new Float32Array(width * height)
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 174
    data[index * 4 + 1] = 126
    data[index * 4 + 2] = 86
    data[index * 4 + 3] = 255
  }
  const fill = (left: number, top: number, right: number, bottom: number): void => {
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) values[y * width + x] = 1
    }
  }
  fill(5, 15, 25, 30)
  fill(10, 5, 13, 15)
  fill(19, 6, 22, 15)
  fill(48, 12, 74, 34)
  fill(53, 1, 57, 12)
  fill(66, 2, 70, 12)
  const color = (x: number, y: number, red: number, green: number, blue: number): void => {
    const index = (y * width + x) * 4
    data[index] = red
    data[index + 1] = green
    data[index + 2] = blue
  }
  color(58, 16, 20, 28, 18)
  color(66, 16, 20, 28, 18)
  color(62, 21, 220, 72, 82)
  return { image: { width, height, data }, mask: { width, height, values } }
}

describe('pet geometry analysis', () => {
  it('chooses one principal pet before pairing ears and planning the crop', () => {
    const { image, mask } = twoPetFixture()
    const analysis = inferPetAnalysis(image, mask)

    assert.ok(analysis)
    assert.ok(analysis.suggestedCrop.x > 40)
    assert.ok(analysis.suggestedCrop.width < 40)
    assert.ok(analysis.suggestedCropConfidence >= 0.5)
    assert.ok(analysis.landmarks.every((landmark) => landmark.x >= 40 && landmark.x < image.width))
  })

  it('limits the pet face region to the selected principal component', () => {
    const { image, mask } = twoPetFixture()
    const analysis = inferPetAnalysis(image, mask)

    assert.ok(analysis)
    let leftFaceCells = 0
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < 35; x += 1) {
        if ((analysis.faceMask.values[y * image.width + x] ?? 0) >= 0.5) leftFaceCells += 1
      }
    }
    assert.equal(leftFaceCells, 0)
  })
})
