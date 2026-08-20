import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import sharp from 'sharp'

import { collectMaskGateRecord } from '../src/collect.mjs'
import { validateMaskGateManifest } from '../src/manifest.mjs'
import {
  correctionAreaRatio,
  createMaskGateRecord,
} from '../src/record.mjs'
import {
  defaultGateThresholds,
  renderMaskGateReport,
  summarizeMaskGate,
} from '../src/report.mjs'
import {
  fitMaskGateSourceDimensions,
  generateMaskGateSidecars,
  loadMaskGateSidecar,
} from '../src/sidecar.mjs'

function sample(overrides = {}) {
  return {
    imageId: 'portrait-01',
    imagePath: 'private/portrait-01.jpg',
    category: 'portrait',
    cohort: 'failure',
    failureType: 'fine-hair',
    source: {
      permission: 'owned',
      reference: 'internal-photo-001',
    },
    ...overrides,
  }
}

function session(strokes, cursor = strokes.length) {
  return {
    baseRevision: 'rembg-http:birefnet-general-lite:mask-v1',
    strokes,
    cursor,
  }
}

function stroke(id, mode) {
  return {
    id,
    mode,
    radiusNormalized: 0.02,
    points: [{ x: 0.25, y: 0.5 }, { x: 0.5, y: 0.5 }],
  }
}

function record(overrides = {}) {
  const requestedStrokeCount = overrides.strokeCount ?? 4
  const requestedStrokes = Array.from({ length: requestedStrokeCount }, (_, index) =>
    stroke(`stroke-${index + 1}`, index === requestedStrokeCount - 1 ? 'erase' : 'add'))
  const addStrokeCount = requestedStrokes.filter((item) => item.mode === 'add').length
  return {
    schemaVersion: 1,
    datasetId: 'mask-failure-2026-08',
    imageId: 'portrait-01',
    category: 'portrait',
    cohort: 'failure',
    failureType: 'fine-hair',
    sourceRevision: 'rembg-http:birefnet-general-lite:mask-v1',
    sourceConfidence: 0.8,
    correctionStartedAt: 1_000,
    correctionEndedAt: 11_000,
    correctionDurationMs: 10_000,
    strokeCount: requestedStrokeCount,
    addStrokeCount,
    eraseStrokeCount: requestedStrokeCount - addStrokeCount,
    correctionAreaRatio: 0.04,
    confirmedRevision: 'manual:confirmed:1',
    beforeGenerationId: 'before-1',
    afterGenerationId: 'after-1',
    initialSubjectAcceptable: false,
    subjectAcceptable: true,
    patternPreference: 'after',
    deviceClass: 'desktop',
    outcome: 'confirmed',
    session: session(requestedStrokes),
    ...overrides,
  }
}

describe('mask failure manifest', () => {
  it('accepts traceable local samples and preserves evaluation cohorts', () => {
    const manifest = validateMaskGateManifest({
      schemaVersion: 1,
      datasetId: 'mask-failure-2026-08',
      samples: [
        sample(),
        sample({
          imageId: 'pet-01',
          imagePath: 'private/pet-01.png',
          category: 'pet',
          cohort: 'control',
          failureType: 'clean-mask',
        }),
      ],
    })

    assert.equal(manifest.samples.length, 2)
    assert.equal(manifest.samples[0].cohort, 'failure')
    assert.equal(manifest.samples[1].cohort, 'control')
  })

  it('rejects duplicate ids and samples without permission metadata', () => {
    assert.throws(() => validateMaskGateManifest({
      schemaVersion: 1,
      datasetId: 'duplicates',
      samples: [sample(), sample()],
    }), /duplicate/i)

    assert.throws(() => validateMaskGateManifest({
      schemaVersion: 1,
      datasetId: 'missing-source',
      samples: [sample({ source: { permission: '', reference: '' } })],
    }), /permission|reference/i)
  })
})

