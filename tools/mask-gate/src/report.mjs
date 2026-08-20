import { readFile } from 'node:fs/promises'

import { fingerprintMaskGateManifest } from './manifest.mjs'
import {
  validateMaskGateInteractionRecord,
  validateMaskGatePreferenceRecord,
} from './record.mjs'
import { wilsonInterval } from './statistics.mjs'

export const defaultGateThresholds = Object.freeze({
  minimumTotalSamples: 40,
  minimumMobileSamples: 8,
  minimumInitialFailureSamples: 24,
  targetInitialFailureSamples: 32,
  minimumCategoryCounts: Object.freeze({
    portrait: 12,
    pet: 12,
    illustration: 8,
    object: 8,
  }),
  minimumCohortCounts: Object.freeze({
    'targeted-failure': 32,
    'clean-control': 4,
    extreme: 4,
  }),
  minimumMobileCategoryCounts: Object.freeze({
    portrait: 2,
    pet: 2,
    illustration: 2,
    object: 2,
  }),
  requireManifest: true,
  acceptableWithin30SecondsRate: 0.8,
  p50CorrectionTimeMs: 15_000,
  p90CorrectionTimeMs: 30_000,
  medianStrokeCount: 6,
  afterPreferenceRate: 0.75,
  controlPreservationRate: 0.9,
  minimumPreferenceRatingsPerConfirmedSample: 1,
})

function median(values) {
  if (values.length === 0) return null
  const sorted = values.toSorted((first, second) => first - second)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function nearestRank(values, percentile) {
  if (values.length === 0) return null
  const sorted = values.toSorted((first, second) => first - second)
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]
}

function rate(count, total) {
  return total === 0 ? null : count / total
}

function passesMaximum(value, threshold) {
  return value !== null && value <= threshold
}

function passesMinimum(value, threshold) {
  return value !== null && value >= threshold
}

function uniqueBy(values, key, label) {
  const ids = new Set()
  for (const value of values) {
    if (ids.has(value[key])) throw new RangeError(`Duplicate ${key} in ${label}: ${value[key]}`)
    ids.add(value[key])
  }
  return ids
}

function sameStrings(first, second) {
  return first.length === second.length
    && first.toSorted().every((value, index) => value === second.toSorted()[index])
}

function validateAgainstManifest(interactions, manifest) {
  const imageIds = new Set(interactions.map((record) => record.imageId))
  const fingerprint = fingerprintMaskGateManifest(manifest)
  for (const record of interactions) {
    if (record.datasetId !== manifest.datasetId) {
      throw new RangeError(`Record ${record.imageId} datasetId differs from the manifest`)
    }
    if (record.manifestFingerprint !== fingerprint) {
      throw new RangeError(`Record ${record.imageId} manifest fingerprint differs`)
    }
    const sample = manifest.samples.find((entry) => entry.imageId === record.imageId)
    if (sample === undefined) throw new RangeError(`Record ${record.imageId} is absent from the manifest`)
    if (record.category !== sample.category || record.cohort !== sample.cohort
      || sameStrings(record.failureTags, sample.failureTags) === false) {
      throw new RangeError(`Record ${record.imageId} metadata differs from the manifest`)
    }
  }
  return interactions.length === manifest.samples.length
    && manifest.samples.every((sample) => imageIds.has(sample.imageId))
}

function validatePreferences(interactions, preferences) {
  const interactionsByImage = new Map(interactions.map((record) => [record.imageId, record]))
  uniqueBy(preferences, 'preferenceId', 'mask gate preferences')
  for (const preference of preferences) {
    const interaction = interactionsByImage.get(preference.imageId)
    if (interaction === undefined || interaction.outcome !== 'confirmed') {
      throw new RangeError(`Preference ${preference.preferenceId} lacks a confirmed interaction`)
    }
    if (preference.datasetId !== interaction.datasetId
      || preference.manifestFingerprint !== interaction.manifestFingerprint) {
      throw new RangeError(`Preference ${preference.preferenceId} identity differs from its interaction`)
    }
    for (const variant of ['beforeSnapshot', 'afterSnapshot']) {
      if (preference[variant].generationId !== interaction[variant].generationId
        || preference[variant].candidateId !== interaction[variant].candidateId
        || preference[variant].patternHash !== interaction[variant].patternHash
        || preference[variant].optionsHash !== interaction[variant].optionsHash) {
        throw new RangeError(`Preference ${preference.preferenceId} snapshot differs from its interaction`)
      }
    }
  }
}

function countsBy(values, key, expectedKeys) {
  return Object.fromEntries(expectedKeys.map((item) => [
    item,
    values.filter((value) => value[key] === item).length,
  ]))
}

function coverage(counts, minimums) {
  return Object.entries(minimums)
    .every(([key, minimum]) => (counts[key] ?? 0) >= minimum)
}

