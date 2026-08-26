import { evaluateFeatureGateRecord } from './metrics.mjs'
import {
  featureGateTargetSizes,
  validateFeatureGateManifest,
  validateFeatureGateRecord,
} from './schema.mjs'

export const defaultFeatureGateThresholds = Object.freeze({
  minimumSamples: 30,
  eyeTop2AcceptanceRate: 0.9,
  mouthTop2AcceptanceRate: 0.85,
  hardCollisionCount: 0,
  hardFeatureVisibilityRate: 0.95,
})

function rate(count, total) {
  return total === 0 ? null : count / total
}

export function summarizeFeatureGate(inputManifest, inputRecords, thresholds = defaultFeatureGateThresholds) {
  const manifest = validateFeatureGateManifest(inputManifest)
  const records = inputRecords.map(validateFeatureGateRecord)
  const sampleIds = new Set(manifest.samples.map((sample) => sample.imageId))
  const keys = new Set()
  for (const record of records) {
    if (record.datasetId !== manifest.datasetId) throw new RangeError(`Record ${record.imageId} datasetId differs from the manifest`)
    if (sampleIds.has(record.imageId) === false) throw new RangeError(`Record ${record.imageId} falls outside the manifest`)
    const key = `${record.imageId}:${record.size}`
    if (keys.has(key)) throw new RangeError(`Duplicate Feature Gate record: ${key}`)
    keys.add(key)
  }
  for (const sample of manifest.samples) {
    for (const size of manifest.targetSizes) {
      if (keys.has(`${sample.imageId}:${size}`) === false) {
        throw new RangeError(`Missing Feature Gate record: ${sample.imageId}:${size}`)
      }
    }
  }
  const results = records.map(evaluateFeatureGateRecord)
    .toSorted((first, second) => first.imageId.localeCompare(second.imageId) || first.size - second.size)
  const featureRows = results.flatMap((result) => result.features.map((feature) => ({
    imageId: result.imageId,
    size: result.size,
    ...feature,
  })))
  const eyes = featureRows.filter((feature) => feature.kind === 'eye')
  const mouths = featureRows.filter((feature) => feature.kind === 'mouth')
  const noses = featureRows.filter((feature) => feature.kind === 'nose')
  const hard = featureRows.filter((feature) => feature.hard)
  const eyeTop2AcceptanceRate = rate(eyes.filter((feature) => feature.top2Accepted).length, eyes.length)
  const mouthTop2AcceptanceRate = rate(mouths.filter((feature) => feature.top2Accepted).length, mouths.length)
  const noseTop2AcceptanceRate = rate(noses.filter((feature) => feature.top2Accepted).length, noses.length)
  const hardFeatureVisibilityRate = rate(hard.filter((feature) => feature.fullyVisible).length, hard.length)
  const hardCollisionCount = results.reduce((sum, result) => sum + result.collisions.length, 0)
  const coveredSamples = new Set(results.map((result) => result.imageId)).size
  const coveredSizes = new Set(results.map((result) => result.size))
  const criteria = {
    sampleCoverage: coveredSamples >= thresholds.minimumSamples,
    sizeCoverage: featureGateTargetSizes.every((size) => coveredSizes.has(size)),
    eyeTop2: eyeTop2AcceptanceRate >= thresholds.eyeTop2AcceptanceRate,
    mouthTop2: mouthTop2AcceptanceRate >= thresholds.mouthTop2AcceptanceRate,
    collisions: hardCollisionCount <= thresholds.hardCollisionCount,
    visibility: hardFeatureVisibilityRate >= thresholds.hardFeatureVisibilityRate,
  }
  return {
    schemaVersion: 1,
    protocolVersion: manifest.protocolVersion,
    datasetId: manifest.datasetId,
    sampleCount: coveredSamples,
    recordCount: results.length,
    eyeTop2AcceptanceRate,
    mouthTop2AcceptanceRate,
    noseTop2AcceptanceRate,
    hardCollisionCount,
    hardFeatureVisibilityRate,
    thresholds,
    criteria,
    results,
    passed: Object.values(criteria).every(Boolean),
  }
}

function percent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`
}

function criterion(value) {
  return value ? 'PASS' : 'FAIL'
}

export function renderFeatureGateReport(summary) {
  return `# Feature Planning Gate\n\n`
    + `Result: **${summary.passed ? 'PASS' : 'FAIL'}**\n\n`
    + `Portraits: ${summary.sampleCount}; size records: ${summary.recordCount}.\n\n`
    + `| Criterion | Result | Observed | Target |\n`
    + `| --- | --- | ---: | ---: |\n`
    + `| Portrait coverage | ${criterion(summary.criteria.sampleCoverage)} | ${summary.sampleCount} | >= ${summary.thresholds.minimumSamples} |\n`
    + `| 32 / 48 / 64 coverage | ${criterion(summary.criteria.sizeCoverage)} | ${summary.criteria.sizeCoverage ? 'complete' : 'incomplete'} | complete |\n`
    + `| Eye Top-2 acceptance | ${criterion(summary.criteria.eyeTop2)} | ${percent(summary.eyeTop2AcceptanceRate)} | >= ${percent(summary.thresholds.eyeTop2AcceptanceRate)} |\n`
    + `| Mouth Top-2 acceptance | ${criterion(summary.criteria.mouthTop2)} | ${percent(summary.mouthTop2AcceptanceRate)} | >= ${percent(summary.thresholds.mouthTop2AcceptanceRate)} |\n`
    + `| Hard feature collisions | ${criterion(summary.criteria.collisions)} | ${summary.hardCollisionCount} | <= ${summary.thresholds.hardCollisionCount} |\n`
    + `| Hard feature visibility | ${criterion(summary.criteria.visibility)} | ${percent(summary.hardFeatureVisibilityRate)} | >= ${percent(summary.thresholds.hardFeatureVisibilityRate)} |\n\n`
    + `Nose Top-2 diagnostic: ${percent(summary.noseTop2AcceptanceRate)}.\n`
}
