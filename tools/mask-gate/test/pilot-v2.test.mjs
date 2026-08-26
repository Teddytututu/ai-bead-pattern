import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  createMaskGatePilotAttempt,
  createMaskGatePilotPlan,
  validateMaskGatePilotResult,
} from '../src/pilot.mjs'
import { resolveBlindPreference } from '../src/protocol.mjs'

const samples = [
  { imageId: 'portrait-control', category: 'portrait', cohort: 'clean-control', targetMobile: false },
  { imageId: 'portrait-failure', category: 'portrait', cohort: 'targeted-failure', targetMobile: true },
  { imageId: 'pet-failure-a', category: 'pet', cohort: 'targeted-failure', targetMobile: true },
  { imageId: 'pet-failure-b', category: 'pet', cohort: 'targeted-failure', targetMobile: false },
  { imageId: 'object-failure', category: 'object', cohort: 'targeted-failure', targetMobile: false },
]

describe('Mask Gate V2 Pilot protocol fixtures', () => {
  it('selects a stable five-sample plan with all terminal outcomes and two mobile trials', () => {
    const plan = createMaskGatePilotPlan({ samples })

    assert.deepEqual(plan.map((entry) => entry.imageId), [
      'portrait-control',
      'portrait-failure',
      'pet-failure-a',
      'pet-failure-b',
      'object-failure',
    ])
    assert.deepEqual(plan.map((entry) => entry.outcome), [
      'accepted',
      'confirmed',
      'confirmed',
      'cancelled',
      'error',
    ])
    assert.equal(plan.filter((entry) => entry.device.class === 'mobile').length, 2)
  })

  it('requires collect, preference, replay, report, and diagnostic evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mask-gate-pilot-'))
    const files = {
      records: 'records.jsonl',
      preferences: 'preferences.jsonl',
      report: 'report.md',
      summary: 'summary.json',
      replay: 'replay.json',
      diagnostics: [
        'category-breakdown.csv',
        'failure-tag-breakdown.csv',
        'device-breakdown.csv',
        'control-preservation.csv',
      ],
    }
    const result = validateMaskGatePilotResult({
      plan: createMaskGatePilotPlan({ samples }),
      interactionCount: 5,
      preferenceCount: 2,
      replayedConfirmedCount: 2,
      files,
    })

    assert.equal(result.complete, true)
    assert.equal(result.protocolFixture, true)
    assert.equal(result.files.records, files.records)
    await assert.rejects(readFile(join(directory, files.records), 'utf8'), /ENOENT/)
  })

  it('builds deterministic attempts with valid outcome-specific fields', async () => {
    const plan = createMaskGatePilotPlan({ samples })
    const metadata = {
      protocolVersion: 'mask-gate-v2',
      datasetId: 'mask-gate-pilot',
      manifestFingerprint: 'manifest-fingerprint',
      imageId: 'portrait-failure',
      sampleOrder: 7,
      sampleOrderSeed: 'sample-order-seed',
      modelConfigurationId: 'birefnet-general-lite-post-v1',
      commits: { core: 'core', demo: 'demo', gateway: 'gateway' },
      evidence: { revision: 'sidecar:revision', confidence: 0.9 },
      source: { width: 640, height: 480 },
    }
    const first = await createMaskGatePilotAttempt({
      entry: plan[1],
      metadata,
      fixtureEpochMs: 1_700_000_000_000,
    })
    const second = await createMaskGatePilotAttempt({
      entry: plan[1],
      metadata,
      fixtureEpochMs: 1_700_000_000_000,
    })

    assert.deepEqual(first, second)
    assert.equal(first.outcome, 'confirmed')
    assert.equal(first.session.baseRevision, metadata.evidence.revision)
    assert.equal(first.subjectAcceptable, true)
    assert.equal(resolveBlindPreference(first.blindComparison), 'after')
    assert.match(first.beforeSnapshot.patternHash, /^[a-f0-9]{64}$/)
    assert.match(first.afterSnapshot.patternHash, /^[a-f0-9]{64}$/)

    const accepted = await createMaskGatePilotAttempt({
      entry: plan[0],
      metadata: { ...metadata, imageId: plan[0].imageId },
      fixtureEpochMs: 1_700_000_000_000,
    })
    const failed = await createMaskGatePilotAttempt({
      entry: plan[4],
      metadata: { ...metadata, imageId: plan[4].imageId },
      fixtureEpochMs: 1_700_000_000_000,
    })
    assert.equal(accepted.initialSubjectAcceptable, true)
    assert.equal('session' in accepted, false)
    assert.equal(failed.error.code, 'pilot-fixture-error')
    assert.equal('session' in failed, false)
  })
})
