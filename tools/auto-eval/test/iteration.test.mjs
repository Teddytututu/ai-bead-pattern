import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  BASELINE_PREFERENCE_WEIGHTS,
  fitPreferenceModelV2,
} from '@ai-bead-pattern/pattern-core'

import { selectIteration, toGenerationOptions } from '../src/iteration.mjs'

function model(overrides = {}) {
  return {
    ...fitPreferenceModelV2([]),
    version: 'challenger-v1',
    sampleCount: 30,
    learnedWeights: { ...BASELINE_PREFERENCE_WEIGHTS, identityFeatures: 0.3 },
    generationAdjustments: {
      featureProtection: 1.5, thinStructure: 1.5, boundaryAnchor: 1.5,
      valueOrder: 1.5, refinement: 1.5, craftCost: 1.5,
    },
    ...overrides,
  }
}

describe('automatic preference iteration', () => {
  it('keeps challenger parameters inside the generation contract', () => {
    const options = toGenerationOptions(model(), {
      maxColors: 20,
      structure: { importanceStrength: 1, edgeStrength: 1, valueOrderStrength: 1 },
      optimization: { edgeProtection: 0.7, isolatedPixelPenalty: 1, stripePenalty: 1, localSearchIterations: 3 },
    })

    assert.ok(options.maxColors >= 2 && options.maxColors <= 20)
    assert.ok(options.structure.importanceStrength >= 0.25 && options.structure.importanceStrength <= 2)
    assert.ok(options.structure.edgeStrength >= 0.25 && options.structure.edgeStrength <= 2)
    assert.ok(options.structure.valueOrderStrength >= 0.25 && options.structure.valueOrderStrength <= 2)
    assert.ok(options.optimization.edgeProtection >= 0.25 && options.optimization.edgeProtection <= 1)
    assert.ok(options.optimization.localSearchIterations >= 1 && options.optimization.localSearchIterations <= 12)
  })

  it('lets learned priorities widen the next candidate color budget', () => {
    const options = toGenerationOptions(model({
      learnedWeights: {
        ...BASELINE_PREFERENCE_WEIGHTS,
        identityFeatures: 0.28,
        valueOrder: 0.16,
        craftEase: 0.015,
      },
      generationAdjustments: {
        featureProtection: 1,
        thinStructure: 1,
        boundaryAnchor: 1,
        valueOrder: 1,
        refinement: 1,
        craftCost: 1,
      },
    }), {
      maxColors: 12,
      structure: { importanceStrength: 1, edgeStrength: 1, valueOrderStrength: 1 },
      optimization: { edgeProtection: 0.7, isolatedPixelPenalty: 1, stripePenalty: 1, localSearchIterations: 3 },
    })

    assert.ok(options.maxColors > 12)
    assert.ok(options.maxColors <= 15)
    assert.ok(options.structure.importanceStrength > 1)
    assert.ok(options.structure.valueOrderStrength > 1)
  })

  it('adopts a measured challenger and keeps the baseline on weak evidence', () => {
    const challenger = model()
    const baseline = { ...challenger, version: 'baseline-v1', learnedWeights: BASELINE_PREFERENCE_WEIGHTS }
    const accepted = selectIteration({
      baseline, challenger,
      comparison: {
        baselineVersion: baseline.version, challengerVersion: challenger.version,
        baseline: { comparisons: 12, accuracy: 0.5, logLoss: 0.69, tieMeanAbsoluteError: 0 },
        challenger: { comparisons: 12, accuracy: 0.75, logLoss: 0.55, tieMeanAbsoluteError: 0 },
        accuracyGain: 0.25, logLossReduction: 0.14,
      },
    })
    const weak = selectIteration({
      baseline,
      challenger: { ...challenger, sampleCount: 3 },
      comparison: accepted.comparison,
    })

    assert.equal(accepted.selection.rolledBack, false)
    assert.equal(accepted.selectedModel.version, challenger.version)
    assert.equal(weak.selection.rolledBack, true)
    assert.equal(weak.selectedModel.version, baseline.version)
  })
})
