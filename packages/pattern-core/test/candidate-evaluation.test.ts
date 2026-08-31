import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  composeCandidateEvaluationV2,
  type CandidateScore,
} from '../src/index.js'

function score(total: number): CandidateScore {
  return {
    total,
    silhouette: total,
    identity: total,
    valueHierarchy: total,
    pixelClusters: total,
    craftCost: 1 - total,
    colorFidelity: total,
    sourceFidelity: total,
    planFidelity: total,
    structure: total,
    featureProtection: total,
    featureProtectionConfidence: 1,
    cleanliness: total,
    craftEase: total,
    canvasFit: total,
  }
}

describe('CandidateEvaluation V2 fusion', () => {
  it('keeps legacy fields while recording rule, neural, preference, and provider contributions', () => {
    const evaluation = composeCandidateEvaluationV2({
      scores: { a: score(0.8), b: score(0.7) },
      selectedPreferenceRanking: {
        rankedCandidateIds: ['b', 'a'],
        scores: { a: 0.25, b: 0.9 },
        model: { name: 'preference-linear-v2', version: 'learned-7' },
      },
      neuralPreferenceFeatures: [{
        providerId: 'dinov2-provider',
        modelId: 'dinov2-base',
        candidateId: 'b',
        names: ['identity-similarity', 'style-similarity'],
        values: [0.95, 0.85],
        confidence: 0.9,
      }],
      providerContributions: [{
        providerId: 'dinov2-provider',
        modelId: 'dinov2-base',
        capabilities: ['visual-embedding'],
        status: 'used',
        confidence: 0.9,
        elapsedMs: 18,
      }],
      sourceWeights: { rule: 0.35, neural: 0.25, humanPreference: 0.4 },
    })

    assert.equal(evaluation.version, 2)
    assert.deepEqual(evaluation.ruleRankedCandidateIds, ['a', 'b'])
    assert.deepEqual(evaluation.learnedRankedCandidateIds, ['b', 'a'])
    assert.deepEqual(evaluation.rankedCandidateIds, ['b', 'a'])
    assert.equal(evaluation.scores.a!.total, 0.8)
    assert.equal(evaluation.providerContributions[0]?.modelId, 'dinov2-base')
    assert.equal(evaluation.neuralPreferenceFeatures[0]?.candidateId, 'b')
    assert.equal(evaluation.candidateScores.b?.humanPreference, 0.9)
    assert.ok(evaluation.candidateScores.b!.final > evaluation.candidateScores.a!.final)
    assert.deepEqual(evaluation.sourceWeights, { rule: 0.35, neural: 0.25, humanPreference: 0.4 })
    assert.deepEqual(evaluation.selectedModel, { name: 'preference-linear-v2', version: 'learned-7' })
  })

  it('renormalizes available sources and preserves rule-only behavior', () => {
    const evaluation = composeCandidateEvaluationV2({
      scores: { a: score(0.4), b: score(0.9) },
      sourceWeights: { rule: 0.2, neural: 0.4, humanPreference: 0.4 },
    })

    assert.deepEqual(evaluation.rankedCandidateIds, ['b', 'a'])
    assert.deepEqual(evaluation.ruleRankedCandidateIds, ['b', 'a'])
    assert.deepEqual(evaluation.learnedRankedCandidateIds, [])
    assert.equal(evaluation.candidateScores.a?.final, 0.4)
    assert.equal(evaluation.candidateScores.b?.final, 0.9)
    assert.deepEqual(evaluation.appliedSourceWeights, { rule: 1, neural: 0, humanPreference: 0 })
  })

  it('strictly rejects unknown candidates, malformed providers, and non-finite values', () => {
    const scores = { a: score(0.8), b: score(0.7) }

    assert.throws(() => composeCandidateEvaluationV2({
      scores,
      selectedPreferenceRanking: {
        rankedCandidateIds: ['a', 'missing'],
        scores: { a: 0.8, missing: 0.5 },
        model: { name: 'preference-linear-v2', version: 'bad' },
      },
    }), /unknown candidate/i)
    assert.throws(() => composeCandidateEvaluationV2({
      scores,
      neuralPreferenceFeatures: [{
        providerId: 'dinov2-provider', modelId: 'dinov2-base', candidateId: 'missing',
        names: ['identity'], values: [0.8], confidence: 1,
      }],
    }), /unknown candidate/i)
    assert.throws(() => composeCandidateEvaluationV2({
      scores,
      neuralPreferenceFeatures: [{
        providerId: 'dinov2-provider', modelId: 'dinov2-base', candidateId: 'a',
        names: ['identity'], values: [Number.NaN], confidence: 1,
      }],
    }), /finite/i)
    assert.throws(() => composeCandidateEvaluationV2({
      scores,
      providerContributions: [{
        providerId: '', modelId: 'dinov2-base', capabilities: ['visual-embedding'],
        status: 'used', confidence: 0.8, elapsedMs: 10,
      }],
    }), /provider/i)
  })
})
