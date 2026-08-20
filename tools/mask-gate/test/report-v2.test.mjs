import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { summarizeMaskGate } from '../src/report.mjs'

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

function interaction(overrides = {}) {
  const imageId = overrides.imageId ?? 'portrait-01'
  const outcome = overrides.outcome ?? 'confirmed'
  const edited = outcome === 'confirmed' || outcome === 'cancelled'
  return {
    schemaVersion: 2,
    protocolVersion: 'mask-gate-v2',
    attemptId: `attempt-${imageId}`,
    datasetId: 'mask-gate-40',
    manifestFingerprint: 'manifest-fingerprint',
    imageId,
    category: 'portrait',
    cohort: 'targeted-failure',
    failureTags: ['fine-hair'],
    raterId: 'editor-a',
    sampleOrder: 1,
    sampleOrderSeed: 'order-seed',
    coreCommit: 'core-commit',
    demoCommit: 'demo-commit',
    gatewayCommit: 'gateway-commit',
    modelConfigurationId: 'birefnet-lite-post-v1',
    sourceRevision: 'sidecar:mask',
    sourceConfidence: 0.8,
    initialRatingAt: 1_000,
    initialSubjectAcceptable: false,
    outcome,
    outcomeAt: 11_000,
    beforeSnapshot: snapshot('before'),
    device: {
      class: 'mobile',
      inputModality: 'touch',
      viewportWidth: 390,
      viewportHeight: 844,
      devicePixelRatio: 3,
      maxTouchPoints: 5,
      platform: 'Android',
    },
    strokeCount: edited ? 2 : 0,
    addStrokeCount: edited ? 1 : 0,
    eraseStrokeCount: edited ? 1 : 0,
    correctionAreaRatio: edited ? 0.1 : 0,
    ...(edited ? {
      correctionStartedAt: 1_000,
      correctionEndedAt: 11_000,
      correctionDurationMs: 10_000,
      session: {
        baseRevision: 'sidecar:mask',
        strokes: [
          { id: 'add-1', mode: 'add', radiusNormalized: 0.02, points: [] },
          { id: 'erase-1', mode: 'erase', radiusNormalized: 0.02, points: [] },
        ],
        cursor: 2,
      },
    } : {}),
    ...(outcome === 'confirmed' ? {
      confirmedRevision: 'confirmed:mask',
      afterSnapshot: snapshot('after'),
      subjectAcceptable: true,
    } : {}),
    ...overrides,
  }
}

function preference(imageId = 'portrait-01', patternPreference = 'after') {
  const leftVariant = patternPreference === 'after' ? 'after' : 'before'
  return {
    schemaVersion: 2,
    protocolVersion: 'mask-gate-v2',
    preferenceId: `${imageId}:rater-b`,
    attemptId: `attempt-${imageId}`,
    datasetId: 'mask-gate-40',
    manifestFingerprint: 'manifest-fingerprint',
    imageId,
    category: 'portrait',
    cohort: 'targeted-failure',
    failureTags: ['fine-hair'],
    raterId: 'rater-b',
    sampleOrder: 1,
    sampleOrderSeed: 'order-seed',
    coreCommit: 'core-commit',
    demoCommit: 'demo-commit',
    gatewayCommit: 'gateway-commit',
    modelConfigurationId: 'birefnet-lite-post-v1',
    beforeSnapshot: snapshot('before'),
    afterSnapshot: snapshot('after'),
    blindComparison: { leftVariant, choice: 'left', seed: 'a'.repeat(64) },
    patternPreference,
    ratedAt: 12_000,
  }
}

const thresholds = {
  minimumTotalSamples: 3,
  minimumMobileSamples: 1,
  minimumInitialFailureSamples: 2,
  targetInitialFailureSamples: 2,
  minimumCategoryCounts: { portrait: 1, pet: 0, illustration: 0, object: 0 },
  minimumCohortCounts: { 'targeted-failure': 2, 'clean-control': 1, extreme: 0 },
  minimumMobileCategoryCounts: { portrait: 1, pet: 0, illustration: 0, object: 0 },
  requireManifest: false,
  acceptableWithin30SecondsRate: 0.5,
  p50CorrectionTimeMs: 15_000,
  p90CorrectionTimeMs: 30_000,
  medianStrokeCount: 6,
  afterPreferenceRate: 0.75,
  controlPreservationRate: 0.9,
  minimumPreferenceRatingsPerConfirmedSample: 1,
}

describe('Mask Gate V2 report statistics', () => {
  it('keeps cancelled and error failures in success rate while using resolved failures for efficiency', () => {
    const interactions = [
      interaction({ imageId: 'resolved' }),
      interaction({ imageId: 'cancelled', outcome: 'cancelled', subjectAcceptable: undefined,
        confirmedRevision: undefined, afterSnapshot: undefined }),
      interaction({
        imageId: 'control',
        category: 'object',
        cohort: 'clean-control',
        failureTags: ['hard-corner'],
        initialSubjectAcceptable: true,
        outcome: 'accepted',
        correctionStartedAt: undefined,
        correctionEndedAt: undefined,
        correctionDurationMs: undefined,
        session: undefined,
        strokeCount: 0,
        addStrokeCount: 0,
        eraseStrokeCount: 0,
        correctionAreaRatio: 0,
        subjectAcceptable: undefined,
        confirmedRevision: undefined,
        afterSnapshot: undefined,
      }),
    ]
    const summary = summarizeMaskGate(interactions, [preference('resolved')], thresholds)

    assert.equal(summary.initialFailureSampleCount, 2)
    assert.equal(summary.resolvedFailureSampleCount, 1)
    assert.equal(summary.acceptableWithin30SecondsRate, 0.5)
    assert.equal(summary.p50CorrectionTimeMs, 10_000)
    assert.equal(summary.medianStrokeCount, 2)
    assert.equal(summary.controlPreservationRate, 1)
    assert.equal(summary.afterPreferenceRate, 1)
    assert.ok(summary.intervals.acceptableWithin30Seconds.lower < 0.5)
  })

  it('counts only touch or pen mobile observations toward real-device coverage', () => {
    const desktopTouch = interaction({
      device: {
        class: 'mobile',
        inputModality: 'mouse',
        viewportWidth: 390,
        viewportHeight: 844,
        devicePixelRatio: 1,
        maxTouchPoints: 0,
        platform: 'Windows',
      },
    })
    const summary = summarizeMaskGate([desktopTouch], [preference()], {
      ...thresholds,
      minimumTotalSamples: 1,
      minimumInitialFailureSamples: 1,
      minimumCohortCounts: { 'targeted-failure': 1, 'clean-control': 0, extreme: 0 },
    })

    assert.equal(summary.mobileSampleCount, 0)
    assert.equal(summary.criteria.mobileCoverage, false)
  })
})
