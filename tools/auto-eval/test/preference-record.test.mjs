import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { replayPreferenceRecord } from '@ai-bead-pattern/pattern-core'

import { buildVisionPreferenceRecord } from '../src/preference-record.mjs'

const featureVector = (value) => ({
  silhouette: value,
  identityFeatures: value,
  composition: value,
  valueOrder: value,
  colorFidelity: value,
  pixelClusters: value,
  contourRhythm: value,
  thinStructure: value,
  boundaryAnchors: value,
  material: value,
  styleFit: value,
  craftEase: value,
})

const axes = (value) => ({
  subjectRecognition: value,
  silhouette: value,
  identityFeatures: value,
  composition: value,
  valueHierarchy: value,
  palette: value,
  contourRhythm: value,
  pixelClusters: value,
  material: value,
  styleFit: value,
  craftEase: value,
})

describe('vision judgment preference conversion', () => {
  it('creates deterministic weighted supervision from a model judgment', () => {
    const candidates = [
      { id: 'a', route: 'deterministic', style: 'faithful', paletteId: 'generic-24', grid: { width: 48, height: 48 }, features: featureVector(0.8) },
      { id: 'b', route: 'deterministic', style: 'simple', paletteId: 'generic-24', grid: { width: 48, height: 48 }, features: featureVector(0.4) },
      { id: 'c', route: 'deterministic', style: 'high-contrast', paletteId: 'generic-24', grid: { width: 48, height: 48 }, features: featureVector(0.6) },
    ]
    const judgment = {
      schemaVersion: 'vision-judge-v1',
      generationId: 'generation-pet-01',
      source: { id: 'pet-01', groupId: 'cat-family-1', subjectKind: 'pet' },
      judge: {
        providerId: 'codex-built-in-vision', modelId: 'gpt-5.6-vision', modelVersion: '2026-09-02',
        weightSource: 'openai-managed', license: 'OpenAI service terms', confidence: 0.4, elapsedMs: 500,
      },
      candidateScores: { a: axes(5), b: axes(2), c: axes(4) },
      issues: [{ candidateId: 'b', issue: 'facial-feature-loss', severity: 5, confidence: 0.75 }],
      ranking: ['a', 'c', 'b'], bestCandidateId: 'a', eliminations: [],
      createdAt: '2026-09-02T08:00:00.000Z',
    }

    const first = buildVisionPreferenceRecord(judgment, candidates)
    const second = buildVisionPreferenceRecord(judgment, [...candidates].reverse())

    assert.deepEqual(first, second)
    assert.equal(first.annotator.raterType, 'vision-model')
    assert.equal(first.annotator.confidence, 0.4)
    assert.equal(first.comparisons.length, 3)
    assert.equal(first.comparisons[0].weight, 0.4)
    assert.equal(first.issueAnnotations[0].confidence, 0.3)
    assert.deepEqual(replayPreferenceRecord(JSON.stringify(first)).record, first)
  })
})
