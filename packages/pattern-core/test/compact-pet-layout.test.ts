import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  compactPetLayout,
  type BinaryMask,
  type ImageAnalysis,
  type ImageLandmark,
  type PixelImage,
  type SemanticRegion,
} from '../src/index.js'

interface InstanceFixture {
  id: string
  left: number
  top: number
  width: number
  height: number
  color: readonly [number, number, number]
}

function rectangleMask(
  width: number,
  height: number,
  left: number,
  top: number,
  rectangleWidth: number,
  rectangleHeight: number,
): BinaryMask {
  return {
    width,
    height,
    values: Float32Array.from({ length: width * height }, (_, index) => {
      const x = index % width
      const y = Math.floor(index / width)
      return x >= left && x < left + rectangleWidth
        && y >= top && y < top + rectangleHeight ? 1 : 0
    }),
  }
}

function unionMasks(masks: readonly BinaryMask[]): BinaryMask {
  const first = masks[0]!
  return {
    width: first.width,
    height: first.height,
    values: Float32Array.from({ length: first.width * first.height }, (_, index) =>
      Math.max(...masks.map((mask) => mask.values[index] ?? 0))),
  }
}

function region(id: string, mask: BinaryMask): SemanticRegion {
  return {
    id,
    label: id,
    mask,
    confidence: 0.96,
    importance: 1,
    provenance: [{ origin: 'model', provider: 'grounded-sam2-local', version: 'fixture' }],
  }
}

function fixture(
  width: number,
  height: number,
  instances: readonly InstanceFixture[],
): { image: PixelImage; analysis: ImageAnalysis } {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 238
    data[index * 4 + 1] = 238
    data[index * 4 + 2] = 238
    data[index * 4 + 3] = 255
  }
  const instanceMasks = instances.map((instance) => {
    const mask = rectangleMask(
      width,
      height,
      instance.left,
      instance.top,
      instance.width,
      instance.height,
    )
    for (let y = instance.top; y < instance.top + instance.height; y += 1) {
      for (let x = instance.left; x < instance.left + instance.width; x += 1) {
        const offset = (y * width + x) * 4
        data[offset] = instance.color[0]
        data[offset + 1] = instance.color[1]
        data[offset + 2] = instance.color[2]
      }
    }
    return mask
  })
  const subject = unionMasks(instanceMasks)
  return {
    image: { width, height, data },
    analysis: {
      imageType: 'pet',
      confidence: 0.96,
      subjectMask: subject,
      subjectMaskEvidence: {
        mask: subject,
        confidence: 0.96,
        source: 'ai',
        revision: 'fixture-v1',
      },
      semanticRegions: [
        region('subject', subject),
        ...instances.map((instance, index) =>
          region(`${instance.id}:subject`, instanceMasks[index]!)),
      ],
    },
  }
}

function activeArea(mask: BinaryMask): number {
  return mask.values.reduce((total, value) => total + Number(value >= 0.5), 0)
}

function rgbaAt(image: PixelImage, x: number, y: number): readonly number[] {
  const offset = (y * image.width + x) * 4
  return Array.from(image.data.slice(offset, offset + 4))
}

