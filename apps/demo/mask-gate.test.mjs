import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createMaskGateAttempt,
  resolveMaskGateSample,
} from './mask-gate.mjs'

function session() {
  return {
    baseRevision: 'sidecar:source:u8:fingerprint',
    strokes: [{
      id: 'stroke-1',
      mode: 'add',
      radiusNormalized: 0.02,
      points: [{ x: 0.5, y: 0.5 }],
    }],
    cursor: 1,
  }
}

describe('demo mask gate helpers', () => {
  it('resolves the selected sidecar relative to the index URL', () => {
    const resolved = resolveMaskGateSample(
      'http://127.0.0.1:4174/work/mask-gate/sidecars/index.json',
      {
        schemaVersion: 1,
        datasetId: 'pilot-a',
        samples: [{
          imageId: 'portrait-01',
          category: 'portrait',
          cohort: 'failure',
          failureType: 'fine-hair',
          analysis: 'portrait-01.analysis.json',
        }],
      },
      'portrait-01',
    )

    assert.equal(resolved.datasetId, 'pilot-a')
    assert.equal(resolved.sample.imageId, 'portrait-01')
    assert.equal(
      resolved.analysisUrl,
      'http://127.0.0.1:4174/work/mask-gate/sidecars/portrait-01.analysis.json',
    )
  })

  it('creates a confirmed attempt with timing, generation ids, and the saved session', () => {
    const attempt = createMaskGateAttempt({
      imageId: 'portrait-01',
      outcome: 'confirmed',
      correctionStartedAt: 1_000,
      correctionEndedAt: 11_000,
      beforeGenerationId: 'before-1',
      afterGenerationId: 'after-1',
      initialSubjectAcceptable: false,
      subjectAcceptable: true,
      patternPreference: 'after',
      deviceClass: 'mobile',
      session: session(),
    })

    assert.equal(attempt.correctionEndedAt - attempt.correctionStartedAt, 10_000)
    assert.equal(attempt.afterGenerationId, 'after-1')
    assert.equal(attempt.session.cursor, 1)
  })

  it('creates a cancellation without confirmation artifacts', () => {
    const attempt = createMaskGateAttempt({
      imageId: 'portrait-01',
      outcome: 'cancelled',
      correctionStartedAt: 1_000,
      correctionEndedAt: 4_000,
      beforeGenerationId: 'before-1',
      deviceClass: 'desktop',
      session: session(),
    })

    assert.equal(attempt.subjectAcceptable, false)
    assert.equal(attempt.patternPreference, 'unrated')
    assert.equal('afterGenerationId' in attempt, false)
  })
})
