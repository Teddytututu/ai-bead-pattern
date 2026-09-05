import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DINOV2_FEATURE_NAMES,
  DINOV2_MODEL_ID,
  DINOV2_PROVIDER_ID,
  createDinoV2CandidateScorer,
  dinoV2NeuralFeature,
  normalizeDinoV2CandidateScore,
  scoreDinoV2Candidate,
} from '../src/dinov2-candidate-scorer.mjs'

const model = {
  providerId: DINOV2_PROVIDER_ID,
  modelId: DINOV2_MODEL_ID,
  modelVersion: 'transformers-5.16.1+dinov2-vits14',
  sourceRevision: '7764ea0f912e53c92e82eb78a2a1631e92725fc8',
  weightSource: 'https://huggingface.co/facebook/dinov2-small/tree/ed25f3a31f01632728cabb09d1542f84ab7b0056',
  weightRevision: 'hf:ed25f3a31f01632728cabb09d1542f84ab7b0056',
  license: {
    spdx: 'Apache-2.0',
    name: 'Apache License 2.0',
    url: 'https://github.com/facebookresearch/dinov2/blob/7764ea0f912e53c92e82eb78a2a1631e92725fc8/LICENSE',
  },
}

const views = ['global', 'subject', 'head', 'critical-local']
const metrics = [
  'identitySimilarity',
  'patchCorrespondence',
  'criticalPatchRetention',
  'regionalCoverage',
]

function regionalComparisons(offset = 0) {
  return views.map((view, viewIndex) => ({
    view,
    identitySimilarity: 0.94 - offset - viewIndex * 0.01,
    patchCorrespondence: 0.9 - offset - viewIndex * 0.01,
    criticalPatchRetention: 0.86 - offset - viewIndex * 0.01,
    regionalCoverage: 0.82 - offset - viewIndex * 0.01,
    confidence: 0.93 - viewIndex * 0.01,
  }))
}

function result(candidateId = 'candidate-48', offset = 0) {
  const comparisons = regionalComparisons(offset)
  return {
    providerId: DINOV2_PROVIDER_ID,
    model,
    capabilities: ['embedding', 'preference-scoring'],
    confidence: 0.91,
    elapsedMs: 19,
    preferenceFeatures: {
      modelId: DINOV2_MODEL_ID,
      names: [...DINOV2_FEATURE_NAMES],
      values: Float32Array.from(comparisons.flatMap((comparison) =>
        metrics.map((metric) => comparison[metric]))),
      confidence: 0.9,
      scope: 'pair',
      candidateId,
      regionalComparisons: comparisons,
    },
    warnings: ['inferenceMs=18.2'],
  }
}

function image() {
  return {
    width: 32,
    height: 32,
    data: new Uint8ClampedArray(32 * 32 * 4).fill(255),
  }
}

describe('DINOv2 offline candidate scorer', () => {
  it('normalizes the pinned four-view pair contract into serializable ranking evidence', () => {
    const normalized = normalizeDinoV2CandidateScore(result(), 'candidate-48')
    const feature = dinoV2NeuralFeature(normalized)

    assert.equal(normalized.providerId, DINOV2_PROVIDER_ID)
    assert.equal(normalized.model.modelId, DINOV2_MODEL_ID)
    assert.deepEqual(normalized.names, [...DINOV2_FEATURE_NAMES])
    assert.equal(normalized.values.length, 16)
    assert.deepEqual(normalized.regionalComparisons.map((entry) => entry.view), views)
    assert.equal(feature.providerId, DINOV2_PROVIDER_ID)
    assert.equal(feature.candidateId, 'candidate-48')
    assert.deepEqual(feature.names, [...DINOV2_FEATURE_NAMES])
    assert.equal(feature.values.length, 16)
    assert.equal(feature.confidence, 0.9)
  })

  it('rejects model drift, candidate drift, and incomplete regional evidence', () => {
    const wrongModel = result()
    wrongModel.model = { ...wrongModel.model, weightRevision: 'hf:changed' }
    assert.throws(
      () => normalizeDinoV2CandidateScore(wrongModel, 'candidate-48'),
      /model identity/i,
    )

    assert.throws(
      () => normalizeDinoV2CandidateScore(result('other-candidate'), 'candidate-48'),
      /candidate identity/i,
    )

    const missingView = result()
    missingView.preferenceFeatures.regionalComparisons = missingView.preferenceFeatures.regionalComparisons.slice(0, 3)
    assert.throws(
      () => normalizeDinoV2CandidateScore(missingView, 'candidate-48'),
      /four regional views/i,
    )
  })

  it('uses the gateway timeout and degrades a failed provider into a bounded warning', async () => {
    let requestedUrl
    const scorer = createDinoV2CandidateScorer({
      endpoint: 'http://127.0.0.1:7105',
      timeoutMs: 5,
      fetch: async (url, init) => {
        requestedUrl = String(url)
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
        })
      },
    })
    const outcome = await scoreDinoV2Candidate({
      scorer,
      request: {
        referenceImage: image(),
        candidateImage: image(),
        sourceId: 'cat-source',
        candidateId: 'candidate-48',
      },
    })

    assert.equal(requestedUrl, 'http://127.0.0.1:7105/v1/analyze')
    assert.equal(outcome.score, undefined)
    assert.equal(outcome.warning.providerId, DINOV2_PROVIDER_ID)
    assert.equal(outcome.warning.candidateId, 'candidate-48')
    assert.match(outcome.warning.message, /timed out/i)
  })
})
