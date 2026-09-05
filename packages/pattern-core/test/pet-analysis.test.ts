import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { inferPetAnalysis, inferPetInstances } from '../src/pet-analysis.js'
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
  color(12, 18, 20, 28, 18)
  color(20, 18, 20, 28, 18)
  color(16, 23, 220, 72, 82)
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

function frontalFullBodyPetFixture(): { image: PixelImage; mask: BinaryMask } {
  const width = 80
  const height = 104
  const data = new Uint8ClampedArray(width * height * 4)
  const values = new Float32Array(width * height)
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 230
    data[index * 4 + 1] = 224
    data[index * 4 + 2] = 214
    data[index * 4 + 3] = 255
  }
  const paint = (x: number, y: number, red = 168, green = 124, blue = 88): void => {
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

  for (let y = 18; y <= 58; y += 1) {
    const halfWidth = Math.round(15 + Math.sin((y - 18) / 40 * Math.PI) * 4)
    for (let x = 40 - halfWidth; x <= 40 + halfWidth; x += 1) paint(x, y)
  }
  for (const centerX of [27, 53]) {
    for (let y = 4; y <= 26; y += 1) {
      const halfWidth = Math.max(1, Math.floor((y - 2) * 0.25))
      for (let x = centerX - halfWidth; x <= centerX + halfWidth; x += 1) paint(x, y)
    }
  }
  fill(23, 52, 57, 82)
  fill(24, 78, 32, 98)
  fill(48, 78, 56, 98)
  fill(15, 62, 24, 70)
  paint(34, 36, 18, 22, 16)
  paint(46, 36, 18, 22, 16)
  paint(40, 47, 220, 72, 82)
  return { image: { width, height, data }, mask: { width, height, values } }
}

function asymmetricFrontalHeadFixture(): { image: PixelImage; mask: BinaryMask } {
  const width = 96
  const height = 72
  const data = new Uint8ClampedArray(width * height * 4)
  const values = new Float32Array(width * height)
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 238
    data[index * 4 + 1] = 232
    data[index * 4 + 2] = 220
    data[index * 4 + 3] = 255
  }
  const paint = (x: number, y: number, red = 180, green = 130, blue = 85): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    values[y * width + x] = 1
    const index = (y * width + x) * 4
    data[index] = red
    data[index + 1] = green
    data[index + 2] = blue
  }
  for (let y = 12; y <= 68; y += 1) {
    const halfWidth = Math.round(29 + Math.sin((y - 12) / 56 * Math.PI) * 8)
    for (let x = 48 - halfWidth; x <= 48 + halfWidth; x += 1) paint(x, y)
  }
  for (const centerX of [24, 72]) {
    for (let y = 2; y <= 24; y += 1) {
      const halfWidth = Math.max(1, Math.floor((y - 1) * 0.28))
      for (let x = centerX - halfWidth; x <= centerX + halfWidth; x += 1) paint(x, y)
    }
  }
  for (let y = 28; y <= 34; y += 1) {
    for (let x = 28; x <= 38; x += 1) paint(x, y, 15, 15, 15)
    for (let x = 58; x <= 68; x += 1) paint(x, y, 70, 105, 65)
  }
  for (let y = 20; y <= 38; y += 1) {
    for (let x = 18; x <= 21; x += 1) {
      if ((values[y * width + x] ?? 0) >= 0.5) paint(x, y, 0, 0, 0)
    }
  }
  for (let y = 40; y <= 46; y += 1) {
    for (let x = 44; x <= 52; x += 1) paint(x, y, 210, 90, 90)
  }
  return { image: { width, height, data }, mask: { width, height, values } }
}

