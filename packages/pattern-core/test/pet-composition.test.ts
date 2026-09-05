import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  planPetCompositionVariants,
  type BinaryMask,
  type ImageAnalysis,
  type ImageLandmark,
  type SemanticRegion,
} from '../src/index.js'

function rectangleMask(
  width: number,
  height: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): BinaryMask {
  return {
    width,
    height,
    values: Float32Array.from({ length: width * height }, (_, index) => {
      const x = index % width
      const y = Math.floor(index / width)
      return x >= left && x < right && y >= top && y < bottom ? 1 : 0
    }),
  }
}

function region(id: string, mask: BinaryMask, label = id): SemanticRegion {
  return {
    id,
    label,
    mask,
    confidence: 0.94,
    importance: 1,
    provenance: [{ origin: 'model', provider: 'grounded-sam2-local', version: 'fixture' }],
  }
}

function landmark(
  instanceId: string,
  id: string,
  kind: ImageLandmark['kind'],
  x: number,
  y: number,
): ImageLandmark {
  return {
    id: `${instanceId}:${id}`,
    kind,
    x,
    y,
    confidence: 0.95,
    priority: 'hard',
    observationState: 'observed',
    provenance: [{ origin: 'model', provider: 'mmpose-animal-local', version: 'fixture' }],
  }
}

function twoPetAnalysis(): ImageAnalysis {
  const width = 160
  const height = 80
  const first = rectangleMask(width, height, 8, 12, 52, 70)
  const second = rectangleMask(width, height, 132, 24, 148, 54)
  const union = {
    width,
    height,
    values: Float32Array.from({ length: width * height }, (_, index) =>
      Math.max(first.values[index] ?? 0, second.values[index] ?? 0)),
  }
  return {
    imageType: 'pet',
    confidence: 0.95,
    subjectMask: union,
    subjectMaskEvidence: {
      mask: union,
      confidence: 0.95,
      source: 'ai',
      revision: 'grounded-fixture',
      provenance: [{ origin: 'model', provider: 'grounded-sam2-local', version: 'fixture' }],
    },
    semanticRegions: [
      region('subject', union, 'all pets'),
      region('pet-01:subject', first, 'pet instance'),
      region('pet-01:pet-face', rectangleMask(width, height, 14, 16, 46, 42), 'pet face'),
      region('pet-02:subject', second, 'pet instance'),
      region('pet-02:pet-face', rectangleMask(width, height, 134, 25, 146, 39), 'pet face'),
    ],
    landmarks: [
      landmark('pet-01', 'left-eye', 'eye', 24, 25),
      landmark('pet-01', 'right-eye', 'eye', 36, 25),
      landmark('pet-01', 'nose', 'nose', 30, 34),
      landmark('pet-02', 'left-eye', 'eye', 137, 31),
      landmark('pet-02', 'right-eye', 'eye', 143, 31),
      landmark('pet-02', 'nose', 'nose', 140, 37),
    ],
    suggestedCrop: { x: 4, y: 8, width: 148, height: 66 },
    suggestedCropConfidence: 0.95,
    suggestedCropSource: 'automatic',
    modelVersions: {
      segmentation: 'grounded-sam2-fixture',
      keypoints: 'mmpose-fixture',
    },
  }
}

describe('pet composition planning', () => {
  it('returns the group view plus a proportional square focus view for every pet instance', () => {
    const analysis = twoPetAnalysis()
    const variants = planPetCompositionVariants({
      image: { width: 160, height: 80 },
      analysis,
      targetAspectRatio: 1,
    })

    assert.deepEqual(variants.map((variant) => variant.id), [
      'pet-group',
      'pet-focus-pet-01',
      'pet-focus-pet-02',
    ])
    assert.equal(variants[0]!.strategy, 'group')
    assert.equal(variants[0]!.analysis, analysis)
    for (const variant of variants.slice(1)) {
      assert.equal(variant.strategy, 'instance-focus')
      assert.ok(Math.abs(variant.crop.width / variant.crop.height - 1) < 1e-9)
      assert.ok(variant.crop.x >= 0 && variant.crop.y >= 0)
      assert.ok(variant.crop.x + variant.crop.width <= 160)
      assert.ok(variant.crop.y + variant.crop.height <= 80)
      assert.ok(variant.relativeScaleGain > 1)
      assert.ok(variant.subjectCoverage > 0)
    }
  })

  it('isolates the selected pet evidence so another instance cannot affect focused generation', () => {
    const variants = planPetCompositionVariants({
      image: { width: 160, height: 80 },
      analysis: twoPetAnalysis(),
    })
    const second = variants.find((variant) => variant.id === 'pet-focus-pet-02')!

    assert.deepEqual(second.instanceIds, ['pet-02'])
    assert.ok(second.analysis.landmarks?.every((item) => item.id.startsWith('pet-02:')))
    assert.ok(second.analysis.semanticRegions?.some((item) => item.id === 'pet-02:subject'))
    assert.equal(second.analysis.semanticRegions?.some((item) => item.id.startsWith('pet-01:')), false)
    assert.equal(second.analysis.subjectMask, second.analysis.subjectMaskEvidence?.mask)
    assert.equal(second.analysis.subjectMask?.values[30 * 160 + 140], 1)
    assert.equal(second.analysis.subjectMask?.values[30 * 160 + 24], 0)
    assert.match(second.analysis.subjectMaskEvidence?.revision ?? '', /pet-02/)
  })

  it('reports a stronger scale gain for the smaller distant pet', () => {
    const variants = planPetCompositionVariants({
      image: { width: 160, height: 80 },
      analysis: twoPetAnalysis(),
    })
    const first = variants.find((variant) => variant.id === 'pet-focus-pet-01')!
    const second = variants.find((variant) => variant.id === 'pet-focus-pet-02')!

    assert.ok(second.relativeScaleGain > first.relativeScaleGain)
    assert.ok(second.subjectCoverage > first.subjectCoverage * 0.5)
  })

  it('keeps a single-pet analysis as one group variant', () => {
    const analysis = twoPetAnalysis()
    analysis.semanticRegions = (analysis.semanticRegions ?? []).filter((item) =>
      item.id === 'subject' || item.id.startsWith('pet-01:'))
    analysis.landmarks = (analysis.landmarks ?? []).filter((item) => item.id.startsWith('pet-01:'))

    const variants = planPetCompositionVariants({
      image: { width: 160, height: 80 },
      analysis,
    })

    assert.deepEqual(variants.map((variant) => variant.id), ['pet-group'])
  })

  it('rejects instance masks whose dimensions differ from the source image', () => {
    const analysis = twoPetAnalysis()
    analysis.semanticRegions = [region('pet-01:subject', rectangleMask(10, 10, 1, 1, 8, 8))]

    assert.throws(() => planPetCompositionVariants({
      image: { width: 160, height: 80 },
      analysis,
    }), /align with the source image/i)
  })
})
