import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createMaskGateSampleOrder,
  fingerprintMaskGateManifest,
  validateMaskGateManifest,
} from '../src/manifest.mjs'

function manifest() {
  return {
    schemaVersion: 2,
    protocolVersion: 'mask-gate-v2',
    datasetId: 'mask-gate-40',
    sampleOrderSeed: 'order-seed-a',
    modelConfigurationId: 'birefnet-lite-post-v1',
    commits: {
      core: 'core-commit',
      demo: 'demo-commit',
      gateway: 'gateway-commit',
    },
    samples: [{
      imageId: 'portrait-01',
      imagePath: 'private/portrait-01.jpg',
      category: 'portrait',
      cohort: 'targeted-failure',
      failureTags: ['fine-hair', 'occlusion'],
      subjectCount: 1,
      targetMobile: true,
      source: { permission: 'owned', reference: 'photo-1' },
    }, {
      imageId: 'object-01',
      imagePath: 'private/object-01.png',
      category: 'object',
      cohort: 'clean-control',
      failureTags: ['hard-corner'],
      subjectCount: 1,
      targetMobile: false,
      source: { permission: 'public-domain', reference: 'object-1' },
    }],
  }
}

describe('Mask Gate Manifest V2', () => {
  it('validates protocol identity, categories, cohorts, and failure tags', () => {
    const validated = validateMaskGateManifest(manifest())

    assert.equal(validated.schemaVersion, 2)
    assert.equal(validated.samples[0].category, 'portrait')
    assert.deepEqual(validated.samples[0].failureTags, ['fine-hair', 'occlusion'])
    assert.equal(validated.commits.gateway, 'gateway-commit')
  })

  it('fingerprints canonical content independently from object key order', () => {
    const first = manifest()
    const second = {
      samples: first.samples,
      commits: first.commits,
      modelConfigurationId: first.modelConfigurationId,
      sampleOrderSeed: first.sampleOrderSeed,
      datasetId: first.datasetId,
      protocolVersion: first.protocolVersion,
      schemaVersion: first.schemaVersion,
    }

    assert.equal(fingerprintMaskGateManifest(first), fingerprintMaskGateManifest(second))
    assert.match(fingerprintMaskGateManifest(first), /^[a-f0-9]{64}$/)
  })

  it('creates a deterministic complete sample order', () => {
    const first = createMaskGateSampleOrder(manifest())
    const second = createMaskGateSampleOrder(manifest())

    assert.deepEqual(first, second)
    assert.deepEqual(new Set(first.map((entry) => entry.imageId)), new Set(['portrait-01', 'object-01']))
    assert.deepEqual(first.map((entry) => entry.sampleOrder).toSorted(), [1, 2])
  })

  it('rejects duplicate tags and legacy category or cohort values', () => {
    const duplicateTags = manifest()
    duplicateTags.samples[0].failureTags = ['fine-hair', 'fine-hair']
    assert.throws(() => validateMaskGateManifest(duplicateTags), /failureTags/i)

    const legacy = manifest()
    legacy.samples[0].cohort = 'failure'
    assert.throws(() => validateMaskGateManifest(legacy), /cohort/i)
  })
})
