import { createHash } from 'node:crypto'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { confirmMaskEditSession } from '@ai-bead-pattern/pattern-core'

import { collectMaskGateRecord } from './collect.mjs'
import { loadMaskGateManifest } from './manifest.mjs'
import { createBlindComparison } from './protocol.mjs'
import {
  renderCategoryBreakdownCsv,
  renderControlPreservationCsv,
  renderDeviceBreakdownCsv,
  renderFailureTagBreakdownCsv,
} from './report-exports.mjs'
import { renderMaskGateReport, summarizeMaskGate } from './report.mjs'
import { loadMaskGateSidecar } from './sidecar.mjs'

const pilotOutcomes = ['accepted', 'confirmed', 'confirmed', 'cancelled', 'error']

const desktopDevice = Object.freeze({
  class: 'desktop',
  inputModality: 'mouse',
  viewportWidth: 1_440,
  viewportHeight: 900,
  devicePixelRatio: 1,
  maxTouchPoints: 0,
  platform: 'protocol-fixture',
})

const mobileDevice = Object.freeze({
  class: 'mobile',
  inputModality: 'touch',
  viewportWidth: 390,
  viewportHeight: 844,
  devicePixelRatio: 3,
  maxTouchPoints: 5,
  platform: 'protocol-fixture',
})

function choose(samples, predicate, excluded = new Set(), preferMobile = false) {
  const candidates = samples
    .filter((sample) => excluded.has(sample.imageId) === false && predicate(sample))
    .toSorted((first, second) => {
      if (preferMobile && Boolean(first.targetMobile) !== Boolean(second.targetMobile)) {
        return first.targetMobile ? -1 : 1
      }
      if (preferMobile === false && Boolean(first.targetMobile) !== Boolean(second.targetMobile)) {
        return first.targetMobile ? 1 : -1
      }
      return first.imageId.localeCompare(second.imageId)
    })
  return candidates[0]
}