function offsetWideFrontalHeadFixture(): { image: PixelImage; mask: BinaryMask } {
  const width = 112
  const height = 84
  const data = new Uint8ClampedArray(width * height * 4)
  const values = new Float32Array(width * height)
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 22
    data[index * 4 + 1] = 34
    data[index * 4 + 2] = 40
    data[index * 4 + 3] = 255
  }
  const paint = (x: number, y: number, red = 186, green = 132, blue = 88): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    values[y * width + x] = 1
    const index = (y * width + x) * 4
    data[index] = red
    data[index + 1] = green
    data[index + 2] = blue
  }
  for (let y = 14; y <= 81; y += 1) {
    const halfWidth = Math.round(34 + Math.sin((y - 14) / 67 * Math.PI) * 8)
    for (let x = 60 - halfWidth; x <= 60 + halfWidth; x += 1) paint(x, y)
  }
  for (let y = 10; y <= 36; y += 1) {
    const halfWidth = Math.max(1, Math.floor((y - 8) * 0.36))
    for (let x = 22 - halfWidth; x <= 22 + halfWidth; x += 1) paint(x, y)
  }
  for (let y = 22; y <= 43; y += 1) {
    const halfWidth = Math.max(1, Math.floor((y - 20) * 0.4))
    for (let x = 99 - halfWidth; x <= 99 + halfWidth; x += 1) paint(x, y)
  }
  for (let y = 39; y <= 45; y += 1) {
    for (let x = 43; x <= 51; x += 1) paint(x, y, 45, 86, 62)
    for (let x = 75; x <= 83; x += 1) paint(x, y, 38, 80, 58)
  }
  for (let y = 55; y <= 60; y += 1) {
    for (let x = 60; x <= 67; x += 1) paint(x, y, 214, 86, 92)
  }
  return { image: { width, height, data }, mask: { width, height, values } }
}

function profileHeadCropFixture(): { image: PixelImage; mask: BinaryMask } {
  const width = 96
  const height = 64
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
  fill(45, 20, 66, 52)
  fill(48, 15, 75, 34)
  fill(70, 22, 88, 30)
  fill(45, 45, 58, 60)
  for (let y = 5; y <= 20; y += 1) {
    const halfWidth = Math.max(1, Math.floor((y - 3) * 0.32))
    for (let x = 52 - halfWidth; x <= 52 + halfWidth; x += 1) paint(x, y)
  }
  paint(66, 20, 18, 18, 18)
  paint(87, 25, 12, 12, 12)
  paint(80, 30, 28, 20, 18)
  return { image: { width, height, data }, mask: { width, height, values } }
}

type GeometricSubject = 'rectangle' | 'circle' | 'diamond' | 'triangle'

function geometricSubjectFixture(shape: GeometricSubject): { image: PixelImage; mask: BinaryMask } {
  const width = 64
  const height = 64
  const data = new Uint8ClampedArray(width * height * 4)
  const values = new Float32Array(width * height)
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 238
    data[index * 4 + 1] = 238
    data[index * 4 + 2] = 238
    data[index * 4 + 3] = 255
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const centeredX = x - 31.5
      const centeredY = y - 31.5
      const active = shape === 'rectangle'
        ? Math.abs(centeredX) <= 21 && Math.abs(centeredY) <= 18
        : shape === 'circle'
          ? Math.hypot(centeredX, centeredY) <= 22
          : shape === 'diamond'
            ? Math.abs(centeredX) / 23 + Math.abs(centeredY) / 25 <= 1
            : y >= 9 && y <= 55 && Math.abs(centeredX) <= (y - 9) * 0.47
      if (active === false) continue
      values[y * width + x] = 1
      const offset = (y * width + x) * 4
      data[offset] = 128
      data[offset + 1] = 128
      data[offset + 2] = 128
    }
  }
  return { image: { width, height, data }, mask: { width, height, values } }
}

