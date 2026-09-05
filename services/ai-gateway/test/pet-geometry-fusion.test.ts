import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type {
  BinaryMask,
  ImageAnalysis,
  ImageLandmark,
  PixelImage,
} from '@ai-bead-pattern/pattern-core'

import { enrichPetGeometryAnalysis } from '../src/index.js'

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
    for (let x = 6 - Math.floor(spread / 2); x <= 6 + Math.floor(spread / 2); x += 1) {
      fill(x, y, [120, 96, 78])
    }
    for (let x = 17 - Math.floor(spread / 2); x <= 17 + Math.floor(spread / 2); x += 1) {
      fill(x, y, [120, 96, 78])
    }
  }
  fill(8, 9, [25, 38, 20])
  fill(15, 9, [25, 38, 20])
  fill(11, 12, [225, 92, 110])
  fill(12, 12, [225, 92, 110])
  return { image: { width, height, data }, mask: { width, height, values } }
}

function modelLandmark(
  id: string,
  kind: ImageLandmark['kind'],
  structuralRole: NonNullable<ImageLandmark['structuralRole']>,
  x: number,
  y: number,
  instanceId = 'pet-01',
): ImageLandmark {
  return {
    id: `${instanceId}:${id}`,
    kind,
    structuralRole,
    x,
    y,
    confidence: 0.94,
    priority: 'hard',
    carrierRegionId: `${instanceId}:subject`,
    featureRegionId: `${instanceId}:pet-face`,
    observationState: 'observed',
    provenance: [{
      origin: 'model',
      provider: 'mmpose-animal-local',
      model: 'mmpose/rtmpose-m-ap10k',
      version: '7a041aa1',
    }],
  }
}

describe('pet geometry fusion', () => {
  it('creates an instance face region and keeps model eye and nose observations authoritative', () => {
    const { image, mask } = syntheticCat()
    const analysis: ImageAnalysis = {
      imageType: 'pet',
      subjectMask: mask,
      subjectMaskEvidence: {
        mask,
        confidence: 0.92,
        source: 'ai',
        revision: 'sam2:pet-01',
      },
      semanticRegions: [{
        id: 'pet-01:subject',
        label: 'cat',
        mask,
        confidence: 0.92,
        importance: 0.9,
      }],
      landmarks: [
        modelLandmark('left-eye-center', 'eye', 'eye-center', 8, 9),
        modelLandmark('right-eye-center', 'eye', 'eye-center', 15, 9),
        modelLandmark('nose-tip', 'nose', 'nose-tip', 11.5, 12),
      ],
    }

    const enriched = enrichPetGeometryAnalysis(image, analysis, 'pet')

    const face = enriched.semanticRegions?.find((region) => region.id === 'pet-01:pet-face')
    assert.ok(face)
    assert.equal(face.label, 'pet face')
    assert.ok(face.mask.values.filter((value) => value >= 0.5).length > 0)
    assert.ok(face.mask.values.filter((value) => value >= 0.5).length
      < mask.values.filter((value) => value >= 0.5).length)
    for (const id of ['left-eye-center', 'right-eye-center', 'nose-tip']) {
      const landmark = enriched.landmarks?.find((entry) => entry.id === `pet-01:${id}`)
      assert.ok(landmark)
      assert.equal(landmark.provenance?.[0]?.origin, 'model')
      assert.equal(landmark.featureRegionId, 'pet-01:pet-face')
      assert.equal(landmark.carrierRegionId, 'pet-01:pet-face')
    }
    assert.ok(enriched.landmarks?.some((entry) => entry.id === 'pet-01:left-ear-tip'))
    assert.ok(enriched.semanticRegions?.some((region) => region.id === 'pet-01:pet-body'))
  })

  it('keeps multiple model instances separate when only one aggregate subject mask exists', () => {
    const { image, mask } = syntheticCat()
    const analysis: ImageAnalysis = {
      imageType: 'pet',
      subjectMask: mask,
      landmarks: [
        modelLandmark('nose-tip', 'nose', 'nose-tip', 8, 12, 'pet-01'),
        modelLandmark('nose-tip', 'nose', 'nose-tip', 16, 12, 'pet-02'),
      ],
    }

    const enriched = enrichPetGeometryAnalysis(image, analysis, 'pet')

    assert.deepEqual(enriched.landmarks?.map((landmark) => landmark.id), [
      'pet-01:nose-tip',
      'pet-02:nose-tip',
    ])
    assert.equal(Boolean(enriched.semanticRegions?.some((region) => region.id === 'pet-face')), false)
    assert.equal(enriched.landmarks?.every((landmark) => /^pet-\d+:/.test(landmark.id)), true)
  })

  it('binds aggregate-mask geometry to the sole model instance', () => {
    const { image, mask } = syntheticCat()
    const analysis: ImageAnalysis = {
      imageType: 'pet',
      subjectMask: mask,
      landmarks: [modelLandmark('nose-tip', 'nose', 'nose-tip', 11.5, 12)],
    }

    const enriched = enrichPetGeometryAnalysis(image, analysis, 'pet')

    assert.ok(enriched.semanticRegions?.some((region) => region.id === 'pet-01:pet-face'))
    assert.ok(enriched.landmarks?.some((landmark) => landmark.id === 'pet-01:left-ear-tip'))
    assert.equal(enriched.landmarks?.every((landmark) => landmark.id.startsWith('pet-01:')), true)
    const nose = enriched.landmarks?.find((landmark) => landmark.id === 'pet-01:nose-tip')
    assert.equal(nose?.provenance?.[0]?.origin, 'model')
    assert.equal(nose?.carrierRegionId, 'pet-01:pet-face')
  })
})