export function summarizeMaskGate(
  inputInteractions,
  inputPreferences = [],
  thresholds = defaultGateThresholds,
  manifest,
) {
  const interactions = inputInteractions.map(validateMaskGateInteractionRecord)
  const preferences = inputPreferences.map(validateMaskGatePreferenceRecord)
  uniqueBy(interactions, 'imageId', 'mask gate interactions')
  validatePreferences(interactions, preferences)

  const manifestCoverage = manifest === undefined
    ? thresholds.requireManifest === false
    : validateAgainstManifest(interactions, manifest)
  const initialFailures = interactions.filter((record) => record.initialSubjectAcceptable === false)
  const resolvedFailures = initialFailures.filter((record) =>
    record.outcome === 'confirmed' && record.subjectAcceptable === true)
  const solvedWithin30Seconds = resolvedFailures.filter((record) =>
    record.correctionDurationMs <= 30_000)
  const cleanControls = interactions.filter((record) => record.cohort === 'clean-control')
  const preservedControls = cleanControls.filter((record) =>
    record.initialSubjectAcceptable && record.outcome === 'accepted')
  const confirmedImageIds = new Set(
    interactions.filter((record) => record.outcome === 'confirmed').map((record) => record.imageId),
  )
  const afterPreferences = preferences.filter((record) => record.patternPreference === 'after')
  const realMobile = interactions.filter((record) => record.device.class === 'mobile'
    && (record.device.inputModality === 'touch' || record.device.inputModality === 'pen'))
  const categoryKeys = Object.keys(thresholds.minimumCategoryCounts)
  const cohortKeys = Object.keys(thresholds.minimumCohortCounts)
  const categoryCounts = countsBy(interactions, 'category', categoryKeys)
  const cohortCounts = countsBy(interactions, 'cohort', cohortKeys)
  const mobileCategoryCounts = countsBy(realMobile, 'category', categoryKeys)
  const durations = resolvedFailures.map((record) => record.correctionDurationMs)
  const strokes = resolvedFailures.map((record) => record.strokeCount)
  const correctionAreas = resolvedFailures.map((record) => record.correctionAreaRatio)
  const addStrokeCount = resolvedFailures.reduce((sum, record) => sum + record.addStrokeCount, 0)
  const eraseStrokeCount = resolvedFailures.reduce((sum, record) => sum + record.eraseStrokeCount, 0)
  const totalResolvedStrokes = addStrokeCount + eraseStrokeCount
  const preferenceCountsByImage = new Map()
  for (const preference of preferences) {
    preferenceCountsByImage.set(
      preference.imageId,
      (preferenceCountsByImage.get(preference.imageId) ?? 0) + 1,
    )
  }

  const acceptableWithin30SecondsRate = rate(
    solvedWithin30Seconds.length,
    initialFailures.length,
  )
  const afterPreferenceRate = rate(afterPreferences.length, preferences.length)
  const controlPreservationRate = rate(preservedControls.length, cleanControls.length)
  const preferenceCoverage = [...confirmedImageIds].every((imageId) =>
    (preferenceCountsByImage.get(imageId) ?? 0)
      >= thresholds.minimumPreferenceRatingsPerConfirmedSample)
  const criteria = {
    sampleCoverage: interactions.length >= thresholds.minimumTotalSamples
      && manifestCoverage
      && coverage(categoryCounts, thresholds.minimumCategoryCounts)
      && coverage(cohortCounts, thresholds.minimumCohortCounts),
    mobileCoverage: realMobile.length >= thresholds.minimumMobileSamples
      && coverage(mobileCategoryCounts, thresholds.minimumMobileCategoryCounts),
    initialFailureCoverage: initialFailures.length >= thresholds.minimumInitialFailureSamples,
    preferenceCoverage,
    acceptableWithin30Seconds: passesMinimum(
      acceptableWithin30SecondsRate,
      thresholds.acceptableWithin30SecondsRate,
    ),
    p50CorrectionTime: passesMaximum(median(durations), thresholds.p50CorrectionTimeMs),
    p90CorrectionTime: passesMaximum(
      nearestRank(durations, 0.9),
      thresholds.p90CorrectionTimeMs,
    ),
    medianStrokeCount: passesMaximum(median(strokes), thresholds.medianStrokeCount),
    afterPreference: passesMinimum(afterPreferenceRate, thresholds.afterPreferenceRate),
    controlPreservation: passesMinimum(
      controlPreservationRate,
      thresholds.controlPreservationRate,
    ),
  }

  return {
    schemaVersion: 2,
    interactionCount: interactions.length,
    preferenceCount: preferences.length,
    initialFailureSampleCount: initialFailures.length,
    resolvedFailureSampleCount: resolvedFailures.length,
    cleanControlSampleCount: cleanControls.length,
    mobileSampleCount: realMobile.length,
    acceptedAttemptCount: interactions.filter((record) => record.outcome === 'accepted').length,
    confirmedAttemptCount: interactions.filter((record) => record.outcome === 'confirmed').length,
    cancelledAttemptCount: interactions.filter((record) => record.outcome === 'cancelled').length,
    errorAttemptCount: interactions.filter((record) => record.outcome === 'error').length,
    categoryCounts,
    cohortCounts,
    mobileCategoryCounts,
    manifestCoverage,
    acceptableWithin30SecondsRate,
    p50CorrectionTimeMs: median(durations),
    p90CorrectionTimeMs: nearestRank(durations, 0.9),
    medianStrokeCount: median(strokes),
    medianCorrectionAreaRatio: median(correctionAreas),
    addStrokeRatio: rate(addStrokeCount, totalResolvedStrokes),
    eraseStrokeRatio: rate(eraseStrokeCount, totalResolvedStrokes),
    afterPreferenceRate,
    controlPreservationRate,
    intervals: {
      acceptableWithin30Seconds: wilsonInterval(
        solvedWithin30Seconds.length,
        initialFailures.length,
      ),
      afterPreference: wilsonInterval(afterPreferences.length, preferences.length),
      controlPreservation: wilsonInterval(preservedControls.length, cleanControls.length),
    },
    criteria,
    thresholds,
    passed: Object.values(criteria).every(Boolean),
  }
}