describe('compact pet layout', () => {
  it('enlarges two distant pets in a square composition while preserving each aspect ratio', () => {
    const source = fixture(160, 80, [
      { id: 'pet-01', left: 8, top: 12, width: 44, height: 58, color: [185, 125, 72] },
      { id: 'pet-02', left: 132, top: 24, width: 16, height: 30, color: [92, 118, 176] },
    ])
    const originalWeakestOccupancy = Math.min(
      ...(source.analysis.semanticRegions ?? [])
        .filter((item) => item.id.endsWith(':subject'))
        .map((item) => activeArea(item.mask) / (source.image.width * source.image.height)),
    )

    const result = compactPetLayout({
      ...source,
      targetSize: 96,
      gap: 2,
      background: 'transparent',
    })

    assert.equal(result.image.width, 96)
    assert.equal(result.image.height, 96)
    assert.equal(result.diagnostics.rows, 1)
    assert.equal(result.diagnostics.columns, 2)
    assert.ok(result.diagnostics.scale > 1)
    assert.ok(result.diagnostics.weakestSubjectOccupancy > originalWeakestOccupancy * 3)
    assert.deepEqual(result.diagnostics.placements.map((item) => item.instanceId), [
      'pet-01',
      'pet-02',
    ])
    for (const placement of result.diagnostics.placements) {
      const horizontalScale = placement.targetBounds.width / placement.sourceBounds.width
      const verticalScale = placement.targetBounds.height / placement.sourceBounds.height
      assert.ok(Math.abs(horizontalScale - verticalScale) < 1e-12)
    }
    assert.deepEqual(rgbaAt(result.image, 0, 0), [0, 0, 0, 0])
  })

  it('uses multiple rows for five pets and keeps every placement separate', () => {
    const source = fixture(250, 50, Array.from({ length: 5 }, (_, index) => ({
      id: `pet-${String(index + 1).padStart(2, '0')}`,
      left: 8 + index * 48,
      top: 15,
      width: 12,
      height: 16,
      color: [80 + index * 25, 100, 150] as const,
    })))

    const result = compactPetLayout({
      ...source,
      targetSize: 120,
      gap: 4,
      background: 'white',
    })

    assert.equal(result.diagnostics.rows, 2)
    assert.equal(result.diagnostics.columns, 3)
    assert.equal(result.diagnostics.placements.length, 5)
    for (let first = 0; first < result.diagnostics.placements.length; first += 1) {
      for (let second = first + 1; second < result.diagnostics.placements.length; second += 1) {
        const a = result.diagnostics.placements[first]!.targetBounds
        const b = result.diagnostics.placements[second]!.targetBounds
        const separated = a.x + a.width <= b.x || b.x + b.width <= a.x
          || a.y + a.height <= b.y || b.y + b.height <= a.y
        assert.equal(separated, true)
      }
    }
    assert.deepEqual(rgbaAt(result.image, 0, 0), [255, 255, 255, 255])
  })

  it('keeps pixels, semantic masks, landmarks, and importance weights aligned', () => {
    const source = fixture(60, 30, [
      { id: 'pet-01', left: 2, top: 5, width: 16, height: 20, color: [210, 62, 48] },
      { id: 'pet-02', left: 42, top: 7, width: 14, height: 18, color: [52, 94, 205] },
    ])
    const faceMask = rectangleMask(60, 30, 6, 8, 9, 10)
    const eye: ImageLandmark = {
      id: 'pet-01:left-eye',
      kind: 'eye',
      x: 10,
      y: 12,
      confidence: 0.98,
      priority: 'hard',
      observationState: 'observed',
      featureRegionId: 'pet-01:face',
    }
    source.analysis.semanticRegions = [
      ...(source.analysis.semanticRegions ?? []),
      region('pet-01:face', faceMask),
    ]
    source.analysis.landmarks = [eye]
    source.analysis.importanceMap = {
      width: 60,
      height: 30,
      weights: Float32Array.from({ length: 60 * 30 }, (_, index) =>
        index === eye.y * 60 + eye.x ? 1 : 0),
    }

    const result = compactPetLayout({ ...source, targetSize: 80, gap: 2 })
    const transformedEye = result.analysis.landmarks?.find((item) => item.id === eye.id)!
    const targetX = Math.round(transformedEye.x)
    const targetY = Math.round(transformedEye.y)
    const transformedFace = result.analysis.semanticRegions?.find((item) =>
      item.id === 'pet-01:face')!
    const transformedSubject = result.analysis.semanticRegions?.find((item) =>
      item.id === 'pet-01:subject')!
    const index = targetY * result.image.width + targetX

    assert.ok((transformedSubject.mask.values[index] ?? 0) >= 0.5)
    assert.ok((transformedFace.mask.values[index] ?? 0) >= 0.5)
    assert.ok((result.analysis.subjectMask?.values[index] ?? 0) >= 0.5)
    assert.ok((result.analysis.importanceMap?.weights[index] ?? 0) > 0.1)
    assert.deepEqual(rgbaAt(result.image, targetX, targetY), [210, 62, 48, 255])
    assert.equal(result.analysis.subjectMask, result.analysis.subjectMaskEvidence?.mask)
    assert.match(result.analysis.subjectMaskEvidence?.revision ?? '', /compact-pet-layout/)
  })

  it('returns byte-for-byte identical output for repeated inputs', () => {
    const source = fixture(100, 50, [
      { id: 'pet-01', left: 3, top: 8, width: 24, height: 36, color: [201, 105, 66] },
      { id: 'pet-02', left: 74, top: 13, width: 18, height: 29, color: [72, 121, 194] },
    ])

    const first = compactPetLayout({ ...source, targetSize: 72, gap: 3 })
    const second = compactPetLayout({ ...source, targetSize: 72, gap: 3 })

    assert.deepEqual(first, second)
  })

  it('rejects missing instance evidence and malformed image or mask data', () => {
    const source = fixture(40, 20, [
      { id: 'pet-01', left: 4, top: 4, width: 12, height: 12, color: [180, 90, 60] },
      { id: 'pet-02', left: 24, top: 4, width: 12, height: 12, color: [60, 90, 180] },
    ])
    assert.throws(() => compactPetLayout({
      image: source.image,
      analysis: { imageType: 'pet' },
    }), /pet instance/i)
    assert.throws(() => compactPetLayout({
      image: { ...source.image, data: new Uint8ClampedArray(3) },
      analysis: source.analysis,
    }), /image data/i)

    const badDimensions = structuredClone(source.analysis)
    badDimensions.semanticRegions = (badDimensions.semanticRegions ?? []).map((item) =>
      item.id === 'pet-02:subject'
        ? { ...item, mask: rectangleMask(4, 4, 0, 0, 4, 4) }
        : item)
    assert.throws(() => compactPetLayout({
      image: source.image,
      analysis: badDimensions,
    }), /align with the source image/i)

    const badValues = structuredClone(source.analysis)
    const badRegion = badValues.semanticRegions?.find((item) => item.id === 'pet-01:subject')!
    badRegion.mask.values[0] = Number.NaN
    assert.throws(() => compactPetLayout({
      image: source.image,
      analysis: badValues,
    }), /mask values/i)
  })

  it('rejects invalid target, gap, background, and landmark coordinates', () => {
    const source = fixture(40, 20, [
      { id: 'pet-01', left: 4, top: 4, width: 12, height: 12, color: [180, 90, 60] },
      { id: 'pet-02', left: 24, top: 4, width: 12, height: 12, color: [60, 90, 180] },
    ])
    assert.throws(() => compactPetLayout({ ...source, targetSize: 0 }), /target size/i)
    assert.throws(() => compactPetLayout({ ...source, gap: -1 }), /gap/i)
    assert.throws(() => compactPetLayout({
      ...source,
      background: 'checkerboard' as 'white',
    }), /background/i)
    assert.throws(() => compactPetLayout({
      ...source,
      analysis: {
        ...source.analysis,
        landmarks: [{
          id: 'pet-01:left-eye',
          kind: 'eye',
          x: Number.NaN,
          y: 8,
          confidence: 1,
          priority: 'hard',
        }],
      },
    }), /landmark/i)
  })
})
