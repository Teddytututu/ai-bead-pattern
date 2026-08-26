import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createFeatureGateProtocolFixtures,
  createFeatureGateProtocolRecords,
} from '../src/schema.mjs'
import {
  renderFeatureGateReport,
  summarizeFeatureGate,
} from '../src/report.mjs'
import {
  renderCollisionBreakdownCsv,
  renderFeatureBreakdownCsv,
  renderSampleBreakdownCsv,
  renderSizeBreakdownCsv,
} from '../src/report-exports.mjs'

describe('Feature Gate report', () => {
  it('passes a complete accurate protocol run', () => {
    const manifest = createFeatureGateProtocolFixtures()
    const summary = summarizeFeatureGate(manifest, createFeatureGateProtocolRecords(manifest))

    assert.equal(summary.recordCount, 90)
    assert.equal(summary.eyeTop2AcceptanceRate, 1)
    assert.equal(summary.mouthTop2AcceptanceRate, 1)
    assert.equal(summary.hardCollisionCount, 0)
    assert.equal(summary.hardFeatureVisibilityRate, 1)
    assert.equal(summary.passed, true)
    assert.match(renderFeatureGateReport(summary), /Result: \*\*PASS\*\*/)
  })

  it('fails when collisions and mouth misses exceed the thresholds', () => {
    const manifest = createFeatureGateProtocolFixtures()
    const records = createFeatureGateProtocolRecords(manifest)
    for (const record of records) {
      const mouth = record.features.find((feature) => feature.kind === 'mouth')
      mouth.topCandidates.push({
        candidateId: `${record.imageId}-${record.size}-mouth-third`,
        templateId: 'mouth-open',
        occupiedCells: [record.size * Math.floor(record.size * 0.7) + Math.floor(record.size * 0.5)],
        score: 0.5,
      })
      mouth.acceptedCandidateIds = [mouth.topCandidates[2].candidateId]
    }
    const left = records[0].features[0].topCandidates.find((entry) =>
      entry.candidateId === records[0].features[0].selectedCandidateId)
    const right = records[0].features[1].topCandidates.find((entry) =>
      entry.candidateId === records[0].features[1].selectedCandidateId)
    right.occupiedCells = [left.occupiedCells[0]]
    records[0].features[1].visibleCells = [...right.occupiedCells]
    const summary = summarizeFeatureGate(manifest, records)

    assert.equal(summary.criteria.mouthTop2, false)
    assert.equal(summary.criteria.collisions, false)
    assert.equal(summary.passed, false)
  })

  it('exports sample, feature, collision, and size diagnostics', () => {
    const manifest = createFeatureGateProtocolFixtures()
    const summary = summarizeFeatureGate(manifest, createFeatureGateProtocolRecords(manifest))

    assert.match(renderSampleBreakdownCsv(summary), /portrait-01/)
    assert.match(renderFeatureBreakdownCsv(summary), /left-eye-center/)
    assert.match(renderCollisionBreakdownCsv(summary), /overlapCells/)
    assert.match(renderSizeBreakdownCsv(summary), /size,records/)
  })
})