function percent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`
}

function interval(value) {
  return value.lower === null ? 'n/a' : `${percent(value.lower)}-${percent(value.upper)}`
}

function milliseconds(value) {
  return value === null ? 'n/a' : `${(value / 1_000).toFixed(1)} s`
}

function criterion(value) {
  return value ? 'PASS' : 'FAIL'
}

export function renderMaskGateReport(summary) {
  return `# Mask Failure Gate V2\n\n`
    + `Result: **${summary.passed ? 'PASS' : 'FAIL'}**\n\n`
    + `Interactions: ${summary.interactionCount}; preferences: ${summary.preferenceCount}; initial failures: ${summary.initialFailureSampleCount}; resolved failures: ${summary.resolvedFailureSampleCount}; real mobile trials: ${summary.mobileSampleCount}.\n\n`
    + `| Criterion | Result | Observed | 95% CI | Target |\n`
    + `| --- | --- | ---: | ---: | ---: |\n`
    + `| Sample coverage | ${criterion(summary.criteria.sampleCoverage)} | ${summary.interactionCount} | - | >= ${summary.thresholds.minimumTotalSamples} + manifest/category/cohort |\n`
    + `| Initial failure coverage | ${criterion(summary.criteria.initialFailureCoverage)} | ${summary.initialFailureSampleCount} | - | >= ${summary.thresholds.minimumInitialFailureSamples} (target ${summary.thresholds.targetInitialFailureSamples}) |\n`
    + `| Real mobile coverage | ${criterion(summary.criteria.mobileCoverage)} | ${summary.mobileSampleCount} | - | >= ${summary.thresholds.minimumMobileSamples} + category coverage |\n`
    + `| Preference coverage | ${criterion(summary.criteria.preferenceCoverage)} | ${summary.preferenceCount} | - | >= ${summary.thresholds.minimumPreferenceRatingsPerConfirmedSample} per confirmed sample |\n`
    + `| Resolved within 30 s | ${criterion(summary.criteria.acceptableWithin30Seconds)} | ${percent(summary.acceptableWithin30SecondsRate)} | ${interval(summary.intervals.acceptableWithin30Seconds)} | >= ${percent(summary.thresholds.acceptableWithin30SecondsRate)} |\n`
    + `| P50 correction time | ${criterion(summary.criteria.p50CorrectionTime)} | ${milliseconds(summary.p50CorrectionTimeMs)} | - | <= ${milliseconds(summary.thresholds.p50CorrectionTimeMs)} |\n`
    + `| P90 correction time | ${criterion(summary.criteria.p90CorrectionTime)} | ${milliseconds(summary.p90CorrectionTimeMs)} | - | <= ${milliseconds(summary.thresholds.p90CorrectionTimeMs)} |\n`
    + `| Median strokes | ${criterion(summary.criteria.medianStrokeCount)} | ${summary.medianStrokeCount ?? 'n/a'} | - | <= ${summary.thresholds.medianStrokeCount} |\n`
    + `| After-pattern preference | ${criterion(summary.criteria.afterPreference)} | ${percent(summary.afterPreferenceRate)} | ${interval(summary.intervals.afterPreference)} | >= ${percent(summary.thresholds.afterPreferenceRate)} |\n`
    + `| Control preservation | ${criterion(summary.criteria.controlPreservation)} | ${percent(summary.controlPreservationRate)} | ${interval(summary.intervals.controlPreservation)} | >= ${percent(summary.thresholds.controlPreservationRate)} |\n`
}

async function loadRecords(path, validator, label) {
  const source = await readFile(path, 'utf8')
  const records = []
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue
    try {
      records.push(validator(JSON.parse(line)))
    } catch (error) {
      throw new Error(`Invalid ${label} at line ${index + 1}: ${error.message}`)
    }
  }
  if (records.length === 0) throw new RangeError(`${label} file contains zero records`)
  return records
}

export function loadMaskGateRecords(path) {
  return loadRecords(path, validateMaskGateInteractionRecord, 'mask gate interaction')
}

export function loadMaskGatePreferences(path) {
  return loadRecords(path, validateMaskGatePreferenceRecord, 'mask gate preference')
}
