import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import sharp from 'sharp'

import { collectMaskGateRecord } from '../src/collect.mjs'
import { correctionAreaRatio } from '../src/record.mjs'
import {
  fitMaskGateSourceDimensions,
  generateMaskGateSidecars,
  loadMaskGateSidecar,
} from '../src/sidecar.mjs'

function sample(overrides = {}) {
  return {
    imageId: 'portrait-01',
    imagePath: 'portrait.png',
    category: 'portrait',
    cohort: 'targeted-failure',
    failureTags: ['fine-hair'],
    subjectCount: 1,
    targetMobile: false,
    source: {
      permission: 'owned',
      reference: 'internal-photo-001',
    },
    ...overrides,
  }
}

function manifest(samples = [sample()]) {
  return {
    schemaVersion: 2,
    protocolVersion: 'mask-gate-v2',
    datasetId: 'sidecar-test',
    sampleOrderSeed: 'sidecar-order-v2',
    modelConfigurationId: 'birefnet-general-lite-v1',
    commits: {
      core: 'core-commit',
      demo: 'demo-commit',
      gateway: 'gateway-commit',
    },
    samples,
  }
}

function snapshot(generationId) {
  return {
    generationId,
    candidateId: `${generationId}-candidate`,
    patternHash: `${generationId}-pattern`,
    optionsHash: 'fixed-options',
    width: 32,
    height: 32,
    colorCount: 8,
    totalBeads: 600,
  }
}

function device() {
  return {
    class: 'desktop',
    inputModality: 'mouse',
    viewportWidth: 1440,
    viewportHeight: 900,
    devicePixelRatio: 1,
    maxTouchPoints: 0,
    platform: 'Windows',
  }
}

function provider(assertDimensions) {
  return {
    async segment({ image }) {
      assertDimensions?.(image)
      const mask = {
        width: image.width,
        height: image.height,
        values: Float32Array.from({ length: image.width * image.height }, (_, index) =>
          index % 2 === 0 ? 0.25 : 0.75),
      }
      return {
        provider: 'rembg-http',
        model: 'birefnet-general-lite',
        elapsedMs: 12,
        analysis: {
          subjectMask: mask,
          subjectMaskEvidence: {
            mask,
            confidence: 0.8,
            source: 'ai',
            revision: 'rembg-http:birefnet-general-lite:test-mask',
            provenance: [{
              origin: 'model',
              provider: 'rembg-http',
              model: 'birefnet-general-lite',
              version: 'test',
            }],
          },
          modelVersions: { segmentation: 'rembg/birefnet-general-lite' },
        },
      }
    },
  }
}

describe('mask correction measurement', () => {
  it('measures changed mask area from authoritative masks', () => {
    const base = Float32Array.from([0, 0.2, 0.8, 1])
    const corrected = Float32Array.from([0, 0.7, 0.8, 0.4])
    assert.equal(correctionAreaRatio(base, corrected), 0.5)
  })
})

describe('BiRefNet sidecars', () => {
  it('fits large sources inside side and pixel limits while preserving aspect ratio', () => {
    assert.deepEqual(fitMaskGateSourceDimensions(2048, 2048), { width: 2000, height: 2000 })
    assert.deepEqual(fitMaskGateSourceDimensions(4000, 2000), { width: 2048, height: 1024 })
    assert.throws(() => fitMaskGateSourceDimensions(10000, 2), /aspect ratio/i)
  })

  it('writes V2 identity, verifies artifacts, and replays a confirmed correction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mask-gate-v2-'))
    try {
      const imagePath = join(directory, 'portrait.png')
      await sharp(Buffer.from([
        220, 20, 20, 255,
        20, 220, 20, 255,
      ]), { raw: { width: 2, height: 1, channels: 4 } }).png().toFile(imagePath)
      const manifestPath = join(directory, 'manifest.json')
      await writeFile(manifestPath, JSON.stringify(manifest()))
      const outputDirectory = join(directory, 'output')
      const index = await generateMaskGateSidecars({
        manifestPath,
        outputDirectory,
        provider: provider(),
        gatewayCommit: 'gateway-commit',
      })

      assert.equal(index.protocolVersion, 'mask-gate-v2')
      assert.match(index.manifestFingerprint, /^[a-f0-9]{64}$/)
      const sidecarPath = join(outputDirectory, 'portrait-01.analysis.json')
      const loaded = await loadMaskGateSidecar(sidecarPath)
      assert.equal(loaded.metadata.sample.cohort, 'targeted-failure')
      assert.match(loaded.metadata.source.sha256, /^[a-f0-9]{64}$/)
      assert.deepEqual(
        [...loaded.mask.values].map((value) => Math.round(value * 255)),
        [64, 191],
      )
      assert.ok((await readFile(join(outputDirectory, 'portrait-01.source.png'))).length > 0)

      const attempt = {
        protocolVersion: index.protocolVersion,
        attemptId: 'sidecar-test:portrait-01:rater-a',
        datasetId: index.datasetId,
        manifestFingerprint: index.manifestFingerprint,
        imageId: 'portrait-01',
        raterId: 'rater-a',
        sampleOrder: index.samples[0].sampleOrder,
        sampleOrderSeed: index.sampleOrderSeed,
        coreCommit: index.commits.core,
        demoCommit: index.commits.demo,
        gatewayCommit: index.commits.gateway,
        modelConfigurationId: index.modelConfigurationId,
        initialRatingAt: 900,
        initialSubjectAcceptable: false,
        outcome: 'confirmed',
        outcomeAt: 9_000,
        correctionStartedAt: 1_000,
        correctionEndedAt: 9_000,
        beforeSnapshot: snapshot('before-sidecar'),
        afterSnapshot: snapshot('after-sidecar'),
        subjectAcceptable: true,
        blindComparison: { leftVariant: 'before', choice: 'right', seed: 'blind-seed' },
        ratedAt: 10_000,
        device: device(),
        session: {
          baseRevision: loaded.metadata.evidence.revision,
          strokes: [{
            id: 'erase-right',
            mode: 'erase',
            radiusNormalized: 0.3,
            points: [{ x: 0.75, y: 0.5 }],
          }],
          cursor: 1,
        },
      }
      const collected = await collectMaskGateRecord({
        sample: manifest().samples[0],
        sidecarPath,
        attempt,
      })
      assert.equal(collected.interaction.outcome, 'confirmed')
      assert.equal(collected.interaction.strokeCount, 1)
      assert.equal(collected.preference.patternPreference, 'after')

      const tampered = JSON.parse(await readFile(sidecarPath, 'utf8'))
      tampered.mask.numericFingerprint = '0000000000000000'
      await writeFile(sidecarPath, JSON.stringify(tampered))
      await assert.rejects(() => loadMaskGateSidecar(sidecarPath), /fingerprint|revision/i)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('applies EXIF orientation before choosing normalized source dimensions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mask-gate-orientation-v2-'))
    try {
      await sharp(Buffer.from([
        240, 20, 20,
        20, 20, 240,
      ]), { raw: { width: 2, height: 1, channels: 3 } })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toFile(join(directory, 'rotated.jpg'))
      const rotatedSample = sample({ imagePath: 'rotated.jpg' })
      const manifestPath = join(directory, 'manifest.json')
      await writeFile(manifestPath, JSON.stringify(manifest([rotatedSample])))
      await generateMaskGateSidecars({
        manifestPath,
        outputDirectory: join(directory, 'output'),
        provider: provider((image) => {
          assert.equal(image.width, 1)
          assert.equal(image.height, 2)
        }),
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
