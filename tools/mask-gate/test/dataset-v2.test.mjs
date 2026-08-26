import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  freezeMaskGateDataset,
  freezeMaskGateDatasetFiles,
  validateMaskGateCandidatePool,
} from '../src/dataset.mjs'

const quotas = {
  portrait: { 'targeted-failure': 10, 'clean-control': 1, extreme: 1 },
  pet: { 'targeted-failure': 10, 'clean-control': 1, extreme: 1 },
  illustration: { 'targeted-failure': 6, 'clean-control': 1, extreme: 1 },
  object: { 'targeted-failure': 6, 'clean-control': 1, extreme: 1 },
}

function candidates() {
  const result = []
  for (const [category, cohorts] of Object.entries(quotas)) {
    for (const [cohort, count] of Object.entries(cohorts)) {
      for (let index = 0; index < count + (cohort === 'targeted-failure' ? 3 : 0); index += 1) {
        const imageId = `${category}-${cohort}-${index + 1}`
        result.push({
          imageId,
          imagePath: `private/${imageId}.jpg`,
          category,
          cohort,
          failureTags: [cohort === 'clean-control' ? 'clean-mask' : 'thin-structure'],
          subjectCount: 1,
          targetMobile: index < 2,
          expectedDifficulty: cohort === 'extreme' ? 'extreme' : 'standard',
          source: {
            permission: 'public-domain',
            reference: `fixture-${imageId}`,
            url: `https://example.test/${imageId}`,
          },
        })
      }
    }
  }
  return result
}

function pool() {
  return {
    schemaVersion: 1,
    candidatePoolId: 'candidate-pool-2026-08',
    protocolVersion: 'mask-gate-v2',
    datasetId: 'mask-gate-2026-08',
    freezeSeed: 'freeze-seed-v1',
    sampleOrderSeed: 'sample-order-v1',
    modelConfigurationId: 'birefnet-general-lite-v1',
    commits: { core: 'core', demo: 'demo', gateway: 'gateway' },
    candidates: candidates(),
  }
}

describe('Mask Gate dataset freeze', () => {
  it('validates a 50-60 item licensed candidate pool', () => {
    const validated = validateMaskGateCandidatePool(pool())
    assert.ok(validated.candidates.length >= 50)
    assert.ok(validated.candidates.length <= 60)
  })

  it('freezes the exact 40-sample category and cohort quotas deterministically', () => {
    const first = freezeMaskGateDataset(pool())
    const second = freezeMaskGateDataset(pool())
    assert.deepEqual(first, second)
    assert.equal(first.manifest.samples.length, 40)
    for (const [category, cohorts] of Object.entries(quotas)) {
      for (const [cohort, count] of Object.entries(cohorts)) {
        assert.equal(first.manifest.samples.filter((sample) =>
          sample.category === category && sample.cohort === cohort).length, count)
      }
    }
    assert.equal(first.sampleOrder.length, 40)
    assert.match(first.manifestFingerprint, /^[a-f0-9]{64}$/)
  })

  it('writes manifest, fingerprint, order, and permission ledger artifacts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mask-freeze-v2-'))
    try {
      const frozen = await freezeMaskGateDatasetFiles(pool(), directory)
      assert.equal(frozen.manifest.samples.length, 40)
      assert.match(await readFile(join(directory, 'manifest.sha256'), 'utf8'), /^[a-f0-9]{64}\n$/)
      assert.equal(JSON.parse(await readFile(join(directory, 'sample-order.json'), 'utf8')).length, 40)
      const ledger = await readFile(join(directory, 'permission-ledger.csv'), 'utf8')
      assert.match(ledger, /imageId,permission,reference,url/)
      assert.match(ledger, /public-domain/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
