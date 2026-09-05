import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { composeCandidateEvaluationV2 } from '@ai-bead-pattern/pattern-core'

import { createOpenClipScoringViews } from '../src/openclip-views.mjs'

import {
  OPENCLIP_EVALUATION_SOURCE_WEIGHTS,
  OPENCLIP_FEATURE_NAMES,
  OPENCLIP_VIEW_WEIGHTS,
  normalizeOpenClipCandidateScore,
  openClipNeuralFeature,
  scoreOpenClipCandidate,
  scoreOpenClipCandidateViews,
} from '../src/openclip-candidate-scorer.mjs'

const modelIdentity = {
  providerId: 'openclip-vit-b32-pair-local',
  modelId: 'mlfoundations/open_clip/ViT-B-32/laion2b_s34b_b79k',
  modelVersion: 'open_clip_torch-3.3.0',
  sourceRevision: '30573618fc375b12f094ef64cb3a1391cf611c45',
  weightSource: 'https://huggingface.co/laion/CLIP-ViT-B-32-laion2B-s34B-b79K/tree/1a25a446712ba5ee05982a381eed697ef9b435cf',
  weightRevision: 'hf:1a25a446712ba5ee05982a381eed697ef9b435cf',
  license: {
    spdx: 'MIT',
    name: 'MIT License',
    url: 'https://github.com/mlfoundations/open_clip/blob/v3.3.0/LICENSE',
  },
}

function result(candidateId = 'candidate-b', values = [0.82, 0.76, 0.41]) {
  return {
    providerId: modelIdentity.providerId,
    model: { ...modelIdentity },
    capabilities: ['embedding', 'preference-scoring'],
    confidence: 0.88,
    elapsedMs: 12.5,
    preferenceFeatures: {
      modelId: modelIdentity.modelId,
      names: [...OPENCLIP_FEATURE_NAMES],
      values: Float32Array.from(values),
      confidence: 0.88,
      scope: 'pair',
      candidateId,
    },
    warnings: ['inferenceMs=9.5'],
  }
}

function candidateScore(total) {
  return { total }
}

function rgba(width, height, landmarks, erasedKinds = new Set()) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  for (const landmark of landmarks) {
    if (erasedKinds.has(landmark.kind)) continue
    const offset = (landmark.y * width + landmark.x) * 4
    data[offset] = 20
    data[offset + 1] = 30
    data[offset + 2] = 40
  }
  return { width, height, data }
}

function darkPixelRatio(referenceImage, candidateImage) {
  const count = (image) => {
    let total = 0
    for (let index = 0; index < image.data.length; index += 4) {
      if (image.data[index] < 128 || image.data[index + 1] < 128 || image.data[index + 2] < 128) total += 1
    }
    return total
  }
  return Math.min(1, count(candidateImage) / Math.max(1, count(referenceImage)))
}

