import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createVisionGateProtocolFixtures,
  createVisionGateProtocolPredictions,
} from '../src/schema.mjs'
import {
  renderVisionGateReport,
  summarizeVisionGate,
} from '../src/report.mjs'
import {
  renderCalibrationBinsCsv,
  renderLandmarkErrorsCsv,
  renderRegionOverlapCsv,
  renderSampleBreakdownCsv,
} from '../src/report-exports.mjs'

describe('Vision Gate report', () => {
  it('passes a complete accurate 30-sample protocol run', () => {
    const manifest = createVisionGateProtocolFixtures()
    const predictions = createVisionGateProtocolPredictions(manifest)
    const summary = summarizeVisionGate(manifest, predictions)

    assert.equal(summary.sampleCount, 30)
    assert.equal(summary.eyeWithinOneCellRate, 1)
    assert.equal(summary.mouthWithinOneAndHalfCellsRate, 1)
    assert.equal(summary.highConfidenceHardMismatchRate, 0)
    assert.equal(summary.passed, true)
    assert.match(renderVisionGateReport(summary), /Result: \*\*PASS\*\*/)
  })

  it('exports sample, landmark, region, and calibration diagnostics', () => {
    const manifest = createVisionGateProtocolFixtures()
    const predictions = createVisionGateProtocolPredictions(manifest)
    const summary = summarizeVisionGate(manifest, predictions)

    assert.match(renderSampleBreakdownCsv(summary), /portrait-01/)
    assert.match(renderLandmarkErrorsCsv(summary), /left-eye-center/)
    assert.match(renderRegionOverlapCsv(summary), /face-skin/)
    assert.match(renderCalibrationBinsCsv(summary), /lowerBound,upperBound/)
  })

  it('fails confidence coverage when every hard landmark stays below high confidence', () => {
    const manifest = createVisionGateProtocolFixtures()
    const predictions = createVisionGateProtocolPredictions(manifest)
    for (const prediction of predictions) {
      for (const landmark of prediction.landmarks) landmark.confidence = 0.8
    }
    const summary = summarizeVisionGate(manifest, predictions)

    assert.equal(summary.highConfidenceHardMismatchRate, null)
    assert.equal(summary.criteria.confidence, false)
    assert.equal(summary.passed, false)
  })
})
