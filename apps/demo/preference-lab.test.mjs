import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createBlindCandidatePair,
  loadPreferenceRecords,
  resolveCandidatePreference,
  savePreferenceRecords,
} from './preference-lab.mjs'

describe('candidate preference lab', () => {
  it('keeps blind candidate order stable for one generation and rater', async () => {
    const input = {
      generationId: 'generation-1',
      candidateAId: 'candidate-a',
      candidateBId: 'candidate-b',
      raterId: 'local-rater',
    }
    const first = await createBlindCandidatePair(input)
    const second = await createBlindCandidatePair(input)

    assert.deepEqual(first, second)
    assert.match(first.seed, /^[a-f0-9]{64}$/)
    assert.deepEqual(new Set([first.leftCandidateId, first.rightCandidateId]),
      new Set(['candidate-a', 'candidate-b']))
  })

  it('restores the hidden candidate identity from A/B/Tie choice', async () => {
    const pair = await createBlindCandidatePair({
      generationId: 'generation-1',
      candidateAId: 'candidate-a',
      candidateBId: 'candidate-b',
      raterId: 'local-rater',
    })
    const left = resolveCandidatePreference(pair, 'left')
    const tie = resolveCandidatePreference(pair, 'tie')

    assert.equal(left.choice,
      pair.leftCandidateId === pair.candidateAId ? 'a' : 'b')
    assert.equal(tie.choice, 'tie')
    assert.equal(left.candidateAId, 'candidate-a')
    assert.equal(left.candidateBId, 'candidate-b')
  })

  it('persists validated preference records in local storage', () => {
    const values = new Map()
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    }
    const records = [{
      id: 'record-1',
      sourceId: 'generation-1',
      raterId: 'local-rater',
      candidateAId: 'candidate-a',
      candidateBId: 'candidate-b',
      choice: 'a',
    }]

    savePreferenceRecords(storage, records)

    assert.deepEqual(loadPreferenceRecords(storage), records)
  })
})
