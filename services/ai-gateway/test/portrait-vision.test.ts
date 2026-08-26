import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ImageAnalysis } from '@ai-bead-pattern/pattern-core'

import {
  analyzePortrait,
  mapMediaPipeFaceLandmarks,
  mapPortraitSemanticRegions,
  MediaPipeFaceLandmarkProvider,
  MediaPipePortraitSemanticProvider,
  selectPrimaryFace,
  type MediaPipeFaceCandidate,
} from '../src/index.js'

function face({
  left = 0.2,
  top = 0.2,
  right = 0.8,
  bottom = 0.8,
  confidence = 0.95,
}: {
  left?: number
  top?: number
  right?: number
  bottom?: number
  confidence?: number
} = {}): MediaPipeFaceCandidate {
  const width = right - left
  const height = bottom - top
  const point = (x: number, y: number) => ({ x: left + width * x, y: top + height * y, z: 0 })
  const landmarks = Array.from({ length: 478 }, () => point(0.5, 0.5))
  landmarks[234] = point(0, 0.5)
  landmarks[454] = point(1, 0.5)
  landmarks[10] = point(0.5, 0)
  landmarks[152] = point(0.5, 1)
  landmarks[468] = point(0.3, 0.3666666667)
  landmarks[473] = point(0.7, 0.3666666667)
  landmarks[1] = point(0.5, 0.5333333333)
  landmarks[61] = point(0.3833333333, 0.7166666667)
  landmarks[291] = point(0.6166666667, 0.7166666667)
  landmarks[13] = point(0.5, 0.6833333333)
  landmarks[14] = point(0.5, 0.75)
  return { landmarks, confidence }
}

describe('Portrait Vision face landmarks', () => {
  it('selects a clearly dominant primary face and flags close multi-face cases', () => {
    assert.deepEqual(selectPrimaryFace([face(), face({ left: 0.05, top: 0.05, right: 0.2, bottom: 0.2 })]), {
      status: 'primary',
      primaryFaceIndex: 0,
    })
    assert.deepEqual(selectPrimaryFace([face(), face({ left: 0.15, top: 0.15, right: 0.75, bottom: 0.75 })]), {
      status: 'ambiguous',
    })
    assert.deepEqual(selectPrimaryFace([]), { status: 'none' })
  })

  it('uses stable face contour anchors when an interior mesh point is an outlier', () => {
    const dominant = face()
    const noisy = face({ left: 0.05, top: 0.05, right: 0.2, bottom: 0.2 })
    ;(noisy.landmarks as { x: number, y: number }[])[100] = { x: 100, y: 100 }

    assert.deepEqual(selectPrimaryFace([dominant, noisy]), {
      status: 'primary',
      primaryFaceIndex: 0,
    })
  })

  it('maps the stable MediaPipe anchors into source-image coordinates', () => {
    const landmarks = mapMediaPipeFaceLandmarks(face(), {
      width: 200,
      height: 100,
      modelVersion: 'face-landmarker-v1',
    })
    assert.deepEqual(landmarks.map((landmark) => landmark.id), [
      'chin',
      'face-left',
      'face-right',
      'left-eye-center',
      'mouth-center',
      'mouth-left',
      'mouth-right',
      'nose-tip',
      'right-eye-center',
    ])
    const leftEye = landmarks.find((landmark) => landmark.id === 'left-eye-center')
    assert.ok(Math.abs((leftEye?.x ?? 0) - 124) < 1e-6)
    assert.ok(Math.abs((leftEye?.y ?? 0) - 42) < 1e-6)
    assert.equal(leftEye?.kind, 'eye')
    assert.equal(leftEye?.priority, 'hard')
    assert.equal(leftEye?.symmetryGroup, 'eyes')
    assert.equal(landmarks.every((landmark) => landmark.carrierRegionId === 'face-skin'), true)
  })

  it('exposes face inference through a cancellable provider boundary', async () => {
    const controller = new AbortController()
    const provider = new MediaPipeFaceLandmarkProvider({
      detect: async (request) => {
        assert.equal(request.image.width, 2)
        assert.equal(request.signal, controller.signal)
        return { faces: [face()], modelVersion: 'face-v1' }
      },
    })
    const result = await provider.analyze({
      image: { width: 2, height: 2, data: new Uint8ClampedArray(16) },
      signal: controller.signal,
    })
    assert.equal(result.status, 'primary')
    assert.equal(result.analysis.landmarks?.length, 9)
    assert.equal(result.analysis.modelVersions?.faceLandmarks, 'mediapipe/face-v1')
  })
})

