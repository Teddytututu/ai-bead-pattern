import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { inferSubjectAnalysis } from './subject-mask.mjs'

function image(width, height, pixels) {
  return {
    width,
    height,
    data: Uint8ClampedArray.from(pixels.flat()),
  }
}

describe('demo subject mask inference', () => {
  it('uses alpha as a high-confidence subject mask', () => {
    const analysis = inferSubjectAnalysis(image(2, 2, [
      [200, 40, 40, 0], [200, 40, 40, 255],
      [200, 40, 40, 0], [200, 40, 40, 255],
    ]))

    assert.equal(analysis.source, 'alpha')
    assert.equal(analysis.confidence, 1)
    assert.deepEqual([...analysis.subjectMask.values], [0, 1, 0, 1])
    assert.equal(analysis.subjectMaskEvidence.source, 'alpha')
    assert.equal(analysis.subjectMaskEvidence.provenance[0].origin, 'source')
  })

  it('flood-fills a flat border while retaining the enclosed subject', () => {
    const background = [240, 240, 235, 255]
    const subject = [180, 40, 40, 255]
    const analysis = inferSubjectAnalysis(image(3, 3, [
      background, background, background,
      background, subject, background,
      background, background, background,
    ]))

    assert.equal(analysis.source, 'border-flood')
    assert.ok(analysis.confidence >= 0.5)
    assert.deepEqual([...analysis.subjectMask.values], [0, 0, 0, 0, 1, 0, 0, 0, 0])
    assert.equal(analysis.subjectMaskEvidence.source, 'heuristic')
    assert.equal(analysis.subjectMaskEvidence.provenance[0].origin, 'heuristic')
  })
})
