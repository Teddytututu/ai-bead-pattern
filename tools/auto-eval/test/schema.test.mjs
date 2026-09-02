import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { validateVisionJudgment } from '../src/schema.mjs'

const axes = {
  subjectRecognition: 5,
  silhouette: 4,
  identityFeatures: 5,
  composition: 4,
  valueHierarchy: 3,
  palette: 4,
  contourRhythm: 3,
  pixelClusters: 3,
  material: 3,
  styleFit: 4,
  craftEase: 4,
}

function judgment() {
  return {
    schemaVersion: 'vision-judge-v1',
    generationId: 'generation-pet-01',
    source: { id: 'pet-01', groupId: 'pet-01', subjectKind: 'pet' },
    judge: {
      providerId: 'openai-responses',
      modelId: 'gpt-5.6-vision',
      modelVersion: '2026-09-02',
      weightSource: 'openai-managed',
      license: 'OpenAI service terms',
      confidence: 0.8,
      elapsedMs: 620,
    },
    candidateScores: { a: axes, b: { ...axes, subjectRecognition: 2 } },
    issues: [{
      candidateId: 'b', issue: 'facial-feature-loss', severity: 5, confidence: 0.9,
      region: { x: 10, y: 8, width: 12, height: 10 },
    }],
    ranking: ['a', 'b'],
    bestCandidateId: 'a',
    eliminations: [{ candidateId: 'b', reason: 'cat face is unreadable' }],
    createdAt: '2026-09-02T08:00:00.000Z',
  }
}

describe('vision judgment schema', () => {
  it('accepts complete model scores, issue locations, and provenance', () => {
    assert.doesNotThrow(() => validateVisionJudgment(judgment(), [
      { id: 'a', grid: { width: 48, height: 48 } },
      { id: 'b', grid: { width: 48, height: 48 } },
    ]))
  })

  it('rejects incomplete axes, unknown candidates, and invalid model confidence', () => {
    const missingAxis = judgment()
    delete missingAxis.candidateScores.a.palette
    assert.throws(() => validateVisionJudgment(missingAxis, [
      { id: 'a', grid: { width: 48, height: 48 } },
      { id: 'b', grid: { width: 48, height: 48 } },
    ]), /every axis/i)

    const unknown = judgment()
    unknown.ranking = ['a', 'missing']
    assert.throws(() => validateVisionJudgment(unknown, [
      { id: 'a', grid: { width: 48, height: 48 } },
      { id: 'b', grid: { width: 48, height: 48 } },
    ]), /candidate/i)

    const confidence = judgment()
    confidence.judge.confidence = -0.1
    assert.throws(() => validateVisionJudgment(confidence, [
      { id: 'a', grid: { width: 48, height: 48 } },
      { id: 'b', grid: { width: 48, height: 48 } },
    ]), /confidence/i)
  })
})
