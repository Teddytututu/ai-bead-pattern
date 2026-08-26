import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createIndependentMaskGatePreferenceRecord,
  createMaskGateInteractionRecord,
  createMaskGatePreferenceRecord,
} from '../src/record.mjs'

const sample = {
  imageId: 'portrait-01',
  category: 'portrait',
  cohort: 'targeted-failure',
  failureTags: ['fine-hair'],
}

const snapshot = (id) => ({
  generationId: `generation-${id}`,
  candidateId: `candidate-${id}`,
  patternHash: `pattern-${id}`,
  optionsHash: `options-${id}`,
  width: 48,
  height: 48,
  colorCount: 12,
  totalBeads: 1_400,
})

const session = {
  baseRevision: 'sidecar:mask',
  strokes: [{
    id: 'stroke-1',
    mode: 'add',
    radiusNormalized: 0.02,
    points: [{ x: 0.5, y: 0.5 }],
  }],
  cursor: 1,
}

const device = {
  class: 'mobile',
  inputModality: 'touch',
  viewportWidth: 390,
  viewportHeight: 844,
  devicePixelRatio: 3,
  maxTouchPoints: 5,
  platform: 'Android',
}

function baseInput() {
  return {
    protocolVersion: 'mask-gate-v2',
    attemptId: 'attempt-1',
    datasetId: 'mask-gate-40',
    manifestFingerprint: 'manifest-fingerprint',
    raterId: 'rater-a',
    sampleOrder: 1,
    sampleOrderSeed: 'order-seed',
    coreCommit: 'core-commit',
    demoCommit: 'demo-commit',
    gatewayCommit: 'gateway-commit',
    modelConfigurationId: 'birefnet-lite-post-v1',
    sample,
    sourceEvidence: { revision: 'sidecar:mask', confidence: 0.8 },
    initialRatingAt: 1_000,
    initialSubjectAcceptable: false,
    beforeSnapshot: snapshot('before'),
    device,
  }
}

describe('Mask Gate V2 interaction records', () => {
  it('stores resolved edit efficiency without a visible preference field', () => {
    const record = createMaskGateInteractionRecord({
      ...baseInput(),
      outcome: 'confirmed',
      outcomeAt: 8_000,
      correctionStartedAt: 1_100,
      correctionEndedAt: 8_000,
      subjectAcceptable: true,
      session,
      baseMaskValues: Float32Array.from([0, 1]),
      correctedMaskValues: Float32Array.from([1, 1]),
      confirmedRevision: 'confirmed:mask',
      afterSnapshot: snapshot('after'),
    })

    assert.equal(record.schemaVersion, 2)
    assert.equal(record.correctionDurationMs, 6_900)
    assert.equal(record.strokeCount, 1)
    assert.equal(record.device.inputModality, 'touch')
    assert.equal('patternPreference' in record, false)
  })

  it('stores accepted controls without correction artifacts', () => {
    const record = createMaskGateInteractionRecord({
      ...baseInput(),
      initialSubjectAcceptable: true,
      outcome: 'accepted',
      outcomeAt: 1_200,
    })

    assert.equal(record.outcome, 'accepted')
    assert.equal(record.strokeCount, 0)
    assert.equal(record.correctionAreaRatio, 0)
    assert.equal('correctionStartedAt' in record, false)
    assert.equal('session' in record, false)
  })

  it('keeps cancelled and error attempts in a valid interaction shape', () => {
    const cancelled = createMaskGateInteractionRecord({
      ...baseInput(),
      outcome: 'cancelled',
      outcomeAt: 2_000,
      correctionStartedAt: 1_100,
      correctionEndedAt: 2_000,
      session,
      baseMaskValues: Float32Array.from([0, 1]),
      correctedMaskValues: Float32Array.from([1, 1]),
    })
    const failed = createMaskGateInteractionRecord({
      ...baseInput(),
      outcome: 'error',
      outcomeAt: 1_300,
      error: { code: 'generation-failed', message: 'failed' },
    })

    assert.equal(cancelled.outcome, 'cancelled')
    assert.equal(failed.outcome, 'error')
    assert.equal(failed.error.code, 'generation-failed')
  })
})

describe('Mask Gate V2 preference records', () => {
  it('restores the hidden before/after preference from A/B choice', () => {
    const preference = createMaskGatePreferenceRecord({
      ...baseInput(),
      afterSnapshot: snapshot('after'),
      ratedAt: 8_200,
      blindComparison: {
        leftVariant: 'after',
        choice: 'left',
        seed: 'a'.repeat(64),
      },
    })

    assert.equal(preference.preferenceId, 'portrait-01:rater-a')
    assert.equal(preference.patternPreference, 'after')
    assert.equal(preference.blindComparison.leftVariant, 'after')
  })

  it('creates an independent blind preference against a confirmed interaction', async () => {
    const interaction = createMaskGateInteractionRecord({
      ...baseInput(),
      outcome: 'confirmed',
      outcomeAt: 8_000,
      correctionStartedAt: 1_100,
      correctionEndedAt: 8_000,
      subjectAcceptable: true,
      session,
      baseMaskValues: Float32Array.from([0, 1]),
      correctedMaskValues: Float32Array.from([1, 1]),
      confirmedRevision: 'confirmed:mask',
      afterSnapshot: snapshot('after'),
    })
    const preference = await createIndependentMaskGatePreferenceRecord({
      interaction,
      raterId: 'reviewer-b',
      choice: 'left',
      ratedAt: 13_000,
    })
    assert.equal(preference.preferenceId, 'portrait-01:reviewer-b')
    assert.equal(preference.attemptId, interaction.attemptId)
    assert.match(preference.blindComparison.seed, /^[a-f0-9]{64}$/)
  })
})
