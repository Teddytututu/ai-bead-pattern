import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createPreferenceRuntime } from './preference-runtime.mjs'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}

function candidate(id, value) {
  return {
    id,
    route: 'deterministic',
    style: 'faithful',
    paletteId: 'generic-24',
    grid: { width: 32, height: 32 },
    features: {
      silhouette: value, identityFeatures: value, composition: value, valueOrder: value,
      colorFidelity: value, pixelClusters: value, contourRhythm: value, thinStructure: value,
      boundaryAnchors: value, material: value, styleFit: value, craftEase: value,
    },
  }
}

function fakeCore() {
  const calls = { converted: 0, activePairs: [], parameters: 0, evaluations: [] }
  const core = {
    BASELINE_PREFERENCE_WEIGHTS: { silhouette: 1 },
    preferenceRecordFromWorkbenchSession(session, options) {
      calls.converted += 1
      return {
        schemaVersion: 2,
        id: options.recordId,
        generationId: session.generationId,
        source: { id: session.source.id, subjectKind: 'person' },
        candidates: [candidate('a', 0.9), candidate('b', 0.3), candidate('c', 0.7)],
        annotator: { anonymousId: session.annotatorId },
        axisScores: {}, issueAnnotations: [],
        comparisons: session.comparisons.map((entry) => ({
          candidateAId: entry.candidateIds[0], candidateBId: entry.candidateIds[1],
          choice: entry.choice === 'first' ? 'a' : entry.choice === 'second' ? 'b' : 'tie',
        })),
        eliminations: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:01.000Z',
      }
    },
    deduplicatePreferenceRecords: (records) => records,
    createFrozenPreferenceSplit(records) {
      return { recordIds: { train: records.map((entry) => entry.id), validation: [], holdout: [] } }
    },
    fitPreferenceModelV2(records) {
      return {
        version: records.length === 0 ? 'baseline' : 'learned', sampleCount: records.length,
        learnedWeights: { silhouette: records.length === 0 ? 1 : 2 },
        baselineWeights: { silhouette: 1 }, generationAdjustments: {}, strata: {},
      }
    },
    comparePreferenceModels() {
      return {
        baseline: { accuracy: 0.5, logLoss: 0.69 }, challenger: { accuracy: 0.75, logLoss: 0.51 },
        accuracyGain: 0.25, logLossReduction: 0.18,
      }
    },
    selectPreferenceModelVersion(_baseline, challenger) {
      return { selectedVersion: challenger.sampleCount >= 3 ? 'learned' : 'baseline', rolledBack: challenger.sampleCount < 3 }
    },
    rankPreferenceCandidates(candidates, model) {
      const ids = model.version === 'baseline' ? candidates.map((entry) => entry.id) : ['a', 'c', 'b']
      return { rankedCandidateIds: ids, scores: Object.fromEntries(ids.map((id, index) => [id, { total: 1 - index / 10 }])) }
    },
    selectActivePreferencePair(_candidates, _model, options) {
      calls.activePairs.push(options.comparedPairs)
      const compared = options.comparedPairs.some((entry) => entry.candidateAId === 'a' && entry.candidateBId === 'b')
      return compared
        ? { candidateAId: 'a', candidateBId: 'c', priority: 0.8 }
        : { candidateAId: 'a', candidateBId: 'b', priority: 0.9 }
    },
    derivePreferenceGenerationParameters(model, baseline = {
      importanceStrength: 1, edgeStrength: 1, edgeProtection: 1,
      isolatedPixelPenalty: 1, stripePenalty: 1, valueOrderStrength: 1,
      localSearchIterations: 2, maxColorsScale: 1,
    }) {
      calls.parameters += 1
      if (model.version === 'baseline') return { ...baseline }
      return {
        importanceStrength: 1.2, edgeStrength: 0.8, edgeProtection: 1.1,
        isolatedPixelPenalty: 1.3, stripePenalty: 1.4, valueOrderStrength: 1.2,
        localSearchIterations: 4, maxColorsScale: 0.8,
      }
    },
    composeCandidateEvaluationV2(input) {
      calls.evaluations.push(input)
      return {
        version: 2,
        rankedCandidateIds: input.selectedPreferenceRanking.rankedCandidateIds,
        scores: input.scores,
        ruleRankedCandidateIds: Object.keys(input.scores),
        learnedRankedCandidateIds: input.selectedPreferenceRanking.rankedCandidateIds,
        finalRankedCandidateIds: input.selectedPreferenceRanking.rankedCandidateIds,
        candidateScores: {}, neuralPreferenceFeatures: input.neuralPreferenceFeatures,
        providerContributions: input.providerContributions,
        sourceWeights: { rule: 0.55, neural: 0.15, humanPreference: 0.3 },
        appliedSourceWeights: { rule: 0.55, neural: 0.15, humanPreference: 0.3 },
      }
    },
  }
  return { core, calls }
}

