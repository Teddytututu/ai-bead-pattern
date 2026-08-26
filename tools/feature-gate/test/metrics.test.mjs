import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createFeatureGateProtocolFixtures,
  createFeatureGateProtocolRecords,
} from '../src/schema.mjs'
import { evaluateFeatureGateRecord } from '../src/metrics.mjs'

describe('Feature Gate metrics', () => {
  it('measures Top-2 acceptance and complete visibility per feature', () => {
    const record = createFeatureGateProtocolRecords(createFeatureGateProtocolFixtures())[0]
    const result = evaluateFeatureGateRecord(record)

    assert.equal(result.features.every((feature) => feature.top2Accepted), true)
    assert.equal(result.features.every((feature) => feature.fullyVisible), true)
    assert.equal(result.collisions.length, 0)
  })

  it('finds hard-feature cell collisions', () => {
    const record = createFeatureGateProtocolRecords(createFeatureGateProtocolFixtures())[0]
    const left = record.features[0].topCandidates.find((entry) =>
      entry.candidateId === record.features[0].selectedCandidateId)
    const right = record.features[1].topCandidates.find((entry) =>
      entry.candidateId === record.features[1].selectedCandidateId)
    right.occupiedCells = [left.occupiedCells[0]]
    record.features[1].visibleCells = [...right.occupiedCells]
    const result = evaluateFeatureGateRecord(record)

    assert.equal(result.collisions.length, 1)
    assert.equal(result.collisions[0].overlapCells.length, 1)
  })

  it('marks an accepted candidate outside the first two as a Top-2 miss', () => {
    const record = createFeatureGateProtocolRecords(createFeatureGateProtocolFixtures())[0]
    record.features[2].topCandidates.push({
      candidateId: 'mouth-third',
      templateId: 'mouth-m3',
      occupiedCells: [record.size * 20 + 16],
      score: 0.5,
    })
    record.features[2].acceptedCandidateIds = ['mouth-third']
    const result = evaluateFeatureGateRecord(record)

    assert.equal(result.features.find((feature) => feature.kind === 'mouth').top2Accepted, false)
  })
})
