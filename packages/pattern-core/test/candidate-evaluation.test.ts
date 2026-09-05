import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  composeCandidateEvaluationV2,
  type CandidateScore,
} from '../src/index.js'
import { scoreCraftQuality } from '../src/candidate-evaluation.js'

function score(total: number): CandidateScore {
  return {
    total,
    silhouette: total,
    identity: total,
    poseStructure: total,
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
  it('charges fragile bridge joints above supported bridge cells', () => {
    const supported = scoreCraftQuality({
      totalCells: 100,
      maxColors: 8,
      uniqueColors: 4,
      isolatedCells: 0,
      orthogonalBridgeCells: 4,
      fragileOrthogonalBridgeCells: 0,
      craftComponentsBeforeBridging: 5,
      craftComponentsAfterBridging: 1,
      referenceComponents: 1,
    })
    const fragile = scoreCraftQuality({
      totalCells: 100,
      maxColors: 8,
      uniqueColors: 4,
      isolatedCells: 0,
      orthogonalBridgeCells: 4,
      fragileOrthogonalBridgeCells: 4,
      craftComponentsBeforeBridging: 5,
      craftComponentsAfterBridging: 1,
      referenceComponents: 1,
    })

    assert.ok(fragile.craftEase < supported.craftEase)
    assert.ok(fragile.craftCost > supported.craftCost)
    assert.equal(fragile.craftCost, 1 - fragile.craftEase)
  })

  it('charges craft components left unresolved after bridging', () => {
    const resolved = scoreCraftQuality({
      totalCells: 100,
      maxColors: 8,
      uniqueColors: 4,
      isolatedCells: 0,
      orthogonalBridgeCells: 2,
      fragileOrthogonalBridgeCells: 0,
      craftComponentsBeforeBridging: 3,
      craftComponentsAfterBridging: 1,
      referenceComponents: 1,
    })
    const unresolved = scoreCraftQuality({
      totalCells: 100,
      maxColors: 8,
      uniqueColors: 4,
      isolatedCells: 0,
      orthogonalBridgeCells: 2,
      fragileOrthogonalBridgeCells: 0,
      craftComponentsBeforeBridging: 3,
      craftComponentsAfterBridging: 2,
      referenceComponents: 1,
    })

    assert.ok(unresolved.craftEase < resolved.craftEase)
    assert.ok(unresolved.craftCost > resolved.craftCost)
  })

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

  it('keeps valid candidates ahead of higher-scoring rejected candidates', () => {
    const evaluation = composeCandidateEvaluationV2({
      scores: { valid: score(0.62), rejected: score(0.95) },
      candidateValidity: { valid: true, rejected: false },
      neuralPreferenceFeatures: [{
        providerId: 'openclip-provider',
        modelId: 'openclip-vit-b32',
        candidateId: 'rejected',
        names: ['semanticRetention'],
        values: [1],
        confidence: 1,
      }],
    })

    assert.deepEqual(evaluation.finalRankedCandidateIds, ['valid', 'rejected'])
    assert.deepEqual(evaluation.ruleRankedCandidateIds, ['valid', 'rejected'])
    assert.deepEqual(evaluation.candidateValidity, { valid: true, rejected: false })
  })

  it('caps coarse OpenCLIP class evidence when semantic identity retention is weak', () => {
    const evaluation = composeCandidateEvaluationV2({
      scores: { identity: score(0.7), generic: score(0.7) },
      neuralPreferenceFeatures: [
        {
          providerId: 'openclip-provider', modelId: 'openclip-vit-b32', candidateId: 'identity',
          names: ['semanticRetention', 'classDistributionRetention', 'petClassMargin'],
          values: [0.76, 0.5, 0.5], confidence: 1,
        },
        {
          providerId: 'openclip-provider', modelId: 'openclip-vit-b32', candidateId: 'generic',
          names: ['semanticRetention', 'classDistributionRetention', 'petClassMargin'],
          values: [0.48, 1, 1], confidence: 1,
        },
      ],
      sourceWeights: { rule: 0.5, neural: 0.5, humanPreference: 0 },
    })

    assert.deepEqual(evaluation.finalRankedCandidateIds, ['identity', 'generic'])
    assert.ok(evaluation.candidateScores.identity!.neural > evaluation.candidateScores.generic!.neural)
  })

  it('lets combined DINOv2 and OpenCLIP identity evidence reorder rule-ranked candidates', () => {
    const evaluation = composeCandidateEvaluationV2({
      scores: { ruleWinner: score(0.82), identityWinner: score(0.7) },
      neuralPreferenceFeatures: [
        {
          providerId: 'dinov2-vits14-pair-local',
          modelId: 'facebook/dinov2-small',
          candidateId: 'ruleWinner',
          names: ['head.identitySimilarity', 'critical-local.criticalPatchRetention'],
          values: [0.22, 0.18],
          confidence: 0.94,
        },
        {
          providerId: 'openclip-vit-b32-pair-local',
          modelId: 'mlfoundations/open_clip/ViT-B-32/laion2b_s34b_b79k',
          candidateId: 'ruleWinner',
          names: ['semanticRetention', 'classDistributionRetention', 'petClassMargin'],
          values: [0.24, 0.2, 0.16],
          confidence: 0.9,
        },
        {
          providerId: 'dinov2-vits14-pair-local',
          modelId: 'facebook/dinov2-small',
          candidateId: 'identityWinner',
          names: ['head.identitySimilarity', 'critical-local.criticalPatchRetention'],
          values: [0.96, 0.94],
          confidence: 0.94,
        },
        {
          providerId: 'openclip-vit-b32-pair-local',
          modelId: 'mlfoundations/open_clip/ViT-B-32/laion2b_s34b_b79k',
          candidateId: 'identityWinner',
          names: ['semanticRetention', 'classDistributionRetention', 'petClassMargin'],
          values: [0.93, 0.9, 0.88],
          confidence: 0.9,
        },
      ],
      providerContributions: [
        {
          providerId: 'dinov2-vits14-pair-local', modelId: 'facebook/dinov2-small',
          capabilities: ['embedding', 'preference-scoring'], status: 'used',
          confidence: 0.94, elapsedMs: 18,
        },
        {
          providerId: 'openclip-vit-b32-pair-local',
          modelId: 'mlfoundations/open_clip/ViT-B-32/laion2b_s34b_b79k',
          capabilities: ['embedding', 'preference-scoring'], status: 'used',
          confidence: 0.9, elapsedMs: 14,
        },
      ],
      sourceWeights: { rule: 0.4, neural: 0.6, humanPreference: 0 },
    })

    assert.deepEqual(evaluation.ruleRankedCandidateIds, ['ruleWinner', 'identityWinner'])
    assert.deepEqual(evaluation.finalRankedCandidateIds, ['identityWinner', 'ruleWinner'])
    assert.ok(evaluation.candidateScores.identityWinner!.neural
      > evaluation.candidateScores.ruleWinner!.neural)
    assert.deepEqual(evaluation.providerContributions.map((entry) => entry.providerId), [
      'dinov2-vits14-pair-local',
      'openclip-vit-b32-pair-local',
    ])
  })

  it('keeps rule ranking active when identity providers time out or are absent', () => {
    const evaluation = composeCandidateEvaluationV2({
      scores: { faithful: score(0.91), cute: score(0.74) },
      providerContributions: [{
        providerId: 'dinov2-vits14-pair-local',
        modelId: 'facebook/dinov2-small',
        capabilities: ['embedding', 'preference-scoring'],
        status: 'failed',
        elapsedMs: 120_000,
        message: 'Vision provider request timed out',
      }],
      sourceWeights: { rule: 0.1, neural: 0.9, humanPreference: 0 },
    })

    assert.deepEqual(evaluation.finalRankedCandidateIds, ['faithful', 'cute'])
    assert.deepEqual(evaluation.appliedSourceWeights, {
      rule: 1,
      neural: 0,
      humanPreference: 0,
    })
    assert.equal(evaluation.candidateScores.faithful?.final, 0.91)
    assert.equal(evaluation.providerContributions[0]?.status, 'failed')
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
