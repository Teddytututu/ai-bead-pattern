import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  fitBradleyTerry,
  predictPairwisePreference,
} from '../src/experimental.js'

describe('Bradley-Terry preference aggregation', () => {
  it('ranks candidates from A/B/Tie comparisons', () => {
    const comparisons = [
      { candidateAId: 'a', candidateBId: 'b', choice: 'a' as const },
      { candidateAId: 'a', candidateBId: 'b', choice: 'a' as const },
      { candidateAId: 'a', candidateBId: 'b', choice: 'a' as const },
      { candidateAId: 'b', candidateBId: 'c', choice: 'a' as const },
      { candidateAId: 'b', candidateBId: 'c', choice: 'a' as const },
      { candidateAId: 'a', candidateBId: 'c', choice: 'tie' as const },
    ]

    const result = fitBradleyTerry(['a', 'b', 'c'], comparisons)

    assert.deepEqual(result.rankedCandidateIds, ['a', 'b', 'c'])
    assert.ok(result.scores.a!.utility > result.scores.b!.utility)
    assert.ok(result.scores.b!.utility > result.scores.c!.utility)
    assert.equal(result.comparisonCount, comparisons.length)
  })

  it('keeps tie-only candidates equal and predicts an even choice', () => {
    const result = fitBradleyTerry(['left', 'right'], [{
      candidateAId: 'left',
      candidateBId: 'right',
      choice: 'tie',
    }])

    assert.ok(Math.abs(result.scores.left!.utility - result.scores.right!.utility) < 1e-9)
    assert.equal(predictPairwisePreference(result, 'left', 'right'), 0.5)
  })

  it('is deterministic across comparison order and balances a fair cycle', () => {
    const comparisons = [
      { candidateAId: 'a', candidateBId: 'b', choice: 'a' as const },
      { candidateAId: 'b', candidateBId: 'c', choice: 'a' as const },
      { candidateAId: 'c', candidateBId: 'a', choice: 'a' as const },
    ]
    const first = fitBradleyTerry(['c', 'a', 'b'], comparisons)
    const second = fitBradleyTerry(['b', 'c', 'a'], [...comparisons].reverse())

    assert.deepEqual(first, second)
    assert.deepEqual(first.rankedCandidateIds, ['a', 'b', 'c'])
    assert.ok(Math.max(...Object.values(first.scores).map((entry) => Math.abs(entry.utility))) < 1e-9)
  })

  it('returns a stable equal prior before any preference data exists', () => {
    const result = fitBradleyTerry(['b', 'a'], [])

    assert.deepEqual(result.rankedCandidateIds, ['a', 'b'])
    assert.equal(result.iterations, 0)
    assert.equal(result.converged, true)
    assert.equal(result.scores.a!.share, 0.5)
    assert.equal(result.scores.b!.share, 0.5)
  })

  it('rejects unknown candidates, self-comparisons, and invalid weights', () => {
    assert.throws(() => fitBradleyTerry(['a'], [{
      candidateAId: 'a',
      candidateBId: 'b',
      choice: 'a',
    }]), /unknown candidate/i)
    assert.throws(() => fitBradleyTerry(['a'], [{
      candidateAId: 'a',
      candidateBId: 'a',
      choice: 'tie',
    }]), /distinct candidates/i)
    assert.throws(() => fitBradleyTerry(['a', 'b'], [{
      candidateAId: 'a',
      candidateBId: 'b',
      choice: 'a',
      weight: 0,
    }]), /positive weight/i)
  })
})