describe('mask failure records', () => {
  it('measures changed mask area from authoritative masks', () => {
    const base = Float32Array.from([0, 0.2, 0.8, 1])
    const corrected = Float32Array.from([0, 0.7, 0.8, 0.4])

    assert.equal(correctionAreaRatio(base, corrected), 0.5)
    assert.equal(
      correctionAreaRatio(Float32Array.from([0, 0]), Float32Array.from([1 / 255, 0])),
      0.5,
    )
  })

  it('derives active stroke counts and timing from the saved session', () => {
    const editSession = session([
      stroke('add-1', 'add'),
      stroke('erase-1', 'erase'),
      stroke('redo-only', 'add'),
    ], 2)

    const gateRecord = createMaskGateRecord({
      sample: sample(),
      datasetId: 'mask-failure-2026-08',
      sourceEvidence: {
        revision: editSession.baseRevision,
        confidence: 0.82,
      },
      session: editSession,
      confirmedRevision: 'manual:confirmed:2',
      correctionStartedAt: 1_000,
      correctionEndedAt: 13_000,
      beforeGenerationId: 'before-2',
      afterGenerationId: 'after-2',
      initialSubjectAcceptable: false,
      subjectAcceptable: true,
      patternPreference: 'after',
      deviceClass: 'mobile',
      outcome: 'confirmed',
      baseMaskValues: Float32Array.from([0, 0, 1, 1]),
      correctedMaskValues: Float32Array.from([0, 1, 1, 1]),
    })

    assert.equal(gateRecord.correctionDurationMs, 12_000)
    assert.equal(gateRecord.strokeCount, 2)
    assert.equal(gateRecord.addStrokeCount, 1)
    assert.equal(gateRecord.eraseStrokeCount, 1)
    assert.equal(gateRecord.correctionAreaRatio, 0.25)
    assert.equal(gateRecord.session.strokes.length, 3)
    assert.equal(gateRecord.deviceClass, 'mobile')
  })

  it('records cancellation without fabricated confirmation artifacts', () => {
    const gateRecord = createMaskGateRecord({
      sample: sample(),
      datasetId: 'mask-failure-2026-08',
      sourceEvidence: { revision: 'source-1', confidence: 0.8 },
      session: {
        ...session([]),
        baseRevision: 'source-1',
      },
      correctionStartedAt: 1_000,
      correctionEndedAt: 4_000,
      beforeGenerationId: 'before-cancel',
      initialSubjectAcceptable: false,
      subjectAcceptable: false,
      patternPreference: 'unrated',
      deviceClass: 'mobile',
      outcome: 'cancelled',
      baseMaskValues: Float32Array.from([0, 1]),
      correctedMaskValues: Float32Array.from([0, 1]),
    })

    assert.equal(gateRecord.outcome, 'cancelled')
    assert.equal('confirmedRevision' in gateRecord, false)
    assert.equal('afterGenerationId' in gateRecord, false)
  })

  it('rejects success fields on cancelled attempts', () => {
    assert.throws(() => createMaskGateRecord({
      sample: sample(),
      datasetId: 'mask-failure-2026-08',
      sourceEvidence: { revision: 'source-1', confidence: 0.8 },
      session: { ...session([]), baseRevision: 'source-1' },
      confirmedRevision: 'fabricated-confirmation',
      correctionStartedAt: 1_000,
      correctionEndedAt: 4_000,
      beforeGenerationId: 'before-cancel',
      afterGenerationId: 'fabricated-after',
      initialSubjectAcceptable: false,
      subjectAcceptable: true,
      patternPreference: 'after',
      deviceClass: 'mobile',
      outcome: 'cancelled',
      baseMaskValues: Float32Array.from([0, 1]),
      correctedMaskValues: Float32Array.from([0, 1]),
    }), /cancelled|outcome/i)
  })
})