describe('OpenCLIP candidate scoring contract', () => {
  it('replays a fixed provider record into identical features and ranking', () => {
    const first = normalizeOpenClipCandidateScore(result(), 'candidate-b')
    const second = normalizeOpenClipCandidateScore(result(), 'candidate-b')
    assert.deepEqual(second, first)

    const featureA = openClipNeuralFeature(
      normalizeOpenClipCandidateScore(result('candidate-a', [0.54, 0.35, 0.83]), 'candidate-a'),
      'pet',
    )
    const featureB = openClipNeuralFeature(
      normalizeOpenClipCandidateScore(result('candidate-b', [0.53, 0.97, 0.95]), 'candidate-b'),
      'pet',
    )
    const evaluation = () => composeCandidateEvaluationV2({
      scores: {
        'candidate-a': candidateScore(0.81),
        'candidate-b': candidateScore(0.74),
      },
      neuralPreferenceFeatures: [featureA, featureB],
      sourceWeights: OPENCLIP_EVALUATION_SOURCE_WEIGHTS,
    })

    assert.deepEqual(evaluation(), evaluation())
    assert.equal(evaluation().finalRankedCandidateIds[0], 'candidate-a')
  })

  it('uses the pet margin only for pet candidates and maps it into a unit score', () => {
    const normalized = normalizeOpenClipCandidateScore(result(), 'candidate-b')
    const pet = openClipNeuralFeature(normalized, 'pet')
    const object = openClipNeuralFeature(normalized, 'object')

    assert.deepEqual(pet.names, [
      'semanticRetention',
      'classDistributionRetention',
      'petClassMargin',
    ])
    assert.ok(Math.abs(pet.values[2] - (0.5 + (0.705 - 0.5) * 0.88)) < 1e-6)
    assert.deepEqual(object.names, ['semanticRetention', 'classDistributionRetention'])
    assert.deepEqual(object.values, [
      0.5 + (normalized.features.semanticRetention - 0.5) * normalized.confidence,
      0.5 + (normalized.features.classDistributionRetention - 0.5) * normalized.confidence,
    ])
  })

  it('calibrates the full signed pet margin range into unit scores', () => {
    const minimum = openClipNeuralFeature(
      normalizeOpenClipCandidateScore(result('candidate-min', [0.5, 0.5, -1]), 'candidate-min'),
      'pet',
    )
    const neutral = openClipNeuralFeature(
      normalizeOpenClipCandidateScore(result('candidate-zero', [0.5, 0.5, 0]), 'candidate-zero'),
      'pet',
    )
    const maximum = openClipNeuralFeature(
      normalizeOpenClipCandidateScore(result('candidate-max', [0.5, 0.5, 1]), 'candidate-max'),
      'pet',
    )

    assert.ok(Math.abs(minimum.values[2] - 0.06) < 1e-6)
    assert.ok(Math.abs(neutral.values[2] - 0.5) < 1e-6)
    assert.ok(Math.abs(maximum.values[2] - 0.94) < 1e-6)
  })

  it('aggregates global, subject, and face scores with the strongest face weight', async () => {
    const calls = []
    const valuesByView = {
      global: [0.4, 0.3, -1],
      'subject-mask': [0.6, 0.5, 0],
      'face-mask': [0.9, 0.8, 1],
    }
    const outcome = await scoreOpenClipCandidateViews({
      scorer: {
        async scorePair(request) {
          calls.push(request.viewId)
          return result(request.candidateId, valuesByView[request.viewId])
        },
      },
      request: {
        sourceId: 'source-cat',
        candidateId: 'candidate-b',
      },
      views: [
        { id: 'global', referenceImage: {}, candidateImage: {} },
        { id: 'subject-mask', referenceImage: {}, candidateImage: {} },
        { id: 'face-mask', referenceImage: {}, candidateImage: {} },
      ],
    })

    assert.deepEqual(calls, ['global', 'subject-mask', 'face-mask'])
    assert.ok(OPENCLIP_VIEW_WEIGHTS['face-mask'] > OPENCLIP_VIEW_WEIGHTS['subject-mask'])
    assert.ok(OPENCLIP_VIEW_WEIGHTS['subject-mask'] > OPENCLIP_VIEW_WEIGHTS.global)
    assert.equal(outcome.score.features.petBirdMargin, 0.3)
    assert.deepEqual(Object.keys(outcome.score.views), ['global', 'subject-mask', 'face-mask'])
    assert.equal(outcome.score.views['face-mask'].weight, OPENCLIP_VIEW_WEIGHTS['face-mask'])
  })

  it('keeps the identity head view ahead of the face view under moderate landmark uncertainty', async () => {
    const outcome = await scoreOpenClipCandidateViews({
      scorer: {
        async scorePair(request) {
          return result(request.candidateId)
        },
      },
      request: { sourceId: 'source-cat', candidateId: 'candidate-b' },
      views: [
        { id: 'global', referenceImage: {}, candidateImage: {} },
        {
          id: 'face-mask',
          referenceImage: {},
          candidateImage: {},
          evidenceConfidence: 0.66,
        },
        {
          id: 'head-landmarks',
          referenceImage: {},
          candidateImage: {},
          evidenceConfidence: 0.42,
        },
      ],
    })

    assert.ok(outcome.score.views['head-landmarks'].weight
      > outcome.score.views['face-mask'].weight)
  })

  it('scores erased ear and nose pixels lower through the head-landmarks view', async () => {
    const headLandmarks = [
      { id: 'ear', kind: 'ear', structuralRole: 'ear-tip', x: 2, y: 1, confidence: 0.9, priority: 'hard' },
      { id: 'eye', kind: 'eye', structuralRole: 'eye-center', x: 4, y: 4, confidence: 0.9, priority: 'hard' },
      { id: 'nose', kind: 'nose', structuralRole: 'nose-tip', x: 7, y: 5, confidence: 0.9, priority: 'hard' },
      { id: 'chin', kind: 'face-contour', x: 5, y: 8, confidence: 0.9, priority: 'hard' },
    ]
    const referenceImage = rgba(10, 10, headLandmarks)
    const scorer = {
      async scorePair(request) {
        const similarity = darkPixelRatio(request.referenceImage, request.candidateImage)
        return result(request.candidateId, [similarity, similarity, similarity * 2 - 1])
      },
    }
    const score = async (candidateImage) => scoreOpenClipCandidateViews({
      scorer,
      request: { sourceId: 'source-cat', candidateId: 'candidate-b' },
      views: createOpenClipScoringViews({
        referenceImage,
        candidateImage,
        referenceHeadLandmarks: headLandmarks,
        candidateHeadLandmarks: headLandmarks,
      }),
    })

    const intact = await score(rgba(10, 10, headLandmarks))
    const erased = await score(rgba(10, 10, headLandmarks, new Set(['ear', 'nose'])))

    assert.ok(intact.score.views['head-landmarks'].features.semanticRetention
      > erased.score.views['head-landmarks'].features.semanticRetention)
    assert.ok(intact.score.features.semanticRetention > erased.score.features.semanticRetention)
    assert.ok(intact.score.features.petBirdMargin > erased.score.features.petBirdMargin)
  })

  it('uses shared-frame geometry and an evidence-weighted critical face penalty', async () => {
    const outcome = await scoreOpenClipCandidateViews({
      scorer: {
        async scorePair(request) {
          const values = request.viewId === 'face-mask' ? [0.2, 0.8, 1] : [0.95, 0.9, 1]
          return result(request.candidateId, values)
        },
      },
      request: { sourceId: 'source-cat', candidateId: 'candidate-b' },
      views: [
        { id: 'global', referenceImage: {}, candidateImage: {} },
        { id: 'subject-mask', referenceImage: {}, candidateImage: {}, geometry: { retention: 0.9 } },
        { id: 'face-mask', referenceImage: {}, candidateImage: {}, geometry: { retention: 0.5 } },
      ],
    })

    const weightedMean = Object.values(outcome.score.views).reduce(
      (sum, view) => sum + view.weight * view.adjustedSemanticRetention,
      0,
    )
    const critical = outcome.score.views['face-mask'].adjustedSemanticRetention
    assert.ok(Math.abs(outcome.score.features.semanticRetention
      - (weightedMean - Math.max(0, weightedMean - critical) * 0.25)) < 1e-12)
    assert.ok(outcome.score.features.semanticRetention < weightedMean)
    assert.equal(outcome.score.views['face-mask'].geometry.retention, 0.5)
    assert.ok(outcome.score.views['face-mask'].adjustedSemanticRetention < 0.2)
  })

  it('applies the critical head penalty to every aggregate feature', async () => {
    const valuesByView = {
      global: [0.9, 0.8, 0.8],
      'subject-mask': [0.9, 0.8, 0.8],
      'face-mask': [0.85, 0.75, 0.7],
      'head-landmarks': [0.2, 0.25, -0.8],
    }
    const run = () => scoreOpenClipCandidateViews({
      scorer: {
        async scorePair(request) {
          return result(request.candidateId, valuesByView[request.viewId])
        },
      },
      request: { sourceId: 'source-cat', candidateId: 'candidate-b' },
      views: Object.keys(valuesByView).map((id) => ({
        id,
        referenceImage: {},
        candidateImage: {},
        evidenceConfidence: 1,
      })),
    })
    const first = await run()
    const second = await run()
    const weighted = (name) => Object.values(first.score.views).reduce(
      (sum, view) => sum + view.weight * view.features[name],
      0,
    )

    assert.ok(first.score.features.semanticRetention < weighted('semanticRetention'))
    assert.ok(first.score.features.classDistributionRetention < weighted('classDistributionRetention'))
    assert.ok(first.score.features.petBirdMargin < weighted('petBirdMargin'))
    assert.deepEqual(second.score, first.score)
  })

  it('supports instance-scoped views and lets the weakest pet identity control the penalty', async () => {
    const run = (secondHeadSimilarity) => scoreOpenClipCandidateViews({
      scorer: {
        async scorePair(request) {
          const values = request.viewId === 'pet-02:head-landmarks'
            ? [secondHeadSimilarity, secondHeadSimilarity, secondHeadSimilarity * 2 - 1]
            : [0.9, 0.86, 0.8]
          return result(request.candidateId, values)
        },
      },
      request: { sourceId: 'two-pets', candidateId: 'candidate-b' },
      views: [
        { id: 'global', referenceImage: {}, candidateImage: {} },
        { id: 'pet-01:face-mask', referenceImage: {}, candidateImage: {} },
        { id: 'pet-01:head-landmarks', referenceImage: {}, candidateImage: {} },
        { id: 'pet-02:face-mask', referenceImage: {}, candidateImage: {} },
        { id: 'pet-02:head-landmarks', referenceImage: {}, candidateImage: {} },
      ],
      plannedViewIds: [
        'global',
        'pet-01:face-mask',
        'pet-01:head-landmarks',
        'pet-02:face-mask',
        'pet-02:head-landmarks',
      ],
    })

    const intact = await run(0.9)
    const damaged = await run(0.1)

    assert.deepEqual(Object.keys(damaged.score.views), [
      'global',
      'pet-01:face-mask',
      'pet-01:head-landmarks',
      'pet-02:face-mask',
      'pet-02:head-landmarks',
    ])
    assert.ok(damaged.score.features.semanticRetention < intact.score.features.semanticRetention)
    assert.ok(damaged.score.features.classDistributionRetention < intact.score.features.classDistributionRetention)
    assert.ok(damaged.score.features.petBirdMargin < intact.score.features.petBirdMargin)
  })

  it('uses the strongest available critical tier within every pet instance', async () => {
    const valuesByView = {
      global: [0.95, 0.95, 0.9],
      'pet-01:head-landmarks': [0.95, 0.95, 0.9],
      'pet-02:face-mask': [0, 0, -1],
    }
    const outcome = await scoreOpenClipCandidateViews({
      scorer: {
        async scorePair(request) {
          return result(request.candidateId, valuesByView[request.viewId])
        },
      },
      request: { sourceId: 'two-pets', candidateId: 'candidate-b' },
      views: Object.keys(valuesByView).map((id) => ({
        id,
        referenceImage: {},
        candidateImage: {},
      })),
    })
    const weightedMean = Object.values(outcome.score.views).reduce(
      (sum, view) => sum + view.weight * view.features.semanticRetention,
      0,
    )
    const weakFace = outcome.score.views['pet-02:face-mask'].features.semanticRetention
    const expected = weightedMean - Math.max(0, weightedMean - weakFace) * 0.25

    assert.ok(Math.abs(outcome.score.features.semanticRetention - expected) < 1e-12)
    assert.ok(outcome.score.features.semanticRetention < weightedMean)
  })

  it('treats a planned pet scope with no available view as an identity failure', async () => {
    const views = [
      { id: 'global', referenceImage: {}, candidateImage: {} },
      { id: 'pet-01:head-landmarks', referenceImage: {}, candidateImage: {} },
    ]
    const outcome = await scoreOpenClipCandidateViews({
      scorer: {
        async scorePair(request) {
          return result(request.candidateId, [0.95, 0.95, 0.9])
        },
      },
      request: { sourceId: 'two-pets', candidateId: 'candidate-b' },
      views,
      plannedViewIds: [...views.map((view) => view.id), 'pet-02:face-mask'],
    })

    assert.ok(outcome.score.features.semanticRetention < 0.5)
    assert.ok(outcome.score.coverage.missingCriticalViewIds.includes('pet-02:face-mask'))
  })

  it('scores views with bounded concurrency while preserving view order', async () => {
    const ids = [
      'global',
      'pet-01:subject-mask', 'pet-01:face-mask', 'pet-01:head-landmarks',
      'pet-02:subject-mask', 'pet-02:face-mask', 'pet-02:head-landmarks',
      'pet-03:subject-mask', 'pet-03:face-mask', 'pet-03:head-landmarks',
    ]
    let active = 0
    let peak = 0
    const outcome = await scoreOpenClipCandidateViews({
      scorer: {
        async scorePair(request) {
          active += 1
          peak = Math.max(peak, active)
          await new Promise((resolve) => setTimeout(resolve, 5))
          active -= 1
          return result(request.candidateId)
        },
      },
      request: { sourceId: 'three-pets', candidateId: 'candidate-b' },
      views: ids.map((id) => ({ id, referenceImage: {}, candidateImage: {} })),
    })

    assert.ok(peak > 1)
    assert.ok(peak <= 4)
    assert.deepEqual(Object.keys(outcome.score.views), ids)
  })

  it('stops scheduling views when the request is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const outcome = await scoreOpenClipCandidateViews({
      scorer: {
        async scorePair(request) {
          calls += 1
          return result(request.candidateId)
        },
      },
      request: { sourceId: 'cancelled', candidateId: 'candidate-b', signal: controller.signal },
      views: [
        { id: 'global', referenceImage: {}, candidateImage: {} },
        { id: 'subject-mask', referenceImage: {}, candidateImage: {} },
        { id: 'face-mask', referenceImage: {}, candidateImage: {} },
      ],
    })

    assert.equal(calls, 0)
    assert.equal(outcome.score, undefined)
  })

  it('weakens the head penalty when landmark evidence has low confidence', async () => {
    const run = async (evidenceConfidence) => scoreOpenClipCandidateViews({
      scorer: {
        async scorePair(request) {
          return result(request.candidateId, request.viewId === 'head-landmarks'
            ? [0.1, 0.2, -0.9]
            : [0.9, 0.85, 0.8])
        },
      },
      request: { sourceId: 'source-cat', candidateId: 'candidate-b' },
      views: [
        { id: 'global', referenceImage: {}, candidateImage: {} },
        { id: 'head-landmarks', referenceImage: {}, candidateImage: {}, evidenceConfidence },
      ],
    })
    const high = await run(1)
    const low = await run(0.1)
    const penaltyRate = (score) => {
      const mean = Object.values(score.views).reduce(
        (sum, view) => sum + view.weight * view.features.semanticRetention,
        0,
      )
      const critical = score.views['head-landmarks'].features.semanticRetention
      return (mean - score.features.semanticRetention) / (mean - critical)
    }

    assert.ok(Math.abs(penaltyRate(high.score) - 0.25) < 1e-12)
    assert.ok(Math.abs(penaltyRate(low.score) - 0.025) < 1e-12)
    assert.equal(low.score.views['head-landmarks'].evidenceConfidence, 0.1)
  })

  it('records planned view coverage and discounts a missing identity view', async () => {
    const scorer = {
      async scorePair(request) {
        return result(request.candidateId)
      },
    }
    const complete = await scoreOpenClipCandidateViews({
      scorer,
      request: { sourceId: 'source-cat', candidateId: 'candidate-complete' },
      views: [
        { id: 'global', referenceImage: {}, candidateImage: {} },
        { id: 'head-landmarks', referenceImage: {}, candidateImage: {} },
      ],
      plannedViewIds: ['global', 'head-landmarks'],
    })
    const missing = await scoreOpenClipCandidateViews({
      scorer,
      request: { sourceId: 'source-cat', candidateId: 'candidate-missing' },
      views: [{ id: 'global', referenceImage: {}, candidateImage: {} }],
      plannedViewIds: ['global', 'head-landmarks'],
    })

    assert.deepEqual(missing.score.coverage.plannedViewIds, ['global', 'head-landmarks'])
    assert.deepEqual(missing.score.coverage.succeededViewIds, ['global'])
    assert.deepEqual(missing.score.coverage.missingCriticalViewIds, ['head-landmarks'])
    assert.ok(Math.abs(missing.score.coverage.ratio - 0.2 / 1.05) < 1e-12)
    assert.ok(missing.score.confidence < complete.score.confidence * 0.2)
    assert.ok(openClipNeuralFeature(missing.score, 'pet').confidence < 0.2)
  })

  it('keeps global scoring available for legacy inputs without crop views', async () => {
    const calls = []
    const outcome = await scoreOpenClipCandidateViews({
      scorer: {
        async scorePair(request) {
          calls.push(request.viewId)
          return result(request.candidateId)
        },
      },
      request: {
        referenceImage: {},
        candidateImage: {},
        sourceId: 'legacy-source',
        candidateId: 'legacy-candidate',
      },
    })

    assert.deepEqual(calls, ['global'])
    assert.deepEqual(Object.keys(outcome.score.views), ['global'])
    assert.equal(outcome.score.views.global.weight, 1)
  })

  it('shrinks low-confidence features toward a neutral score', () => {
    const highResult = result()
    const lowResult = result()
    lowResult.confidence = 0.1
    lowResult.preferenceFeatures.confidence = 0.1
    const high = openClipNeuralFeature(
      normalizeOpenClipCandidateScore(highResult, 'candidate-b'),
      'pet',
    )
    const low = openClipNeuralFeature(
      normalizeOpenClipCandidateScore(lowResult, 'candidate-b'),
      'pet',
    )

    for (let index = 0; index < high.values.length; index += 1) {
      assert.ok(Math.abs(low.values[index] - 0.5) < Math.abs(high.values[index] - 0.5))
    }
  })

  it('keeps a high-confidence identity failure clearly below neutral', () => {
    const failedResult = result('candidate-b', [0.05, 0.1, -0.9])
    const failed = openClipNeuralFeature(
      normalizeOpenClipCandidateScore(failedResult, 'candidate-b'),
      'pet',
    )

    assert.ok(failed.values[0] < 0.2)
    assert.ok(failed.values[1] < 0.2)
    assert.ok(failed.values[2] < 0.2)
  })

  it('rejects model drift, unknown feature names, missing pair scope, and candidate drift', () => {
    const modelDrift = result()
    modelDrift.model = { ...modelDrift.model, weightRevision: 'latest' }
    assert.throws(() => normalizeOpenClipCandidateScore(modelDrift, 'candidate-b'), /model identity/i)

    const featureDrift = result()
    featureDrift.preferenceFeatures.names = ['semanticRetention', 'classDistributionRetention', 'animalMargin']
    assert.throws(() => normalizeOpenClipCandidateScore(featureDrift, 'candidate-b'), /feature names/i)

    const missingScope = result()
    delete missingScope.preferenceFeatures.scope
    assert.throws(() => normalizeOpenClipCandidateScore(missingScope, 'candidate-b'), /pair scope/i)

    assert.throws(() => normalizeOpenClipCandidateScore(result('candidate-a'), 'candidate-b'), /candidate identity/i)
  })

  it('keeps deterministic scoring available when the sidecar request fails', async () => {
    const outcome = await scoreOpenClipCandidate({
      scorer: {
        async scorePair() {
          throw new Error('connect ECONNREFUSED 127.0.0.1:7102')
        },
      },
      request: { candidateId: 'candidate-b' },
    })

    assert.equal(outcome.score, undefined)
    assert.equal(outcome.warning.candidateId, 'candidate-b')
    assert.match(outcome.warning.message, /ECONNREFUSED/)
    assert.ok(outcome.warning.message.length <= 300)
  })

  it('validates evidence confidence and unique supported view identities', async () => {
    const scorer = { async scorePair(request) { return result(request.candidateId) } }
    const request = { sourceId: 'source-cat', candidateId: 'candidate-b' }
    await assert.rejects(() => scoreOpenClipCandidateViews({
      scorer,
      request,
      views: [{
        id: 'head-landmarks',
        referenceImage: {},
        candidateImage: {},
        evidenceConfidence: 1.1,
      }],
    }), /evidence confidence/i)
    await assert.rejects(() => scoreOpenClipCandidateViews({
      scorer,
      request,
      views: [
        { id: 'global', referenceImage: {}, candidateImage: {} },
        { id: 'global', referenceImage: {}, candidateImage: {} },
      ],
    }), /unique and supported/i)
  })
})
