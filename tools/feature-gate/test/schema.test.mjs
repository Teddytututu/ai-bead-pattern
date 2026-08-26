import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  createFeatureGateProtocolFixtures,
  createFeatureGateProtocolRecords,
  validateFeatureGateManifest,
  validateFeatureGateRecord,
} from '../src/schema.mjs'
import { writeFeatureGateProtocolFixtures } from '../src/protocol-fixtures.mjs'

describe('Feature Gate schema', () => {
  it('creates 30 portrait samples and three target sizes', () => {
    const manifest = validateFeatureGateManifest(createFeatureGateProtocolFixtures())

    assert.equal(manifest.samples.length, 30)
    assert.deepEqual(manifest.targetSizes, [32, 48, 64])
  })

  it('creates one complete record per sample and target size', () => {
    const manifest = createFeatureGateProtocolFixtures()
    const records = createFeatureGateProtocolRecords(manifest)

    assert.equal(records.length, 90)
    assert.equal(records.every((record) => validateFeatureGateRecord(record).features.length === 4), true)
  })

  it('rejects feature cells outside their target grid', () => {
    const manifest = createFeatureGateProtocolFixtures()
    const record = createFeatureGateProtocolRecords(manifest)[0]
    record.features[0].topCandidates[0].occupiedCells = [record.size * record.size]

    assert.throws(() => validateFeatureGateRecord(record), /target grid/i)
  })

  it('writes a runnable manifest and ninety JSONL records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feature-gate-'))
    const output = await writeFeatureGateProtocolFixtures(directory)
    const manifest = JSON.parse(await readFile(output.manifestPath, 'utf8'))
    const lines = (await readFile(output.recordsPath, 'utf8')).trim().split(/\r?\n/)

    assert.equal(validateFeatureGateManifest(manifest).samples.length, 30)
    assert.equal(lines.length, 90)
    assert.equal(validateFeatureGateRecord(JSON.parse(lines[0])).size, 32)
  })
})
