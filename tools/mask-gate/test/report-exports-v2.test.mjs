import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  renderCategoryBreakdownCsv,
  renderControlPreservationCsv,
  renderDeviceBreakdownCsv,
  renderFailureTagBreakdownCsv,
} from '../src/report-exports.mjs'

const interaction = {
  imageId: 'portrait-01',
  category: 'portrait',
  cohort: 'targeted-failure',
  failureTags: ['fine-hair'],
  initialSubjectAcceptable: false,
  outcome: 'confirmed',
  subjectAcceptable: true,
  correctionDurationMs: 12_000,
  device: { class: 'mobile', inputModality: 'touch' },
}

describe('Mask Gate report CSV exports', () => {
  it('renders category, failure tag, device, and control diagnostics', () => {
    const interactions = [
      interaction,
      {
        ...interaction,
        imageId: 'control-01',
        cohort: 'clean-control',
        failureTags: ['clean-mask'],
        initialSubjectAcceptable: true,
        outcome: 'accepted',
        correctionDurationMs: undefined,
        device: { class: 'desktop', inputModality: 'mouse' },
      },
    ]
    assert.match(renderCategoryBreakdownCsv(interactions), /portrait,2,1,1,0/)
    assert.match(renderFailureTagBreakdownCsv(interactions), /fine-hair,1,1,1/)
    assert.match(renderDeviceBreakdownCsv(interactions), /mobile,touch,1,1,1/)
    assert.match(renderControlPreservationCsv(interactions), /control-01,true,accepted,true/)
  })
})
