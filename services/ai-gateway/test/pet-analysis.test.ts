import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import sharp from 'sharp'

import {
  inferPetAnalysis,
  type BinaryMask,
  type CropRect,
  type PixelImage,
} from '@ai-bead-pattern/pattern-core'

interface MaskBounds {
  left: number
  top: number
  right: number
  bottom: number
}

function activeMaskBounds(mask: BinaryMask): MaskBounds {
  let left = mask.width
  let top = mask.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if ((mask.values[y * mask.width + x] ?? 0) < 0.5) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  assert.ok(right >= left && bottom >= top)
  return { left, top, right, bottom }
}

function cropContains(crop: CropRect, x: number, y: number): boolean {
  return x >= crop.x
    && x < crop.x + crop.width
    && y >= crop.y
    && y < crop.y + crop.height
}

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
  it('finds bilateral eyes, mouth corners, ear anchors, and a proportional crop', () => {
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
      'left-mouth-corner',
      'right-mouth-corner',
      'face-left',
      'face-right',
      'chin',
      'left-ear-root',
      'right-ear-root',
    ])
    const eyeY = analysis.landmarks.filter((landmark) => landmark.kind === 'eye').map((landmark) => landmark.y)
    assert.ok(Math.max(...eyeY) - Math.min(...eyeY) <= 1)
    assert.ok(analysis.suggestedCrop.width < image.width)
    const subjectBounds = activeMaskBounds(mask)
    assert.ok(cropContains(analysis.suggestedCrop, subjectBounds.left, subjectBounds.top))
    assert.ok(cropContains(analysis.suggestedCrop, subjectBounds.right, subjectBounds.bottom))
    const faceBounds = activeMaskBounds(analysis.faceMask)
    for (const landmark of analysis.landmarks.filter((item) => ['ear', 'eye', 'nose'].includes(item.kind))) {
      assert.ok(cropContains(analysis.suggestedCrop, landmark.x, landmark.y), landmark.id)
    }
    assert.ok(cropContains(analysis.suggestedCrop, faceBounds.left, faceBounds.top))
    assert.ok(cropContains(analysis.suggestedCrop, faceBounds.right, faceBounds.bottom))
    assert.ok(analysis.confidence >= 0.55)
  })

  it('keeps the bundled cat face anchors readable inside a proportional full-body crop', async () => {
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
    const faceBounds = activeMaskBounds(analysis.faceMask)
    const subjectBounds = activeMaskBounds(mask)
    assert.ok(faceBounds.bottom < subjectBounds.bottom)
    assert.ok(cropContains(analysis.suggestedCrop, subjectBounds.left, subjectBounds.top))
    assert.ok(cropContains(analysis.suggestedCrop, subjectBounds.right, subjectBounds.bottom))
    assert.ok(cropContains(analysis.suggestedCrop, faceBounds.left, faceBounds.top))
    assert.ok(cropContains(analysis.suggestedCrop, faceBounds.right, faceBounds.bottom))
    const sourcePixelsPerCell = Math.max(
      analysis.suggestedCrop.width / 32,
      analysis.suggestedCrop.height / 32,
    )
    assert.ok((rightEye.x - leftEye.x) / sourcePixelsPerCell >= 4)
    for (const feature of [
      landmarks.get('left-ear-tip')!,
      landmarks.get('right-ear-tip')!,
      leftEye,
      rightEye,
      nose,
    ]) {
      assert.ok(cropContains(analysis.suggestedCrop, feature.x, feature.y), feature.id)
    }
  })
})
