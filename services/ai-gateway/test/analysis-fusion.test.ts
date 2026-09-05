import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fuseImageAnalyses } from '../src/index.js'

describe('analysis fusion', () => {
  it('keeps independent subject, landmark, and semantic confidence', () => {
    const mask = { width: 1, height: 1, values: new Float32Array([1]) }
    const fused = fuseImageAnalyses([
      {
        confidence: 0.35,
        subjectMaskEvidence: {
          mask,
          confidence: 0.35,
          source: 'ai',
          revision: 'mask-1',
          provenance: [{
            origin: 'model',
            provider: 'rembg-http',
            model: 'birefnet-general-lite',
            version: 'mask-v1',
          }],
        },
      },
      {
        confidence: 0.98,
        landmarks: [{
          id: 'left-eye',
          kind: 'eye',
          x: 0,
          y: 0,
          confidence: 0.98,
          priority: 'hard',
          provenance: [{
            origin: 'model',
            provider: 'mediapipe',
            model: 'face-landmarker',
            version: '1',
          }],
        }],
        semanticRegions: [{
          id: 'face-skin',
          label: 'face-skin',
          mask,
          confidence: 0.91,
          provenance: [{
            origin: 'model',
            provider: 'mediapipe',
            model: 'selfie-multiclass',
            version: '1',
          }],
        }],
      },
    ])

    assert.equal(fused.subjectMaskEvidence?.confidence, 0.35)
    assert.equal(fused.landmarks?.[0]?.confidence, 0.98)
    assert.equal(fused.semanticRegions?.[0]?.confidence, 0.91)
    assert.ok((fused.confidence ?? 0) > 0.35)
    assert.ok((fused.confidence ?? 0) < 0.98)
    assert.equal(fused.provenance?.length, 3)
  })

  it('prefers a user-confirmed corrected mask over an AI mask', () => {
    const aiMask = { width: 1, height: 1, values: new Float32Array([0]) }
    const correctedMask = { width: 1, height: 1, values: new Float32Array([1]) }
    const fused = fuseImageAnalyses([
      {
        subjectMaskEvidence: {
          mask: aiMask,
          confidence: 0.99,
          source: 'ai',
          revision: 'ai-1',
        },
      },
      {
        subjectMaskEvidence: {
          mask: correctedMask,
          confidence: 0.8,
          source: 'ai+manual',
          revision: 'manual-1',
          userConfirmed: true,
        },
      },
    ])

    assert.equal(fused.subjectMaskEvidence?.revision, 'manual-1')
    assert.equal(fused.subjectMask?.values[0], 1)
  })

  it('keeps stronger AI evidence ahead of an unconfirmed correction', () => {
    const fused = fuseImageAnalyses([
      {
        subjectMaskEvidence: {
          mask: { width: 1, height: 1, values: new Float32Array([0]) },
          confidence: 0.95,
          source: 'ai',
          revision: 'ai-1',
        },
      },
      {
        subjectMaskEvidence: {
          mask: { width: 1, height: 1, values: new Float32Array([1]) },
          confidence: 0.4,
          source: 'ai+manual',
          revision: 'draft-1',
        },
      },
    ])

    assert.equal(fused.subjectMaskEvidence?.revision, 'ai-1')
  })

  it('calibrates subject confidence so a heuristic mask cannot outrank solid model evidence', () => {
    const fused = fuseImageAnalyses([
      {
        subjectMaskEvidence: {
          mask: { width: 1, height: 1, values: new Float32Array([0]) },
          confidence: 0.99,
          source: 'heuristic',
          revision: 'heuristic-1',
        },
      },
      {
        subjectMaskEvidence: {
          mask: { width: 1, height: 1, values: new Float32Array([1]) },
          confidence: 0.72,
          source: 'ai',
          revision: 'model-1',
        },
      },
    ])

    assert.equal(fused.subjectMaskEvidence?.revision, 'model-1')
  })

  it('calibrates duplicate landmark confidence by evidence origin', () => {
    const landmark = {
      id: 'pet-01:left-eye-center',
      kind: 'eye' as const,
      y: 4,
      priority: 'hard' as const,
    }
    const fused = fuseImageAnalyses([
      {
        landmarks: [{
          ...landmark,
          x: 2,
          confidence: 0.99,
          provenance: [{ origin: 'heuristic' as const, provider: 'ellipse-fit' }],
        }],
      },
      {
        landmarks: [{
          ...landmark,
          x: 5,
          confidence: 0.75,
          provenance: [{ origin: 'model' as const, provider: 'mmpose-animal-local' }],
        }],
      },
    ])

    assert.equal(fused.landmarks?.[0]?.x, 5)
  })

  it('discounts inferred and missing landmark states during evidence selection', () => {
    const landmark = {
      id: 'pet-01:tail-root',
      kind: 'body' as const,
      x: 3,
      y: 4,
      priority: 'hard' as const,
      provenance: [{ origin: 'model' as const, provider: 'mmpose-animal-local' }],
    }
    const fused = fuseImageAnalyses([{
      landmarks: [{ ...landmark, confidence: 0.9, observationState: 'inferred' as const }],
    }, {
      landmarks: [{ ...landmark, confidence: 0.7, observationState: 'missing' as const, x: 8 }],
    }])

    assert.equal(fused.landmarks?.[0]?.observationState, 'inferred')
    assert.equal(fused.landmarks?.[0]?.x, 3)
  })

  it('fuses complementary importance maps with confidence and origin calibration', () => {
    const first = {
      importanceMap: { width: 3, height: 1, weights: new Float32Array([1, 0.2, 0]) },
      confidence: 0.8,
      provenance: [{ origin: 'model' as const, provider: 'teed-local' }],
    }
    const second = {
      importanceMap: { width: 3, height: 1, weights: new Float32Array([0, 0.4, 1]) },
      confidence: 0.9,
      provenance: [{ origin: 'heuristic' as const, provider: 'gradient-edge' }],
    }

    const forward = fuseImageAnalyses([first, second])
    const reversed = fuseImageAnalyses([second, first])

    assert.deepEqual(forward.importanceMap, reversed.importanceMap)
    assert.ok(Math.abs((forward.importanceMap?.weights[0] ?? 0) - 0.76) < 1e-6)
    assert.ok(Math.abs((forward.importanceMap?.weights[1] ?? 0) - 0.234) < 1e-6)
    assert.ok(Math.abs((forward.importanceMap?.weights[2] ?? 0) - 0.585) < 1e-6)
  })

  it('rejects importance maps with incompatible dimensions', () => {
    assert.throws(() => fuseImageAnalyses([{
      importanceMap: { width: 2, height: 1, weights: new Float32Array([1, 0]) },
    }, {
      importanceMap: { width: 1, height: 2, weights: new Float32Array([1, 0]) },
    }]), /importance map dimensions/i)
  })

  it('produces the same fused analysis when evidence order changes', () => {
    const mask = { width: 1, height: 1, values: new Float32Array([1]) }
    const first = {
      subjectMaskEvidence: {
        mask,
        confidence: 0.8,
        source: 'ai' as const,
        revision: 'subject-1',
        provenance: [{ origin: 'model' as const, provider: 'z-provider', version: '1' }],
      },
      landmarks: [{
        id: 'eye',
        kind: 'eye' as const,
        x: 1,
        y: 0,
        confidence: 0.9,
        priority: 'hard' as const,
        provenance: [{ origin: 'model' as const, provider: 'z-provider', version: '1' }],
      }],
      modelVersions: { vision: 'z-version' },
    }
    const second = {
      landmarks: [{
        id: 'eye',
        kind: 'eye' as const,
        x: 0,
        y: 0,
        confidence: 0.9,
        priority: 'hard' as const,
        provenance: [{ origin: 'model' as const, provider: 'a-provider', version: '1' }],
      }],
      semanticRegions: [{
        id: 'face',
        label: 'face',
        mask,
        confidence: 0.7,
        provenance: [{ origin: 'model' as const, provider: 'a-provider', version: '1' }],
      }],
      modelVersions: { vision: 'a-version' },
    }

    const forward = fuseImageAnalyses([first, second])
    const reversed = fuseImageAnalyses([second, first])

    assert.deepEqual(forward, reversed)
    assert.equal(forward.landmarks?.[0]?.x, 0)
    assert.deepEqual(forward.modelVersions, { vision: 'a-version + z-version' })
    assert.deepEqual(forward.provenance?.map((entry) => entry.provider), ['a-provider', 'z-provider'])
  })

  it('reconciles partial pet region namespaces across model providers', () => {
    const mask = { width: 2, height: 1, values: new Float32Array([1, 1]) }
    const fused = fuseImageAnalyses([
      {
        semanticRegions: [{
          id: 'pet-01:subject',
          label: 'subject',
          mask,
          confidence: 0.9,
        }],
      },
      {
        landmarks: [{
          id: 'pet-01:left-eye-center',
          kind: 'eye',
          x: 0,
          y: 0,
          confidence: 0.95,
          priority: 'hard',
          carrierRegionId: 'pet-01:subject',
          featureRegionId: 'pet-01:pet-face',
        }, {
          id: 'pet-01:nose-tip',
          kind: 'nose',
          x: 1,
          y: 0,
          confidence: 0.9,
          priority: 'hard',
          carrierRegionId: 'pet-01:pet-face',
        }],
      },
    ])

    assert.equal(fused.landmarks?.[0]?.carrierRegionId, 'pet-01:subject')
    assert.equal(fused.landmarks?.[0]?.featureRegionId, undefined)
    assert.equal(fused.landmarks?.[1]?.carrierRegionId, 'pet-01:subject')
  })
})