function required(sample, description) {
  if (sample === undefined) throw new RangeError(`Pilot requires ${description}`)
  return sample
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function snapshot(metadata, variant) {
  const identity = {
    protocolVersion: metadata.protocolVersion,
    datasetId: metadata.datasetId,
    manifestFingerprint: metadata.manifestFingerprint,
    imageId: metadata.imageId,
    sampleOrder: metadata.sampleOrder,
    modelConfigurationId: metadata.modelConfigurationId,
    evidenceRevision: metadata.evidence?.revision,
    variant,
  }
  const patternHash = fingerprint({ ...identity, artifact: 'pattern' })
  return {
    generationId: `pilot-${variant}-${patternHash.slice(0, 16)}`,
    candidateId: `pilot-${variant}`,
    patternHash,
    optionsHash: fingerprint({ ...identity, artifact: 'options', canvas: 48, colors: 12 }),
    width: 48,
    height: 48,
    colorCount: 12,
    totalBeads: 1_536,
  }
}

function session(revision, outcome) {
  const strokes = [{
    id: 'pilot-add',
    mode: 'add',
    radiusNormalized: 0.018,
    points: [{ x: 0.48, y: 0.45 }, { x: 0.52, y: 0.45 }],
  }]
  if (outcome === 'confirmed') {
    strokes.push({
      id: 'pilot-erase',
      mode: 'erase',
      radiusNormalized: 0.012,
      points: [{ x: 0.22, y: 0.2 }],
    })
  }
  return { baseRevision: revision, strokes, cursor: strokes.length }
}

function identity(metadata, entry) {
  if (metadata?.imageId !== entry.imageId) {
    throw new RangeError('Pilot entry imageId must match Sidecar metadata')
  }
  return {
    protocolVersion: metadata.protocolVersion,
    attemptId: `pilot:${metadata.datasetId}:${metadata.imageId}`,
    datasetId: metadata.datasetId,
    manifestFingerprint: metadata.manifestFingerprint,
    imageId: metadata.imageId,
    raterId: 'pilot-fixture-editor',
    sampleOrder: metadata.sampleOrder,
    sampleOrderSeed: metadata.sampleOrderSeed,
    coreCommit: metadata.commits?.core,
    demoCommit: metadata.commits?.demo,
    gatewayCommit: metadata.commits?.gateway,
    modelConfigurationId: metadata.modelConfigurationId,
  }
}

export async function createMaskGatePilotAttempt({
  entry,
  metadata,
  fixtureEpochMs = 1_700_000_000_000,
}) {
  if (Number.isFinite(fixtureEpochMs) === false) {
    throw new TypeError('Pilot fixture epoch must be finite')
  }
  const recordIdentity = identity(metadata, entry)
  const initialRatingAt = fixtureEpochMs + metadata.sampleOrder * 100_000
  const base = {
    ...recordIdentity,
    initialRatingAt,
    initialSubjectAcceptable: entry.outcome === 'accepted',
    outcome: entry.outcome,
    beforeSnapshot: snapshot(metadata, 'before'),
    device: { ...entry.device },
  }

  if (entry.outcome === 'accepted') {
    return { ...base, outcomeAt: initialRatingAt + 1_000 }
  }
  if (entry.outcome === 'error') {
    return {
      ...base,
      outcomeAt: initialRatingAt + 1_500,
      error: {
        code: 'pilot-fixture-error',
        message: 'Deterministic protocol fixture for the error terminal state',
      },
    }
  }

  const correctionStartedAt = initialRatingAt + 500
  const correctionDurationMs = entry.outcome === 'confirmed' ? 12_000 : 18_000
  const correctionEndedAt = correctionStartedAt + correctionDurationMs
  const attempt = {
    ...base,
    correctionStartedAt,
    correctionEndedAt,
    outcomeAt: correctionEndedAt,
    session: session(metadata.evidence?.revision, entry.outcome),
  }
  if (entry.outcome === 'cancelled') return attempt

  const blindComparison = await createBlindComparison({
    protocolVersion: metadata.protocolVersion,
    datasetId: metadata.datasetId,
    imageId: metadata.imageId,
    raterId: recordIdentity.raterId,
  })
  return {
    ...attempt,
    afterSnapshot: snapshot(metadata, 'after'),
    subjectAcceptable: true,
    blindComparison: {
      ...blindComparison,
      choice: blindComparison.leftVariant === 'after' ? 'left' : 'right',
    },
    ratedAt: correctionEndedAt + 1_000,
  }
}

export function createMaskGatePilotPlan({ samples }) {
  if (Array.isArray(samples) === false) throw new TypeError('Pilot samples must be an array')
  const selected = []
  const used = new Set()
  const add = (sample, description) => {
    const value = required(sample, description)
    selected.push(value)
    used.add(value.imageId)
  }

  add(choose(samples, (sample) => sample.category === 'portrait'
    && sample.cohort === 'clean-control', used), 'one portrait clean control')
  add(choose(samples, (sample) => sample.category === 'portrait'
    && sample.cohort === 'targeted-failure', used, true), 'one portrait targeted failure')
  add(choose(samples, (sample) => sample.category === 'pet'
    && sample.cohort === 'targeted-failure', used, true), 'two pet targeted failures')
  add(choose(samples, (sample) => sample.category === 'pet'
    && sample.cohort === 'targeted-failure', used), 'two pet targeted failures')
  add(choose(samples, (sample) => (sample.category === 'object'
      || sample.category === 'illustration')
    && sample.cohort === 'targeted-failure', used), 'one object or illustration targeted failure')

  return selected.map((sample, index) => ({
    imageId: sample.imageId,
    category: sample.category,
    cohort: sample.cohort,
    outcome: pilotOutcomes[index],
    protocolFixture: true,
    device: index === 1 || index === 2 ? { ...mobileDevice } : { ...desktopDevice },
  }))
}

export function validateMaskGatePilotResult({
  plan,
  interactionCount,
  preferenceCount,
  replayedConfirmedCount,
  files,
}) {
  if (Array.isArray(plan) === false || plan.length !== 5) {
    throw new RangeError('Pilot plan must contain five samples')
  }
  const outcomes = plan.map((entry) => entry.outcome)
  if (pilotOutcomes.some((outcome, index) => outcomes[index] !== outcome)) {
    throw new RangeError('Pilot outcomes must cover accepted, confirmed, cancelled, and error')
  }
  const categoryCount = (category) => plan.filter((entry) => entry.category === category).length
  if (categoryCount('portrait') !== 2 || categoryCount('pet') !== 2
    || categoryCount('object') + categoryCount('illustration') !== 1) {
    throw new RangeError('Pilot categories must contain two portraits, two pets, and one object or illustration')
  }
  const mobileCount = plan.filter((entry) => entry.device?.class === 'mobile'
    && entry.device?.inputModality === 'touch').length
  if (mobileCount !== 2) throw new RangeError('Pilot must contain two mobile touch protocol fixtures')
  if (interactionCount !== 5 || preferenceCount !== 2 || replayedConfirmedCount !== 2) {
    throw new RangeError('Pilot evidence counts are incomplete')
  }
  const requiredFiles = [
    files?.records,
    files?.preferences,
    files?.report,
    files?.summary,
    files?.replay,
    ...(files?.diagnostics ?? []),
  ]
  if (requiredFiles.length !== 9
    || requiredFiles.some((path) => typeof path !== 'string' || path.length === 0)) {
    throw new RangeError('Pilot file inventory is incomplete')
  }
  return {
    complete: true,
    protocolFixture: true,
    interactionCount,
    preferenceCount,
    replayedConfirmedCount,
    files,
  }
}

function pilotThresholds(plan) {
  const categories = Object.fromEntries(
    ['portrait', 'pet', 'illustration', 'object'].map((category) => [
      category,
      plan.filter((entry) => entry.category === category).length,
    ]),
  )
  return {
    minimumTotalSamples: 5,
    minimumMobileSamples: 2,
    minimumInitialFailureSamples: 4,
    targetInitialFailureSamples: 4,
    minimumCategoryCounts: categories,
    minimumCohortCounts: { 'targeted-failure': 4, 'clean-control': 1, extreme: 0 },
    minimumMobileCategoryCounts: { portrait: 1, pet: 1, illustration: 0, object: 0 },
    requireManifest: false,
    acceptableWithin30SecondsRate: 0.5,
    p50CorrectionTimeMs: 15_000,
    p90CorrectionTimeMs: 30_000,
    medianStrokeCount: 6,
    afterPreferenceRate: 0.75,
    controlPreservationRate: 0.9,
    minimumPreferenceRatingsPerConfirmedSample: 1,
  }
}

function jsonLines(records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

function sourceEvidence(sidecar) {
  return {
    mask: sidecar.mask,
    confidence: sidecar.metadata.evidence.confidence,
    source: sidecar.metadata.evidence.source,
    revision: sidecar.metadata.evidence.revision,
    ...(sidecar.metadata.evidence.userConfirmed === undefined
      ? {}
      : { userConfirmed: sidecar.metadata.evidence.userConfirmed }),
    ...(sidecar.metadata.evidence.provenance === undefined
      ? {}
      : { provenance: sidecar.metadata.evidence.provenance }),
  }
}

async function replayConfirmedInteractions(interactions, sidecarDirectory) {
  const results = []
  for (const interaction of interactions.filter((record) => record.outcome === 'confirmed')) {
    const sidecar = await loadMaskGateSidecar(
      join(sidecarDirectory, `${interaction.imageId}.analysis.json`),
    )
    const replayed = confirmMaskEditSession(sourceEvidence(sidecar), interaction.session)
    if (replayed.revision !== interaction.confirmedRevision) {
      throw new RangeError(`Pilot replay revision differs for ${interaction.imageId}`)
    }
    results.push({
      imageId: interaction.imageId,
      confirmedRevision: interaction.confirmedRevision,
      replayedRevision: replayed.revision,
      matches: true,
    })
  }
  return results
}

function pilotReport(summary) {
  return '# Mask Gate V2 Pilot Protocol Fixture\n\n'
    + 'This fixture verifies terminal outcomes, A/B assignment, collection, replay, and report exports with deterministic timestamps and device labels. Real participant observations are collected separately.\n\n'
    + renderMaskGateReport(summary)
      .replace('# Mask Failure Gate V2\n\n', '## Pilot Metrics\n\n')
      .replace('real mobile trials', 'mobile protocol fixtures')
      .replace('| Real mobile coverage |', '| Mobile fixture coverage |')
}

export async function runMaskGatePilot({
  manifestPath,
  sidecarDirectory,
  outputDirectory,
  fixtureEpochMs = 1_700_000_000_000,
}) {
  const targetDirectory = resolve(outputDirectory)
  try {
    await stat(targetDirectory)
    throw new RangeError(`Pilot output directory already exists: ${targetDirectory}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const manifest = await loadMaskGateManifest(manifestPath)
  const plan = createMaskGatePilotPlan(manifest)
  const stagingDirectory = `${targetDirectory}.staging-${process.pid}-${Date.now()}`
  await mkdir(join(stagingDirectory, 'attempts'), { recursive: true })

  try {
    const interactions = []
    const preferences = []
    for (const entry of plan) {
      const sidecarPath = join(sidecarDirectory, `${entry.imageId}.analysis.json`)
      const sidecar = await loadMaskGateSidecar(sidecarPath)
      const attempt = await createMaskGatePilotAttempt({ entry, metadata: sidecar.metadata, fixtureEpochMs })
      await writeFile(
        join(stagingDirectory, 'attempts', `${entry.imageId}.attempt.json`),
        `${JSON.stringify(attempt, null, 2)}\n`,
      )
      const sample = manifest.samples.find((candidate) => candidate.imageId === entry.imageId)
      const collected = await collectMaskGateRecord({ sample, sidecarPath, attempt })
      interactions.push(collected.interaction)
      if (collected.preference !== undefined) preferences.push(collected.preference)
    }

    const replay = await replayConfirmedInteractions(interactions, sidecarDirectory)
    const summary = {
      ...summarizeMaskGate(interactions, preferences, pilotThresholds(plan)),
      evaluationKind: 'protocol-fixture',
      fixtureEpochMs,
    }
    const diagnostics = [
      'category-breakdown.csv',
      'failure-tag-breakdown.csv',
      'device-breakdown.csv',
      'control-preservation.csv',
    ]
    const files = {
      records: 'records.jsonl',
      preferences: 'preferences.jsonl',
      report: 'report.md',
      summary: 'summary.json',
      replay: 'replay.json',
      diagnostics,
    }
    const result = validateMaskGatePilotResult({
      plan,
      interactionCount: interactions.length,
      preferenceCount: preferences.length,
      replayedConfirmedCount: replay.length,
      files,
    })

    await Promise.all([
      writeFile(join(stagingDirectory, 'records.jsonl'), jsonLines(interactions)),
      writeFile(join(stagingDirectory, 'preferences.jsonl'), jsonLines(preferences)),
      writeFile(join(stagingDirectory, 'report.md'), pilotReport(summary)),
      writeFile(join(stagingDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`),
      writeFile(join(stagingDirectory, 'replay.json'), `${JSON.stringify(replay, null, 2)}\n`),
      writeFile(join(stagingDirectory, diagnostics[0]), renderCategoryBreakdownCsv(interactions)),
      writeFile(join(stagingDirectory, diagnostics[1]), renderFailureTagBreakdownCsv(interactions)),
      writeFile(join(stagingDirectory, diagnostics[2]), renderDeviceBreakdownCsv(interactions)),
      writeFile(join(stagingDirectory, diagnostics[3]), renderControlPreservationCsv(interactions)),
      writeFile(join(stagingDirectory, 'pilot.json'), `${JSON.stringify({ ...result, plan }, null, 2)}\n`),
    ])
    await rename(stagingDirectory, targetDirectory)
    return { ...result, plan, summary, replay }
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true })
    throw error
  }
}
