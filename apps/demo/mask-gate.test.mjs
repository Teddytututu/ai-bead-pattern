import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createBlindComparison,
  createGatePatternSnapshot,
  createMaskGateAttempt,
  detectMaskGateDevice,
  resolveMaskGateSample,
} from './mask-gate.mjs'

const snapshot = {
  generationId: 'generation-1',
  candidateId: 'candidate-1',
  patternHash: 'pattern-hash',
  optionsHash: 'options-hash',
  width: 32,
  height: 32,
  colorCount: 8,
  totalBeads: 500,
}

const identity = {
  protocolVersion: 'mask-gate-v2',
  datasetId: 'pilot-a',
  manifestFingerprint: 'manifest-hash',
  imageId: 'portrait-01',
  raterId: 'rater-a',
  sampleOrder: 1,
  sampleOrderSeed: 'order-seed',
  coreCommit: 'core-commit',
  demoCommit: 'demo-commit',
  gatewayCommit: 'gateway-commit',
  modelConfigurationId: 'birefnet-general-lite-v1',
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
        schemaVersion: 2,
        protocolVersion: 'mask-gate-v2',
        datasetId: 'pilot-a',
        manifestFingerprint: 'manifest-hash',
        sampleOrderSeed: 'order-seed',
        modelConfigurationId: 'birefnet-general-lite-v1',
        commits: {
          core: 'core-commit',
          demo: 'demo-commit',
          gateway: 'gateway-commit',
        },
        samples: [{
          imageId: 'portrait-01',
          category: 'portrait',
          cohort: 'targeted-failure',
          failureTags: ['fine-hair'],
          sampleOrder: 1,
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

  it('creates a confirmed attempt with protocol identity, snapshots, and the saved session', () => {
    const attempt = createMaskGateAttempt({
      ...identity,
      outcome: 'confirmed',
      attemptId: 'attempt-1',
      initialRatingAt: 900,
      correctionStartedAt: 1_000,
      correctionEndedAt: 11_000,
      outcomeAt: 11_000,
      beforeSnapshot: snapshot,
      afterSnapshot: { ...snapshot, generationId: 'generation-2' },
      initialSubjectAcceptable: false,
      subjectAcceptable: true,
      blindComparison: { leftVariant: 'before', choice: 'right', seed: 'seed' },
      ratedAt: 12_000,
      device,
      session: session(),
    })

    assert.equal(attempt.correctionEndedAt - attempt.correctionStartedAt, 10_000)
    assert.equal(attempt.afterSnapshot.generationId, 'generation-2')
    assert.equal(attempt.device.inputModality, 'touch')
    assert.equal(attempt.session.cursor, 1)
  })

  it('creates a cancellation without confirmation artifacts', () => {
    const attempt = createMaskGateAttempt({
      ...identity,
      outcome: 'cancelled',
      attemptId: 'attempt-2',
      initialRatingAt: 900,
      correctionStartedAt: 1_000,
      correctionEndedAt: 4_000,
      outcomeAt: 4_000,
      beforeSnapshot: snapshot,
      initialSubjectAcceptable: false,
      device: { ...device, class: 'desktop', inputModality: 'mouse' },
      session: session(),
    })

    assert.equal('subjectAcceptable' in attempt, false)
    assert.equal('afterSnapshot' in attempt, false)
  })

  it('creates stable blind assignments and pattern snapshots', async () => {
    const first = await createBlindComparison(identity)
    const second = await createBlindComparison(identity)
    assert.deepEqual(first, second)

    const generated = await createGatePatternSnapshot({
      generationId: 'generation-3',
      candidate: {
        id: 'candidate-3',
        pattern: {
          width: 2,
          height: 1,
          cells: [{ x: 0, y: 0, colorId: 'red' }],
          metadata: { totalBeads: 1 },
        },
        materialCounts: [{ colorId: 'red', count: 1 }],
      },
      options: { maxColors: 8 },
    })
    assert.equal(generated.width, 2)
    assert.match(generated.patternHash, /^[a-f0-9]{64}$/)
    assert.match(generated.optionsHash, /^[a-f0-9]{64}$/)
  })

  it('records the first pointer modality while retaining viewport metadata', () => {
    const detected = detectMaskGateDevice({
      innerWidth: 820,
      innerHeight: 1180,
      devicePixelRatio: 2,
      navigator: { maxTouchPoints: 5, platform: 'iPad' },
    }, 'pen')
    assert.equal(detected.class, 'tablet')
    assert.equal(detected.inputModality, 'pen')
  })
})
