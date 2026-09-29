import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { inferSubjectAnalysis } from '../../src/subject-mask.mjs'

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

  it('does not invent a mask for opaque images when no neural result exists', () => {
    const background = [240, 240, 235, 255]
    const subject = [180, 40, 40, 255]
    const analysis = inferSubjectAnalysis(image(3, 3, [
      background, background, background,
      background, subject, background,
      background, background, background,
    ]))

    assert.equal(analysis.source, 'unavailable')
    assert.equal(analysis.confidence, 0)
    assert.equal(analysis.subjectMask, undefined)
    assert.equal(analysis.subjectMaskEvidence, undefined)
  })
})