function session(comparisons = [], generationId = 'generation-1') {
  return {
    schemaVersion: 'preference-session-v2', generationId,
    source: { id: `source-${generationId}`, kind: 'portrait' }, annotatorId: 'anonymous-1', comparisons,
  }
}

describe('preference learning runtime', () => {
  it('converts, persists, trains, compares, and exposes rule versus learned ranking', () => {
    const { core, calls } = fakeCore()
    const runtime = createPreferenceRuntime({ core, storage: memoryStorage() })

    const state = runtime.ingestSession(session(), {
      ruleScores: { a: { total: 0.9 }, b: { total: 0.3 }, c: { total: 0.7 } },
      neuralPreferenceFeatures: [{
        modelId: 'dinov2-base', candidateId: 'a', names: ['identity'], values: [0.9], confidence: 0.8,
      }],
      providerContributions: [{
        providerId: 'dinov2-provider', modelId: 'dinov2-base', capabilities: ['visual-embedding'],
        status: 'used', confidence: 0.8, elapsedMs: 12,
      }],
    })

    assert.equal(calls.converted, 1)
    assert.equal(state.sampleCount, 1)
    assert.equal(state.ruleRanking[0], 'a')
    assert.deepEqual(state.learnedRanking, ['a', 'b', 'c'])
    assert.deepEqual(state.challengerRanking, ['a', 'c', 'b'])
    assert.equal(state.comparison.challenger.accuracy, 0.75)
    assert.equal(state.selection.rolledBack, true)
    assert.equal(state.activePair.candidateBId, 'b')
    assert.equal(state.candidateEvaluation.version, 2)
    assert.equal(calls.evaluations[0].neuralPreferenceFeatures[0].providerId, 'dinov2-provider')
  })

  it('uses comparison history for the next active pair and feeds bounded options into generation', () => {
    const { core, calls } = fakeCore()
    const runtime = createPreferenceRuntime({ core, storage: memoryStorage() })
    runtime.ingestSession(session([{ candidateIds: ['a', 'b'], choice: 'first' }]))

    assert.equal(runtime.getState().activePair.candidateBId, 'c')
    const options = runtime.applyGenerationOptions({
      maxColors: 24,
      structure: { importanceStrength: 1, edgeStrength: 0.5 },
      optimization: {
        isolatedPixelPenalty: 1, stripePenalty: 1, edgeProtection: 0.8, localSearchIterations: 2,
      },
    })
    assert.equal(options.maxColors, 24)
    assert.equal(options.structure.importanceStrength, 1)
    assert.equal(options.optimization.localSearchIterations, 2)
    assert.equal(calls.parameters, 2)
  })

  it('applies challenger ranking and parameters after the sample gate accepts it', () => {
    const { core } = fakeCore()
    const runtime = createPreferenceRuntime({ core, storage: memoryStorage() })
    runtime.ingestSession(session([], 'generation-1'))
    runtime.ingestSession(session([], 'generation-2'))
    const state = runtime.ingestSession(session([], 'generation-3'))

    assert.equal(state.selection.rolledBack, false)
    assert.deepEqual(state.learnedRanking, ['a', 'c', 'b'])
    const options = runtime.applyGenerationOptions({
      maxColors: 24,
      structure: { importanceStrength: 1, edgeStrength: 0.5 },
      optimization: {
        isolatedPixelPenalty: 1, stripePenalty: 1, edgeProtection: 0.8, localSearchIterations: 2,
      },
    })
    assert.equal(options.maxColors, 19)
    assert.equal(options.structure.importanceStrength, 1.2)
    assert.equal(options.optimization.localSearchIterations, 4)
  })
})
