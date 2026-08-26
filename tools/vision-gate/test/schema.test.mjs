import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  createVisionGateProtocolFixtures,
  validateVisionGateManifest,
  validateVisionGatePrediction,
} from '../src/schema.mjs'
import { writeVisionGateProtocolFixtures } from '../src/protocol-fixtures.mjs'

describe('Vision Gate schema', () => {
  it('creates a complete 30-sample protocol fixture manifest', () => {
    const manifest = validateVisionGateManifest(createVisionGateProtocolFixtures())

    assert.equal(manifest.samples.length, 30)
    assert.equal(manifest.gridSize, 48)
    for (const tag of [
      'front-face',
      'light-profile',
      'three-quarter',
      'glasses',
      'bangs',
      'occlusion',
      'low-light',
      'complex-background',
      'small-full-body',
    ]) {
      assert.ok(manifest.samples.some((sample) => sample.challengeTags.includes(tag)))
    }
  })

  it('rejects duplicate samples and incomplete prediction identity', () => {
    const manifest = createVisionGateProtocolFixtures()
    manifest.samples[1].imageId = manifest.samples[0].imageId
    assert.throws(() => validateVisionGateManifest(manifest), /Duplicate imageId/)

    assert.throws(() => validateVisionGatePrediction({
      schemaVersion: 1,
      protocolVersion: 'vision-gate-v1',
      datasetId: 'vision-gate-protocol-fixtures-30',
      imageId: 'portrait-01',
      selectionStatus: 'primary',
      landmarks: [],
      regions: {},
      modelVersions: {},
    }), /modelVersions/)
  })

  it('keeps non-primary selection records free of portrait outputs', () => {
    assert.throws(() => validateVisionGatePrediction({
      schemaVersion: 1,
      protocolVersion: 'vision-gate-v1',
      datasetId: 'vision-gate-protocol-fixtures-30',
      imageId: 'portrait-01',
      selectionStatus: 'ambiguous',
      landmarks: [{ id: 'left-eye-center', x: 0.4, y: 0.4, confidence: 0.8 }],
      regions: {},
      modelVersions: { faceLandmarks: 'mediapipe/v1' },
    }), /non-primary/)
  })

  it('writes a runnable manifest and one prediction per sample', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vision-gate-'))
    const output = await writeVisionGateProtocolFixtures(directory)
    const manifest = JSON.parse(await readFile(output.manifestPath, 'utf8'))
    const predictionLines = (await readFile(output.predictionsPath, 'utf8')).trim().split(/\r?\n/)

    assert.equal(validateVisionGateManifest(manifest).samples.length, 30)
    assert.equal(predictionLines.length, 30)
    assert.equal(validateVisionGatePrediction(JSON.parse(predictionLines[0])).imageId, 'portrait-01')
  })
})
