import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createMaskGateSampleOrder,
  fingerprintMaskGateManifest,
  validateMaskGateManifest,
} from './manifest.mjs'

export const maskGateDatasetQuotas = Object.freeze({
  portrait: Object.freeze({ 'targeted-failure': 10, 'clean-control': 1, extreme: 1 }),
  pet: Object.freeze({ 'targeted-failure': 10, 'clean-control': 1, extreme: 1 }),
  illustration: Object.freeze({ 'targeted-failure': 6, 'clean-control': 1, extreme: 1 }),
  object: Object.freeze({ 'targeted-failure': 6, 'clean-control': 1, extreme: 1 }),
})

function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value
}

function text(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stableOrder(values, seed) {
  return values.toSorted((first, second) => {
    const firstKey = sha256(`${seed}\0${first.imageId}`)
    const secondKey = sha256(`${seed}\0${second.imageId}`)
    return firstKey.localeCompare(secondKey) || first.imageId.localeCompare(second.imageId)
  })
}

export function validateMaskGateCandidatePool(value) {
  const input = object(value, 'candidatePool')
  if (input.schemaVersion !== 1) throw new RangeError('candidatePool.schemaVersion must equal 1')
  if (Array.isArray(input.candidates) === false
    || input.candidates.length < 50 || input.candidates.length > 60) {
    throw new RangeError('candidatePool.candidates must contain 50 to 60 samples')
  }
  const manifest = validateMaskGateManifest({
    schemaVersion: 2,
    protocolVersion: input.protocolVersion,
    datasetId: input.datasetId,
    sampleOrderSeed: input.sampleOrderSeed,
    modelConfigurationId: input.modelConfigurationId,
    commits: input.commits,
    samples: input.candidates,
  })
  const candidates = manifest.samples.map((candidate, index) => ({
    ...candidate,
    expectedDifficulty: text(
      input.candidates[index].expectedDifficulty,
      `candidates[${index}].expectedDifficulty`,
    ),
  }))
  return {
    schemaVersion: 1,
    candidatePoolId: text(input.candidatePoolId, 'candidatePool.candidatePoolId'),
    protocolVersion: manifest.protocolVersion,
    datasetId: manifest.datasetId,
    freezeSeed: text(input.freezeSeed, 'candidatePool.freezeSeed'),
    sampleOrderSeed: manifest.sampleOrderSeed,
    modelConfigurationId: manifest.modelConfigurationId,
    commits: manifest.commits,
    candidates,
  }
}

function pickQuota(pool, category, cohort, count) {
  const candidates = stableOrder(
    pool.candidates.filter((candidate) =>
      candidate.category === category && candidate.cohort === cohort),
    `${pool.freezeSeed}\0${category}\0${cohort}`,
  )
  if (candidates.length < count) {
    throw new RangeError(`Candidate pool lacks ${category}/${cohort}: ${candidates.length}/${count}`)
  }
  if (cohort !== 'targeted-failure') return candidates.slice(0, count)
  const mobile = candidates.filter((candidate) => candidate.targetMobile)
  if (mobile.length < 2) {
    throw new RangeError(`Candidate pool requires two mobile ${category} targeted failures`)
  }
  const selectedMobile = mobile.slice(0, 2)
  const selectedIds = new Set(selectedMobile.map((candidate) => candidate.imageId))
  return [
    ...selectedMobile,
    ...candidates.filter((candidate) => selectedIds.has(candidate.imageId) === false),
  ].slice(0, count)
}

export function freezeMaskGateDataset(value) {
  const pool = validateMaskGateCandidatePool(value)
  const samples = []
  for (const [category, cohorts] of Object.entries(maskGateDatasetQuotas)) {
    for (const [cohort, count] of Object.entries(cohorts)) {
      samples.push(...pickQuota(pool, category, cohort, count))
    }
  }
  const manifest = validateMaskGateManifest({
    schemaVersion: 2,
    protocolVersion: pool.protocolVersion,
    datasetId: pool.datasetId,
    sampleOrderSeed: pool.sampleOrderSeed,
    modelConfigurationId: pool.modelConfigurationId,
    commits: pool.commits,
    samples,
  })
  return {
    manifest,
    manifestFingerprint: fingerprintMaskGateManifest(manifest),
    sampleOrder: createMaskGateSampleOrder(manifest),
  }
}

function csv(value) {
  const source = value === undefined ? '' : String(value)
  return /[",\r\n]/.test(source) ? `"${source.replaceAll('"', '""')}"` : source
}

export function renderPermissionLedger(manifest) {
  const rows = ['imageId,permission,reference,url,notes']
  for (const sample of manifest.samples) {
    rows.push([
      sample.imageId,
      sample.source.permission,
      sample.source.reference,
      sample.source.url,
      sample.source.notes,
    ].map(csv).join(','))
  }
  return `${rows.join('\n')}\n`
}

export async function freezeMaskGateDatasetFiles(value, outputDirectory) {
  const frozen = freezeMaskGateDataset(value)
  await mkdir(outputDirectory, { recursive: true })
  await Promise.all([
    writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(frozen.manifest, null, 2)}\n`),
    writeFile(join(outputDirectory, 'manifest.sha256'), `${frozen.manifestFingerprint}\n`),
    writeFile(join(outputDirectory, 'sample-order.json'), `${JSON.stringify(frozen.sampleOrder, null, 2)}\n`),
    writeFile(join(outputDirectory, 'permission-ledger.csv'), renderPermissionLedger(frozen.manifest)),
  ])
  return frozen
}
