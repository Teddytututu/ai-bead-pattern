import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import sharp from 'sharp'

import {
  inferPetAnalysis,
  type BinaryMask,
  type PixelImage,
} from '@ai-bead-pattern/pattern-core'

function syntheticCat(): { image: PixelImage, mask: BinaryMask } {
  const width = 24
  const height = 24
  const data = new Uint8ClampedArray(width * height * 4)
  const values = new Float32Array(width * height)
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 214
    data[index * 4 + 1] = 190
    data[index * 4 + 2] = 160
    data[index * 4 + 3] = 255
  }
  const fill = (x: number, y: number, rgb: readonly [number, number, number]) => {
    const index = y * width + x
    values[index] = 1
    data[index * 4] = rgb[0]
    data[index * 4 + 1] = rgb[1]
    data[index * 4 + 2] = rgb[2]
  }
  for (let y = 5; y <= 21; y += 1) {
    for (let x = 4; x <= 19; x += 1) fill(x, y, [150, 126, 104])
  }
  for (let y = 1; y <= 6; y += 1) {
    const spread = y - 1
    for (let x = 6 - Math.floor(spread / 2); x <= 6 + Math.floor(spread / 2); x += 1) fill(x, y, [120, 96, 78])
    for (let x = 17 - Math.floor(spread / 2); x <= 17 + Math.floor(spread / 2); x += 1) fill(x, y, [120, 96, 78])
  }
  for (const [x, y] of [[8, 9], [15, 9]] as const) fill(x, y, [25, 38, 20])
  fill(11, 12, [225, 92, 110])
  fill(12, 12, [225, 92, 110])
  return { image: { width, height, data }, mask: { width, height, values } }
}

describe('pet analysis', () => {
  it('finds bilateral eyes, ear tips, nose, and a head-focused crop', () => {
    const { image, mask } = syntheticCat()

    const analysis = inferPetAnalysis(image, mask)

    assert.ok(analysis)
    assert.equal(analysis.imageType, 'pet')
    assert.deepEqual(analysis.landmarks.map((landmark) => landmark.id), [
      'left-ear-tip',
      'right-ear-tip',
      'left-eye-center',
      'right-eye-center',
      'nose-tip',
      'face-left',
      'face-right',
      'chin',
    ])
    const eyeY = analysis.landmarks.filter((landmark) => landmark.kind === 'eye').map((landmark) => landmark.y)
    assert.ok(Math.max(...eyeY) - Math.min(...eyeY) <= 1)
    assert.ok(analysis.suggestedCrop.width < image.width)
    assert.ok(analysis.suggestedCrop.height < image.height)
    assert.ok(analysis.confidence >= 0.55)
  })

  it('keeps the bundled cat eyes and nose on the visible face instead of dark fur', async () => {
    const imageResult = await sharp(fileURLToPath(new URL(
      '../../../../apps/demo/assets/sample-cat.png',
      import.meta.url,
    ))).resize(512, 512).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const maskResult = await sharp(fileURLToPath(new URL(
      '../../../../apps/demo/assets/sample-cat-mask.png',
      import.meta.url,
    ))).resize(512, 512).greyscale().raw().toBuffer({ resolveWithObject: true })
    const image: PixelImage = {
      width: 512,
      height: 512,
      data: new Uint8ClampedArray(imageResult.data),
    }
    const mask: BinaryMask = {
      width: 512,
      height: 512,
      values: Float32Array.from(maskResult.data, (value) => value / 255),
    }

    const analysis = inferPetAnalysis(image, mask)

    assert.ok(analysis)
    const landmarks = new Map(analysis.landmarks.map((item) => [item.id, item]))
    const leftEye = landmarks.get('left-eye-center')!
    const rightEye = landmarks.get('right-eye-center')!
    const nose = landmarks.get('nose-tip')!
    assert.ok(leftEye.x >= 242 && leftEye.x <= 258)
    assert.ok(leftEye.y >= 198 && leftEye.y <= 220)
    assert.ok(rightEye.x >= 314 && rightEye.x <= 330)
    assert.ok(rightEye.y >= 210 && rightEye.y <= 236)
    assert.ok(rightEye.x - leftEye.x >= 50 && rightEye.x - leftEye.x <= 110)
    assert.ok(Math.abs(rightEye.y - leftEye.y) <= 35)
    assert.ok(nose.x >= 275 && nose.x <= 310)
    assert.ok(nose.y >= 255 && nose.y <= 295)
    for (const feature of [
      landmarks.get('left-ear-tip')!,
      landmarks.get('right-ear-tip')!,
      leftEye,
      rightEye,
      nose,
    ]) {
      const index = Math.round(feature.y) * analysis.faceMask.width + Math.round(feature.x)
      assert.ok((analysis.faceMask.values[index] ?? 0) >= 0.5)
    }
    const faceCells = analysis.faceMask.values.filter((value) => value >= 0.5).length
    const subjectCells = mask.values.filter((value) => value >= 0.5).length
    assert.ok(faceCells < subjectCells * 0.55)
    assert.equal(analysis.faceMask.values[400 * analysis.faceMask.width + 410], 0)
  })
})
