import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createBlindComparison,
  createGateProtocolState,
  resolveBlindPreference,
  transitionGateProtocol,
} from '../src/protocol.mjs'

const identity = {
  datasetId: 'mask-gate-40',
  manifestFingerprint: 'manifest-fingerprint',
  imageId: 'portrait-01',
  raterId: 'rater-a',
  sampleOrder: 7,
  sampleOrderSeed: 'sample-order-seed',
  coreCommit: 'core-commit',
  demoCommit: 'demo-commit',
  gatewayCommit: 'gateway-commit',
  modelConfigurationId: 'birefnet-lite-post-v1',
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
  strokes: [],
  cursor: 0,
}

async function initialState() {
  const blindComparison = await createBlindComparison(identity)
  return createGateProtocolState({
    ...identity,
    beforeSnapshot: snapshot('before'),
    blindComparison,
  })
}

describe('Mask Gate Protocol V2 state machine', () => {
  it('locks the initial rating before accepting the original subject', async () => {
    const loaded = await initialState()
    const rated = transitionGateProtocol(loaded, {
      type: 'rate-initial',
      acceptable: true,
      at: 1_000,
    })
    const accepted = transitionGateProtocol(rated, { type: 'accept-original', at: 1_200 })

    assert.equal(rated.stage, 'initial-rated')
    assert.equal(rated.initialRatingAt, 1_000)
    assert.equal(accepted.stage, 'accepted')
    assert.equal(accepted.outcome, 'accepted')
    assert.throws(
      () => transitionGateProtocol(rated, { type: 'rate-initial', acceptable: false, at: 1_100 }),
      /stage/i,
    )
  })

  it('runs the confirmed path through corrected-mask and blind-pattern ratings', async () => {
    let state = await initialState()
    state = transitionGateProtocol(state, { type: 'rate-initial', acceptable: false, at: 1_000 })
    state = transitionGateProtocol(state, { type: 'start-editing', at: 1_100 })
    state = transitionGateProtocol(state, {
      type: 'confirm-editing',
      at: 8_000,
      session,
      afterSnapshot: snapshot('after'),
    })
    state = transitionGateProtocol(state, {
      type: 'rate-corrected-mask',
      acceptable: true,
      at: 8_100,
    })
    state = transitionGateProtocol(state, {
      type: 'rate-blind-pattern',
      choice: 'left',
      at: 8_200,
    })
    state = transitionGateProtocol(state, { type: 'export', at: 8_300 })

    assert.equal(state.stage, 'exported')
    assert.equal(state.outcome, 'confirmed')
    assert.equal(state.correctionStartedAt, 1_100)
    assert.equal(state.correctionEndedAt, 8_000)
    assert.equal(state.subjectAcceptable, true)
    assert.equal(state.blindComparison.choice, 'left')
  })

  it('exports cancelled and error outcomes without corrected ratings', async () => {
    let cancelled = await initialState()
    cancelled = transitionGateProtocol(cancelled, {
      type: 'rate-initial', acceptable: false, at: 1_000,
    })
    cancelled = transitionGateProtocol(cancelled, { type: 'start-editing', at: 1_100 })
    cancelled = transitionGateProtocol(cancelled, {
      type: 'cancel-editing', at: 2_000, session,
    })
    cancelled = transitionGateProtocol(cancelled, { type: 'export', at: 2_100 })

    let failed = await initialState()
    failed = transitionGateProtocol(failed, {
      type: 'rate-initial', acceptable: false, at: 1_000,
    })
    failed = transitionGateProtocol(failed, {
      type: 'record-error', at: 1_300, code: 'generation-failed', message: 'failed',
    })
    failed = transitionGateProtocol(failed, { type: 'export', at: 1_400 })

    assert.equal(cancelled.outcome, 'cancelled')
    assert.equal(cancelled.stage, 'exported')
    assert.equal(failed.outcome, 'error')
    assert.equal(failed.error.code, 'generation-failed')
  })
})

describe('Mask Gate Protocol V2 blind comparison', () => {
  it('uses a stable assignment and resolves the hidden preference', async () => {
    const first = await createBlindComparison(identity)
    const second = await createBlindComparison(identity)

    assert.deepEqual(first, second)
    assert.match(first.seed, /^[a-f0-9]{64}$/)
    assert.equal(resolveBlindPreference({ ...first, choice: 'tie' }), 'tie')
    assert.equal(
      resolveBlindPreference({ ...first, choice: 'left' }),
      first.leftVariant,
    )
    assert.equal(
      resolveBlindPreference({ ...first, choice: 'right' }),
      first.leftVariant === 'before' ? 'after' : 'before',
    )
  })
})