describe('Portrait Vision semantic regions', () => {
  const subjectAnalysis: ImageAnalysis = {
    subjectMaskEvidence: {
      mask: { width: 2, height: 2, values: new Float32Array([1, 1, 0, 0]) },
      confidence: 1,
      source: 'manual',
      revision: 'manual:test',
      userConfirmed: true,
    },
  }

  it('intersects portrait classes with authoritative corrected subject evidence', () => {
    const analysis = mapPortraitSemanticRegions({
      subjectAnalysis,
      width: 2,
      height: 2,
      categories: {
        hair: new Float32Array([1, 0, 1, 0]),
        'face-skin': new Float32Array([0, 1, 1, 0]),
        'body-skin': new Float32Array([0, 0, 0, 0]),
        clothes: new Float32Array([0, 0, 1, 1]),
      },
      modelVersion: 'selfie-multiclass-v1',
    })
    const regions = new Map(analysis.semanticRegions?.map((region) => [region.id, region]))
    assert.deepEqual([...regions.get('subject')!.mask.values], [1, 1, 0, 0])
    assert.deepEqual([...regions.get('hair')!.mask.values], [1, 0, 0, 0])
    assert.deepEqual([...regions.get('face-skin')!.mask.values], [0, 1, 0, 0])
    assert.equal(regions.has('body-skin'), false)
    assert.equal(regions.has('clothes'), false)
  })

  it('rejects incomplete or non-finite semantic model tensors', () => {
    assert.throws(() => mapPortraitSemanticRegions({
      subjectAnalysis,
      width: 2,
      height: 2,
      categories: {
        hair: new Float32Array([1, Number.NaN, 0, 0]),
        'face-skin': new Float32Array(4),
        'body-skin': new Float32Array(4),
        clothes: new Float32Array(4),
      },
      modelVersion: 'semantic-v1',
    }), /hair.*finite/i)

    assert.throws(() => mapPortraitSemanticRegions({
      subjectAnalysis,
      width: 2,
      height: 2,
      categories: {
        hair: new Float32Array(4),
        'face-skin': undefined,
        'body-skin': new Float32Array(4),
        clothes: new Float32Array(4),
      } as unknown as Parameters<typeof mapPortraitSemanticRegions>[0]['categories'],
      modelVersion: 'semantic-v1',
    }), /face-skin.*Float32Array/i)
  })

  it('exposes semantic inference through a subject-aware provider boundary', async () => {
    const provider = new MediaPipePortraitSemanticProvider({
      segment: async () => ({
        width: 2,
        height: 2,
        categories: {
          hair: new Float32Array([1, 0, 0, 0]),
          'face-skin': new Float32Array([0, 1, 0, 0]),
          'body-skin': new Float32Array(4),
          clothes: new Float32Array(4),
        },
        modelVersion: 'semantic-v1',
      }),
    })
    const result = await provider.analyze({
      image: { width: 2, height: 2, data: new Uint8ClampedArray(16) },
      subjectAnalysis,
    })
    assert.deepEqual(result.analysis.semanticRegions?.map((region) => region.id), [
      'subject',
      'face-skin',
      'hair',
    ])
    assert.equal(result.analysis.modelVersions?.portraitSemantics, 'mediapipe/semantic-v1')
  })

  it('returns portrait analysis only for an unambiguous primary face', () => {
    const primary = analyzePortrait({
      subjectAnalysis,
      faces: [face()],
      semanticCategories: {
        hair: new Float32Array([1, 0, 0, 0]),
        'face-skin': new Float32Array([0, 1, 0, 0]),
        'body-skin': new Float32Array(4),
        clothes: new Float32Array(4),
      },
      width: 2,
      height: 2,
      faceModelVersion: ' face-v1 ',
      semanticModelVersion: 'semantic-v1',
    })
    assert.equal(primary.status, 'primary')
    assert.equal(primary.analysis.imageType, 'portrait')
    assert.equal(primary.analysis.landmarks?.length, 9)
    assert.equal(primary.analysis.subjectMaskEvidence?.revision, 'manual:test')
    assert.equal(primary.analysis.modelVersions?.faceLandmarks, 'mediapipe/face-v1')

    const ambiguous = analyzePortrait({
      subjectAnalysis,
      faces: [face(), face()],
      semanticCategories: {
        hair: new Float32Array(4),
        'face-skin': new Float32Array(4),
        'body-skin': new Float32Array(4),
        clothes: new Float32Array(4),
      },
      width: 2,
      height: 2,
      faceModelVersion: 'face-v1',
      semanticModelVersion: 'semantic-v1',
    })
    assert.equal(ambiguous.status, 'ambiguous')
    assert.equal(ambiguous.analysis.landmarks, undefined)
  })
})
