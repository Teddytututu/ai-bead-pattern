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
})
