import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { expandCodexReview } from '../src/codex-review.mjs'

describe('Codex built-in vision review expansion', () => {
  it('expands concise visual ratings into every scoring axis', () => {
    const judgment = expandCodexReview({
      generationId: 'generation-1',
      source: { id: 'pet-1', groupId: 'pet-1', subjectKind: 'pet' },
      candidates: [{ id: 'A', grid: { width: 48, height: 48 } }, { id: 'B', grid: { width: 48, height: 48 } }],
    }, {
      ranking: ['B', 'A'],
      scores: { A: { base: 2, palette: 4 }, B: { base: 4, identityFeatures: 5 } },
      issues: [], eliminations: [], confidence: 0.8,
    }, {
      modelId: 'codex-built-in-vision', modelVersion: '2026-09-02', createdAt: '2026-09-02T09:00:00.000Z',
    })

    assert.equal(Object.keys(judgment.candidateScores.A).length, 11)
    assert.equal(judgment.candidateScores.A.palette, 4)
    assert.equal(judgment.candidateScores.A.silhouette, 2)
    assert.equal(judgment.candidateScores.B.identityFeatures, 5)
  })
})
