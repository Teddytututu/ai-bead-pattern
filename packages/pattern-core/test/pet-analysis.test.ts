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

function rightProfilePetFixture(options: { noseDark?: boolean } = {}): { image: PixelImage; mask: BinaryMask } {
  const width = 96
  const lowContrastProfile = options.noseDark === false
  const height = lowContrastProfile ? 108 : 76
  const data = new Uint8ClampedArray(width * height * 4)
  const values = new Float32Array(width * height)
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 236
    data[index * 4 + 1] = 232
    data[index * 4 + 2] = 224
    data[index * 4 + 3] = 255
  }
  const paint = (x: number, y: number, red = 132, green = 104, blue = 82): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    values[y * width + x] = 1
    const index = (y * width + x) * 4
    data[index] = red
    data[index + 1] = green
    data[index + 2] = blue
  }
  const fill = (left: number, top: number, right: number, bottom: number): void => {
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) paint(x, y)
    }
  }

  fill(20, 31, 58, lowContrastProfile ? 88 : 62)
  fill(45, 20, 66, 52)
  fill(48, 15, 75, 34)
  fill(70, 22, 88, 30)
  fill(28, 57, 35, lowContrastProfile ? 103 : 72)
  fill(53, 55, 61, lowContrastProfile ? 103 : 72)
  fill(7, lowContrastProfile ? 82 : 55, 24, lowContrastProfile ? 87 : 60)
  for (let y = 5; y <= 20; y += 1) {
    const halfWidth = Math.max(1, Math.floor((y - 3) * 0.32))
    for (let x = 52 - halfWidth; x <= 52 + halfWidth; x += 1) paint(x, y)
  }
  paint(66, 20, 18, 18, 18)
  if (options.noseDark ?? true) paint(87, 25, 12, 12, 12)
  paint(80, 30, 28, 20, 18)

  return { image: { width, height, data }, mask: { width, height, values } }
}

function frontalPetFixture(): { image: PixelImage; mask: BinaryMask } {
  const width = 64
  const height = 56
  const data = new Uint8ClampedArray(width * height * 4)
  const values = new Float32Array(width * height)
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 232
    data[index * 4 + 1] = 226
    data[index * 4 + 2] = 214
    data[index * 4 + 3] = 255
  }
  const paint = (x: number, y: number, red = 174, green = 126, blue = 86): void => {
    values[y * width + x] = 1
    const index = (y * width + x) * 4
    data[index] = red
    data[index + 1] = green
    data[index + 2] = blue
  }
  for (let y = 16; y <= 48; y += 1) {
    const halfWidth = Math.round(10 + (y - 16) * 0.24)
    for (let x = 32 - halfWidth; x <= 32 + halfWidth; x += 1) paint(x, y)
  }
  for (const centerX of [21, 43]) {
    for (let y = 3; y <= 21; y += 1) {
      const halfWidth = Math.max(1, Math.floor((y - 1) * 0.28))
      for (let x = centerX - halfWidth; x <= centerX + halfWidth; x += 1) paint(x, y)
    }
  }
  paint(26, 27, 18, 22, 16)
  paint(38, 27, 18, 22, 16)
  paint(32, 36, 220, 72, 82)
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

  it('uses a profile keypoint layout and keeps the full sitting silhouette in frame', () => {
    const { image, mask } = rightProfilePetFixture()
    const analysis = inferPetAnalysis(image, mask)

    assert.ok(analysis)
    assert.equal(analysis.headPose, 'profile-right')
    assert.equal(analysis.landmarks.filter((landmark) => landmark.kind === 'eye').length, 1)
    assert.equal(analysis.landmarks.filter((landmark) => landmark.kind === 'ear').length, 1)
    assert.equal(analysis.landmarks.find((landmark) => landmark.kind === 'eye')?.gridRadiusCells, 0)
    assert.ok(analysis.landmarks.some((landmark) => landmark.id === 'mouth-corner'))
    assert.ok(analysis.landmarks.some((landmark) => landmark.id === 'upper-jaw-end'))
    assert.ok(analysis.landmarks.some((landmark) => landmark.id === 'lower-jaw-end'))
    assert.ok(analysis.landmarks.some((landmark) => landmark.id === 'tail-tip'))
    assert.ok(analysis.landmarks.some((landmark) => landmark.id === 'front-paw'))
    assert.ok(analysis.landmarks.some((landmark) => landmark.id === 'rear-paw'))
    const eye = analysis.landmarks.find((landmark) => landmark.kind === 'eye')!
    const nose = analysis.landmarks.find((landmark) => landmark.kind === 'nose')!
    assert.ok(nose.x > eye.x)
    assert.ok(analysis.suggestedCrop.y + analysis.suggestedCrop.height >= 72)
    assert.ok(analysis.suggestedCrop.x <= 7)
  })

  it('uses silhouette direction to keep a low-contrast profile muzzle in one-eye mode', () => {
    const { image, mask } = rightProfilePetFixture({ noseDark: false })
    const analysis = inferPetAnalysis(image, mask)

    assert.ok(analysis)
    assert.equal(analysis.headPose, 'profile-right')
    assert.equal(analysis.landmarks.filter((landmark) => landmark.kind === 'eye').length, 1)
    assert.ok(analysis.landmarks.some((landmark) => landmark.id === 'nose-tip'))
  })

  it('keeps paired facial landmarks for a frontal pet', () => {
    const { image, mask } = frontalPetFixture()
    const analysis = inferPetAnalysis(image, mask)

    assert.ok(analysis)
    assert.equal(analysis.headPose, 'frontal')
    assert.equal(analysis.landmarks.filter((landmark) => landmark.kind === 'eye').length, 2)
    assert.equal(analysis.landmarks.filter((landmark) => landmark.kind === 'ear').length, 2)
  })
})
