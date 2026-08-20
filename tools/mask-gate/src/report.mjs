import { readFile } from 'node:fs/promises'

import { validateMaskGateRecord } from './record.mjs'

export const defaultGateThresholds = Object.freeze({
  minimumTotalSamples: 40,
  minimumMobileSamples: 8,
  minimumCategoryCounts: Object.freeze({
    portrait: 12,
    pet: 12,
    'illustration-object': 8,
    'control-extreme': 8,
  }),
  requireManifest: true,
  acceptableWithin30SecondsRate: 0.8,
  p50CorrectionTimeMs: 15_000,
  p90CorrectionTimeMs: 30_000,
  medianStrokeCount: 6,
  afterPreferenceRate: 0.75,
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

export function summarizeMaskGate(inputRecords, thresholds = defaultGateThresholds, manifest) {
  const records = inputRecords.map(validateMaskGateRecord)
  const imageIds = new Set()
  for (const record of records) {
    if (imageIds.has(record.imageId)) {
      throw new RangeError(`Duplicate imageId in mask gate records: ${record.imageId}`)
    }
    imageIds.add(record.imageId)
  }
  if (manifest !== undefined) {
    for (const record of records) {
      if (record.datasetId !== manifest.datasetId) {
        throw new RangeError(`Record ${record.imageId} datasetId differs from the manifest`)
      }
      const sample = manifest.samples.find((entry) => entry.imageId === record.imageId)
      if (sample === undefined) {
        throw new RangeError(`Record ${record.imageId} is absent from the manifest`)
      }
      if (record.category !== sample.category || record.cohort !== sample.cohort
        || record.failureType !== sample.failureType) {
        throw new RangeError(`Record ${record.imageId} metadata differs from the manifest`)
      }
    }
  }
  const failures = records.filter((record) => record.initialSubjectAcceptable === false)
  const durations = failures.map((record) => record.correctionDurationMs)
  const strokes = failures.map((record) => record.strokeCount)
  const acceptableWithin30SecondsRate = rate(
    failures.filter((record) => record.outcome === 'confirmed'
      && record.subjectAcceptable && record.correctionDurationMs <= 30_000).length,
    failures.length,
  )
  const afterPreferenceRate = rate(
    failures.filter((record) => record.outcome === 'confirmed'
      && record.patternPreference === 'after').length,
    failures.length,
  )
  const p50CorrectionTimeMs = median(durations)
  const p90CorrectionTimeMs = nearestRank(durations, 0.9)
  const medianStrokeCount = median(strokes)
  const mobile = records.filter((record) => record.deviceClass === 'mobile')
  const cancelled = records.filter((record) => record.outcome === 'cancelled')
  const errors = records.filter((record) => record.outcome === 'error')
  const categoryCounts = Object.fromEntries(
    Object.keys(thresholds.minimumCategoryCounts).map((category) => [
      category,
      records.filter((record) => record.category === category).length,
    ]),
  )
  const manifestCoverage = manifest === undefined
    ? thresholds.requireManifest === false
    : records.length === manifest.samples.length
      && manifest.samples.every((sample) => imageIds.has(sample.imageId))
  const categoryCoverage = Object.entries(thresholds.minimumCategoryCounts)
    .every(([category, minimum]) => (categoryCounts[category] ?? 0) >= minimum)
  const sampleCoverage = records.length >= thresholds.minimumTotalSamples
    && manifestCoverage
    && categoryCoverage
  const mobileCoverage = mobile.length >= thresholds.minimumMobileSamples
  const criteria = {
    sampleCoverage,
    mobileCoverage,
    acceptableWithin30Seconds: passesMinimum(
      acceptableWithin30SecondsRate,
      thresholds.acceptableWithin30SecondsRate,
    ),
    p50CorrectionTime: passesMaximum(p50CorrectionTimeMs, thresholds.p50CorrectionTimeMs),
    p90CorrectionTime: passesMaximum(p90CorrectionTimeMs, thresholds.p90CorrectionTimeMs),
    medianStrokeCount: passesMaximum(medianStrokeCount, thresholds.medianStrokeCount),
    afterPreference: passesMinimum(afterPreferenceRate, thresholds.afterPreferenceRate),
  }

  return {
    schemaVersion: 1,
    recordCount: records.length,
    failureSampleCount: failures.length,
    controlSampleCount: records.length - failures.length,
    mobileSampleCount: mobile.length,
    cancelledAttemptCount: cancelled.length,
    errorAttemptCount: errors.length,
    categoryCounts,
    manifestCoverage,
    acceptableWithin30SecondsRate,
    p50CorrectionTimeMs,
    p90CorrectionTimeMs,
    medianStrokeCount,
    afterPreferenceRate,
    criteria,
    thresholds,
    passed: Object.values(criteria).every(Boolean),
  }
}

function percent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`
}

function milliseconds(value) {
  return value === null ? 'n/a' : `${(value / 1_000).toFixed(1)} s`
}

function criterion(value) {
  return value ? 'PASS' : 'FAIL'
}

export function renderMaskGateReport(summary) {
  return `# Mask Failure Gate\n\n`
    + `Result: **${summary.passed ? 'PASS' : 'FAIL'}**\n\n`
    + `Records: ${summary.recordCount}; failure samples: ${summary.failureSampleCount}; mobile trials: ${summary.mobileSampleCount}; cancelled: ${summary.cancelledAttemptCount}; errors: ${summary.errorAttemptCount}.\n\n`
    + `| Criterion | Result | Observed | Target |\n`
    + `| --- | --- | ---: | ---: |\n`
    + `| Sample coverage | ${criterion(summary.criteria.sampleCoverage)} | ${summary.recordCount} | >= ${summary.thresholds.minimumTotalSamples} + manifest/category coverage |\n`
    + `| Mobile coverage | ${criterion(summary.criteria.mobileCoverage)} | ${summary.mobileSampleCount} | >= ${summary.thresholds.minimumMobileSamples} |\n`
    + `| Acceptable within 30 s | ${criterion(summary.criteria.acceptableWithin30Seconds)} | ${percent(summary.acceptableWithin30SecondsRate)} | >= ${percent(summary.thresholds.acceptableWithin30SecondsRate)} |\n`
    + `| P50 correction time | ${criterion(summary.criteria.p50CorrectionTime)} | ${milliseconds(summary.p50CorrectionTimeMs)} | <= ${milliseconds(summary.thresholds.p50CorrectionTimeMs)} |\n`
    + `| P90 correction time | ${criterion(summary.criteria.p90CorrectionTime)} | ${milliseconds(summary.p90CorrectionTimeMs)} | <= ${milliseconds(summary.thresholds.p90CorrectionTimeMs)} |\n`
    + `| Median strokes | ${criterion(summary.criteria.medianStrokeCount)} | ${summary.medianStrokeCount ?? 'n/a'} | <= ${summary.thresholds.medianStrokeCount} |\n`
    + `| After-pattern preference | ${criterion(summary.criteria.afterPreference)} | ${percent(summary.afterPreferenceRate)} | >= ${percent(summary.thresholds.afterPreferenceRate)} |\n`
}

export async function loadMaskGateRecords(path) {
  const source = await readFile(path, 'utf8')
  const records = []
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue
    try {
      records.push(validateMaskGateRecord(JSON.parse(line)))
    } catch (error) {
      throw new Error(`Invalid mask gate record at line ${index + 1}: ${error.message}`)
    }
  }
  if (records.length === 0) throw new RangeError('Mask gate record file contains zero records')
  return records
}