describe('BiRefNet sidecars', () => {
  it('fits large sources inside both side and pixel limits while preserving aspect ratio', () => {
    assert.deepEqual(fitMaskGateSourceDimensions(2048, 2048), { width: 2000, height: 2000 })
    assert.deepEqual(fitMaskGateSourceDimensions(4000, 2000), { width: 2048, height: 1024 })
    assert.throws(() => fitMaskGateSourceDimensions(10000, 2), /aspect ratio/i)
  })

  it('writes a normalized source, compact mask, and traceable analysis metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mask-gate-'))
    try {
      const imagePath = join(directory, 'portrait.png')
      await sharp(Buffer.from([
        220, 20, 20, 255,
        20, 220, 20, 255,
      ]), { raw: { width: 2, height: 1, channels: 4 } }).png().toFile(imagePath)
      const manifestPath = join(directory, 'manifest.json')
      await writeFile(manifestPath, JSON.stringify({
        schemaVersion: 1,
        datasetId: 'sidecar-test',
        samples: [sample({ imagePath: 'portrait.png' })],
      }))
      const provider = {
        async segment({ image }) {
          const mask = {
            width: image.width,
            height: image.height,
            values: Float32Array.from([0.25, 0.75]),
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

      const outputDirectory = join(directory, 'output')
      const index = await generateMaskGateSidecars({
        manifestPath,
        outputDirectory,
        provider,
        gatewayCommit: 'test-commit',
      })

      assert.equal(index.samples.length, 1)
      assert.equal(index.samples[0].sourceMetadata.permission, 'owned')
      const sidecarPath = join(outputDirectory, 'portrait-01.analysis.json')
      const loaded = await loadMaskGateSidecar(sidecarPath)
      assert.equal(loaded.metadata.imageId, 'portrait-01')
      assert.equal(loaded.metadata.generator.gatewayCommit, 'test-commit')
      assert.match(loaded.metadata.source.sha256, /^[a-f0-9]{64}$/)
      assert.match(loaded.metadata.mask.sha256, /^[a-f0-9]{64}$/)
      assert.deepEqual(
        [...loaded.mask.values].map((value) => Math.round(value * 255)),
        [64, 191],
      )
      assert.ok((await readFile(join(outputDirectory, 'portrait-01.source.png'))).length > 0)
      assert.ok((await readFile(join(outputDirectory, 'index.json'))).length > 0)
      await assert.rejects(() => generateMaskGateSidecars({
        manifestPath,
        outputDirectory,
        provider,
      }), /already exists/i)

      const tampered = JSON.parse(await readFile(sidecarPath, 'utf8'))
      tampered.mask.numericFingerprint = '0000000000000000'
      await writeFile(sidecarPath, JSON.stringify(tampered))
      await assert.rejects(() => loadMaskGateSidecar(sidecarPath), /fingerprint|revision/i)
      tampered.mask.numericFingerprint = loaded.metadata.mask.numericFingerprint
      await writeFile(sidecarPath, JSON.stringify(tampered))

      const collected = await collectMaskGateRecord({
        sample: sample({ imagePath: 'portrait.png' }),
        datasetId: 'sidecar-test',
        sidecarPath,
        attempt: {
          outcome: 'confirmed',
          correctionStartedAt: 1_000,
          correctionEndedAt: 9_000,
          beforeGenerationId: 'before-sidecar',
          afterGenerationId: 'after-sidecar',
          initialSubjectAcceptable: false,
          subjectAcceptable: true,
          patternPreference: 'after',
          deviceClass: 'desktop',
          session: {
            ...session([{
              id: 'erase-right',
              mode: 'erase',
              radiusNormalized: 0.3,
              points: [{ x: 0.75, y: 0.5 }],
            }]),
            baseRevision: loaded.metadata.evidence.revision,
          },
        },
      })
      assert.match(
        collected.sourceRevision,
        /^sidecar:rembg-http:birefnet-general-lite:test-mask:u8:[a-f0-9]{16}$/,
      )
      assert.equal(collected.strokeCount, 1)
      assert.ok(collected.correctionAreaRatio > 0)
      assert.equal(collected.outcome, 'confirmed')
      await assert.rejects(() => collectMaskGateRecord({
        sample: sample({ imagePath: 'portrait.png' }),
        datasetId: 'another-dataset',
        sidecarPath,
        attempt: {
          outcome: 'cancelled',
          correctionStartedAt: 1_000,
          correctionEndedAt: 2_000,
          beforeGenerationId: 'before-mismatch',
          initialSubjectAcceptable: false,
          subjectAcceptable: false,
          patternPreference: 'unrated',
          deviceClass: 'desktop',
          session: { ...session([]), baseRevision: loaded.metadata.evidence.revision },
        },
      }), /datasetId/i)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('applies EXIF orientation before choosing normalized source dimensions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mask-gate-orientation-'))
    try {
      const imagePath = join(directory, 'rotated.jpg')
      await sharp(Buffer.from([
        240, 20, 20,
        20, 20, 240,
      ]), { raw: { width: 2, height: 1, channels: 3 } })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toFile(imagePath)
      const manifestPath = join(directory, 'manifest.json')
      await writeFile(manifestPath, JSON.stringify({
        schemaVersion: 1,
        datasetId: 'orientation-test',
        samples: [sample({ imagePath: 'rotated.jpg' })],
      }))
      const provider = {
        async segment({ image }) {
          assert.equal(image.width, 1)
          assert.equal(image.height, 2)
          const mask = { width: 1, height: 2, values: Float32Array.from([0, 1]) }
          return {
            provider: 'rembg-http',
            model: 'birefnet-general-lite',
            elapsedMs: 1,
            analysis: {
              subjectMaskEvidence: {
                mask,
                confidence: 0.9,
                source: 'ai',
                revision: 'orientation-mask',
              },
            },
          }
        },
      }

      await generateMaskGateSidecars({
        manifestPath,
        outputDirectory: join(directory, 'output'),
        provider,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('mask failure report', () => {
  it('passes the product gate when failure cases meet every threshold', () => {
    const records = [
      record({ imageId: 'one', correctionDurationMs: 8_000, correctionEndedAt: 9_000, strokeCount: 3 }),
      record({ imageId: 'two', correctionDurationMs: 10_000, correctionEndedAt: 11_000, strokeCount: 4 }),
      record({ imageId: 'three', correctionDurationMs: 12_000, correctionEndedAt: 13_000, strokeCount: 5 }),
      record({ imageId: 'four', correctionDurationMs: 20_000, correctionEndedAt: 21_000, strokeCount: 6 }),
      record({
        imageId: 'control',
        cohort: 'control',
        initialSubjectAcceptable: true,
        correctionDurationMs: 0,
        correctionStartedAt: 1_000,
        correctionEndedAt: 1_000,
        strokeCount: 0,
        addStrokeCount: 0,
        eraseStrokeCount: 0,
        patternPreference: 'tie',
      }),
    ]

    const summary = summarizeMaskGate(records, {
      ...defaultGateThresholds,
      minimumTotalSamples: 5,
      minimumMobileSamples: 0,
      minimumCategoryCounts: {
        portrait: 4,
        pet: 0,
        'illustration-object': 0,
        'control-extreme': 0,
      },
      requireManifest: false,
    })

    assert.equal(summary.failureSampleCount, 4)
    assert.equal(summary.acceptableWithin30SecondsRate, 1)
    assert.equal(summary.p50CorrectionTimeMs, 11_000)
    assert.equal(summary.p90CorrectionTimeMs, 20_000)
    assert.equal(summary.medianStrokeCount, 4.5)
    assert.equal(summary.afterPreferenceRate, 1)
    assert.equal(summary.passed, true)
  })

  it('shows the failed criterion in the Markdown report', () => {
    const summary = summarizeMaskGate([
      record({
        correctionDurationMs: 35_000,
        correctionEndedAt: 36_000,
        subjectAcceptable: false,
        patternPreference: 'before',
      }),
    ], defaultGateThresholds)

    const markdown = renderMaskGateReport(summary)

    assert.equal(summary.passed, false)
    assert.match(markdown, /Mask Failure Gate/)
    assert.match(markdown, /FAIL/)
    assert.match(markdown, /30 s/)
    assert.match(markdown, /Sample coverage/)
  })

  it('keeps cancelled failure attempts in the gate denominator', () => {
    const summary = summarizeMaskGate([
      record({ imageId: 'confirmed' }),
      record({
        imageId: 'cancelled',
        outcome: 'cancelled',
        subjectAcceptable: false,
        patternPreference: 'unrated',
        confirmedRevision: undefined,
        afterGenerationId: undefined,
      }),
    ])

    assert.equal(summary.failureSampleCount, 2)
    assert.equal(summary.cancelledAttemptCount, 1)
    assert.equal(summary.acceptableWithin30SecondsRate, 0.5)
    assert.equal(summary.afterPreferenceRate, 0.5)
    assert.equal(summary.passed, false)
  })

  it('rejects duplicate sample records that would bias the gate', () => {
    assert.throws(
      () => summarizeMaskGate([record(), record()]),
      /duplicate.*imageId/i,
    )
  })

  it('requires the production sample and mobile coverage before passing', () => {
    const summary = summarizeMaskGate([record({ deviceClass: 'desktop' })])

    assert.equal(summary.criteria.sampleCoverage, false)
    assert.equal(summary.criteria.mobileCoverage, false)
    assert.equal(summary.passed, false)
  })

  it('rejects records whose manifest identity differs', () => {
    const manifest = validateMaskGateManifest({
      schemaVersion: 1,
      datasetId: 'another-dataset',
      samples: [sample()],
    })

    assert.throws(
      () => summarizeMaskGate([record()], {
        ...defaultGateThresholds,
        minimumTotalSamples: 1,
        minimumMobileSamples: 0,
        minimumCategoryCounts: {
          portrait: 1,
          pet: 0,
          'illustration-object': 0,
          'control-extreme': 0,
        },
      }, manifest),
      /datasetId/i,
    )
  })
})