describe('pet geometry analysis', () => {
  it('analyzes two significant pet components independently and joins their crop', () => {
    const { image, mask } = twoPetFixture()
    const group = inferPetInstances(image, mask)

    assert.ok(group)
    assert.equal(group.instances.length, 2)
    assert.ok(group.suggestedCrop.x <= 5)
    assert.ok(group.suggestedCrop.x + group.suggestedCrop.width >= 75)
    assert.ok(group.instances.every((instance) => instance.landmarks.length >= 7))
    assert.equal(new Set(group.instances.flatMap((instance) =>
      instance.landmarks.map((landmark) => landmark.id))).size,
    group.instances.flatMap((instance) => instance.landmarks).length)
    for (const instance of group.instances) {
      assert.ok(instance.landmarks.every((landmark) =>
        landmark.id.startsWith(`${instance.instanceId}:`)))
      assert.ok(instance.landmarks.every((landmark) =>
        landmark.x >= instance.bounds.x
        && landmark.x < instance.bounds.x + instance.bounds.width
        && landmark.y >= instance.bounds.y
        && landmark.y < instance.bounds.y + instance.bounds.height))
    }
  })

  it('filters tiny mask debris while retaining the two pet instances', () => {
    const { image, mask } = twoPetFixture()
    mask.values[0] = 1
    const group = inferPetInstances(image, mask)

    assert.ok(group)
    assert.equal(group.instances.length, 2)
    assert.equal(group.instances.some((instance) =>
      (instance.instanceMask.values[0] ?? 0) >= 0.5), false)
  })

  it('rejects plain geometric subjects before generating pet facial landmarks', () => {
    for (const shape of ['rectangle', 'circle', 'diamond', 'triangle'] as const) {
      const fixture = geometricSubjectFixture(shape)
      const analysis = inferPetAnalysis(fixture.image, fixture.mask)

      assert.equal(analysis, undefined, `${shape}: ${JSON.stringify(analysis)}`)
    }
  })

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
    for (const id of [
      'neck-base',
      'visible-shoulder',
      'chest-center',
      'back-middle',
      'tail-root',
      'visible-hip',
      'front-knee',
      'rear-knee',
    ]) {
      assert.ok(analysis.landmarks.some((landmark) => landmark.id === id), id)
    }
    const eye = analysis.landmarks.find((landmark) => landmark.kind === 'eye')!
    const nose = analysis.landmarks.find((landmark) => landmark.kind === 'nose')!
    assert.ok(nose.x > eye.x)
    assert.ok(analysis.suggestedCrop.y + analysis.suggestedCrop.height >= 72)
    assert.ok(analysis.suggestedCrop.x <= 7)
  })

  it('builds an ordered quadruped skeleton and mutually exclusive profile body regions', () => {
    const { image, mask } = rightProfilePetFixture()
    const analysis = inferPetAnalysis(image, mask)

    assert.ok(analysis)
    const landmarks = new Map(analysis.landmarks.map((item) => [item.id, item]))
    const neck = landmarks.get('neck-base')!
    const earTip = landmarks.get('visible-ear-tip')!
    const earRoot = landmarks.get('visible-ear-root')!
    const nose = landmarks.get('nose-tip')!
    const upperJaw = landmarks.get('upper-jaw-end')!
    const lowerJaw = landmarks.get('lower-jaw-end')!
    const shoulder = landmarks.get('visible-shoulder')!
    const tailRoot = landmarks.get('tail-root')!
    const hip = landmarks.get('visible-hip')!
    const frontPaw = landmarks.get('front-paw')!
    const rearPaw = landmarks.get('rear-paw')!
    assert.equal(neck.structuralRole, 'neck-base')
    assert.equal(earTip.structuralRole, 'ear-tip')
    assert.equal(earRoot.structuralRole, 'ear-root')
    assert.equal(nose.structuralRole, 'nose-tip')
    assert.equal(upperJaw.structuralRole, 'upper-jaw')
    assert.equal(lowerJaw.structuralRole, 'lower-jaw')
    assert.equal(upperJaw.gridRadiusCells, 0)
    assert.equal(lowerJaw.gridRadiusCells, 0)
    assert.ok(earRoot.y > earTip.y)
    assert.ok(Math.hypot(earRoot.x - earTip.x, earRoot.y - earTip.y) >= 2)
    assert.ok(Math.abs(nose.x - lowerJaw.x) <= analysis.suggestedCrop.width * 0.08)
    assert.ok(lowerJaw.y > upperJaw.y)
    assert.equal(shoulder.structuralRole, 'shoulder')
    assert.equal(tailRoot.structuralRole, 'tail-root')
    assert.equal(frontPaw.structuralRole, 'front-paw')
    assert.equal(rearPaw.structuralRole, 'rear-paw')
    assert.ok(neck.x > tailRoot.x)
    assert.ok(shoulder.x > hip.x)
    assert.ok(frontPaw.x > rearPaw.x)
    for (const landmark of analysis.landmarks.filter((item) => item.kind === 'body')) {
      const x = Math.round(landmark.x)
      const y = Math.round(landmark.y)
      assert.ok((mask.values[y * mask.width + x] ?? 0) >= 0.5, landmark.id)
    }

    assert.deepEqual(analysis.bodyRegions.map((region) => region.id), [
      'pet-neck',
      'pet-thorax',
      'pet-haunch',
      'pet-foreleg-visible',
      'pet-hindleg-visible',
      'pet-tail',
    ])
    const regionCounts = analysis.bodyRegions.map((region) =>
      region.mask.values.filter((value) => value >= 0.5).length)
    assert.ok(regionCounts.every((count) => count > 0), regionCounts.join(','))
    for (let index = 0; index < mask.values.length; index += 1) {
      const membership = analysis.bodyRegions.reduce(
        (sum, region) => sum + Number((region.mask.values[index] ?? 0) >= 0.5),
        0,
      )
      assert.ok(membership <= 1, `overlap at ${index}`)
      if (membership === 1) assert.ok((mask.values[index] ?? 0) >= 0.5)
    }
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
    assert.equal(analysis.landmarks.filter((landmark) => landmark.kind === 'mouth').length, 2)
    assert.ok(analysis.landmarks.some((landmark) => landmark.structuralRole === 'eye-center'))
    assert.ok(analysis.landmarks.some((landmark) => landmark.structuralRole === 'ear-tip'))
    assert.ok(analysis.landmarks.some((landmark) => landmark.structuralRole === 'ear-root'))
    assert.ok(analysis.landmarks
      .filter((landmark) => landmark.structuralRole === 'ear-tip')
      .every((landmark) => landmark.gridRadiusCells === 0))
    assert.equal(
      analysis.landmarks.find((landmark) => landmark.id === 'nose-tip')?.structuralRole,
      'nose-tip',
    )
    assert.ok(analysis.landmarks.some((landmark) => landmark.structuralRole === 'mouth-corner'))
    assert.ok(analysis.landmarks
      .filter((landmark) => landmark.structuralRole === 'mouth-corner'
        || landmark.structuralRole === 'ear-root')
      .every((landmark) => landmark.priority === 'soft' && landmark.observationState === 'inferred'))
  })

  it('keeps a frontal full-body pet proportional and retains the body below the face', () => {
    const { image, mask } = frontalFullBodyPetFixture()
    const analysis = inferPetAnalysis(image, mask)

    assert.ok(analysis)
    assert.equal(analysis.headPose, 'frontal')
    assert.ok(analysis.suggestedCrop.y + analysis.suggestedCrop.height >= 99)
    assert.ok(analysis.suggestedCrop.x <= 15)
    assert.ok(analysis.bodyRegions.some((region) => region.id === 'pet-body'))
    const body = analysis.bodyRegions.find((region) => region.id === 'pet-body')!
    assert.ok(body.mask.values.filter((value) => value >= 0.5).length > 500)
    for (let index = 0; index < body.mask.values.length; index += 1) {
      if ((body.mask.values[index] ?? 0) >= 0.5) {
        assert.ok((mask.values[index] ?? 0) >= 0.5)
        assert.ok((analysis.faceMask.values[index] ?? 0) < 0.5)
      }
    }
  })

  it('classifies an asymmetric close-up cat face as frontal head-only evidence', () => {
    const { image, mask } = asymmetricFrontalHeadFixture()
    const analysis = inferPetAnalysis(image, mask)

    assert.ok(analysis)
    assert.equal(analysis.headPose, 'frontal')
    assert.equal(analysis.landmarks.filter((landmark) => landmark.kind === 'eye').length, 2)
    assert.equal(analysis.bodyRegions.length, 0, JSON.stringify(analysis.frontalBodyEvidence))
    assert.ok(analysis.suggestedCrop.height < image.height)
    const bodyRoles = new Set([
      'neck-base', 'shoulder', 'chest-center', 'back-middle', 'tail-root', 'hip',
      'front-knee', 'front-paw', 'rear-knee', 'rear-paw', 'tail-tip',
    ])
    assert.deepEqual(
      analysis.landmarks.filter((landmark) => bodyRoles.has(landmark.structuralRole ?? '')),
      [],
    )
  })

  it('uses lateral ear prominence when one ear sits below a broad head crown', () => {
    const { image, mask } = offsetWideFrontalHeadFixture()
    const analysis = inferPetAnalysis(image, mask)

    assert.ok(analysis)
    assert.equal(analysis.headPose, 'frontal')
    const landmarks = new Map(analysis.landmarks.map((landmark) => [landmark.id, landmark]))
    assert.ok((landmarks.get('left-ear-tip')?.x ?? 0) < 30, JSON.stringify(analysis.landmarks))
    assert.ok((landmarks.get('right-ear-tip')?.x ?? 0) > 92, JSON.stringify(analysis.landmarks))
    assert.ok(Math.abs((landmarks.get('left-eye-center')?.x ?? 0) - 47) <= 6, JSON.stringify(analysis.landmarks))
    assert.ok(Math.abs((landmarks.get('right-eye-center')?.x ?? 0) - 79) <= 6, JSON.stringify(analysis.landmarks))
    assert.ok(Math.abs((landmarks.get('left-eye-center')?.y ?? 0) - 42) <= 6)
    assert.ok(Math.abs((landmarks.get('right-eye-center')?.y ?? 0) - 42) <= 6)
    assert.ok(Math.abs((landmarks.get('nose-tip')?.x ?? 0) - 64) <= 6)
    assert.ok(Math.abs((landmarks.get('nose-tip')?.y ?? 0) - 58) <= 6)
    assert.ok(
      analysis.suggestedCrop.x + analysis.suggestedCrop.width >= 106,
      JSON.stringify({ crop: analysis.suggestedCrop, landmarks: analysis.landmarks }),
    )
  })

  it('requires torso and leg evidence before enabling a profile body skeleton', () => {
    const headCrop = profileHeadCropFixture()
    const fullBody = rightProfilePetFixture()
    const headAnalysis = inferPetAnalysis(headCrop.image, headCrop.mask)
    const bodyAnalysis = inferPetAnalysis(fullBody.image, fullBody.mask)

    assert.ok(headAnalysis)
    assert.ok(bodyAnalysis)
    assert.equal(headAnalysis.headPose, 'profile-right')
    assert.equal(headAnalysis.bodyRegions.length, 0)
    assert.equal(headAnalysis.landmarks.some((landmark) => landmark.id === 'visible-shoulder'), false)
    assert.equal(headAnalysis.landmarks.some((landmark) => landmark.id === 'front-paw'), false)
    assert.equal(bodyAnalysis.headPose, 'profile-right')
    assert.ok(bodyAnalysis.bodyRegions.length >= 5)
    assert.ok(bodyAnalysis.landmarks.some((landmark) => landmark.id === 'visible-shoulder'))
    assert.ok(bodyAnalysis.landmarks.some((landmark) => landmark.id === 'front-paw'))
  })
})
