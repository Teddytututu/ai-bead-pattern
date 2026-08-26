import { readFile } from 'node:fs/promises'

export const featureGateProtocolVersion = 'feature-gate-v1'
export const featureGateTargetSizes = Object.freeze([32, 48, 64])

const featureKinds = new Set(['eye', 'mouth', 'nose'])
const requiredFeatures = Object.freeze([
  ['left-eye-center', 'eye'],
  ['right-eye-center', 'eye'],
  ['mouth-center', 'mouth'],
  ['nose-tip', 'nose'],
])

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

function integer(value, name, minimum = 0) {
  if (Number.isInteger(value) === false || value < minimum) {
    throw new RangeError(`${name} must be an integer greater than or equal to ${minimum}`)
  }
  return value
}

function unit(value, name) {
  if (Number.isFinite(value) === false || value < 0 || value > 1) {
    throw new RangeError(`${name} must stay within 0..1`)
  }
  return value
}

function uniqueTexts(value, name) {
  if (Array.isArray(value) === false || value.length === 0) {
    throw new RangeError(`${name} must contain at least one value`)
  }
  const output = value.map((entry, index) => text(entry, `${name}[${index}]`))
  if (new Set(output).size !== output.length) throw new RangeError(`${name} must contain unique values`)
  return output
}

function cells(value, name, size, allowEmpty = false) {
  if (Array.isArray(value) === false || (allowEmpty === false && value.length === 0)) {
    throw new RangeError(`${name} must contain ${allowEmpty ? 'an array of' : 'at least one'} grid cell`)
  }
  const output = value.map((entry, index) => integer(entry, `${name}[${index}]`))
  if (output.some((cell) => cell >= size * size)) {
    throw new RangeError(`${name} must stay inside the target grid`)
  }
  if (new Set(output).size !== output.length) throw new RangeError(`${name} must contain unique values`)
  return output.toSorted((first, second) => first - second)
}

function candidate(value, name, size) {
  const input = object(value, name)
  return {
    candidateId: text(input.candidateId, `${name}.candidateId`),
    templateId: text(input.templateId, `${name}.templateId`),
    occupiedCells: cells(input.occupiedCells, `${name}.occupiedCells`, size),
    score: unit(input.score, `${name}.score`),
  }
}

function feature(value, name, size) {
  const input = object(value, name)
  const kind = text(input.kind, `${name}.kind`)
  if (featureKinds.has(kind) === false) throw new RangeError(`${name}.kind has an unsupported value`)
  if (Array.isArray(input.topCandidates) === false || input.topCandidates.length < 2) {
    throw new RangeError(`${name}.topCandidates must contain at least two candidates`)
  }
  const topCandidates = input.topCandidates.map((entry, index) =>
    candidate(entry, `${name}.topCandidates[${index}]`, size))
  const candidateIds = new Set(topCandidates.map((entry) => entry.candidateId))
  if (candidateIds.size !== topCandidates.length) throw new RangeError(`${name}.topCandidates ids must be unique`)
  const acceptedCandidateIds = uniqueTexts(input.acceptedCandidateIds, `${name}.acceptedCandidateIds`)
  if (acceptedCandidateIds.some((id) => candidateIds.has(id) === false)) {
    throw new RangeError(`${name}.acceptedCandidateIds must reference evaluated candidates`)
  }
  const selectedCandidateId = text(input.selectedCandidateId, `${name}.selectedCandidateId`)
  const selected = topCandidates.find((entry) => entry.candidateId === selectedCandidateId)
  if (selected === undefined) throw new RangeError(`${name}.selectedCandidateId must reference a candidate`)
  const visibleCells = cells(input.visibleCells, `${name}.visibleCells`, size, true)
  if (visibleCells.some((cell) => selected.occupiedCells.includes(cell) === false)) {
    throw new RangeError(`${name}.visibleCells must belong to the selected candidate`)
  }
  return {
    featureId: text(input.featureId, `${name}.featureId`),
    kind,
    hard: input.hard === true,
    topCandidates,
    acceptedCandidateIds,
    selectedCandidateId,
    visibleCells,
  }
}

export function validateFeatureGateManifest(value) {
  const input = object(value, 'manifest')
  if (input.schemaVersion !== 1) throw new RangeError('manifest.schemaVersion must equal 1')
  const protocolVersion = text(input.protocolVersion, 'manifest.protocolVersion')
  if (protocolVersion !== featureGateProtocolVersion) {
    throw new RangeError(`manifest.protocolVersion must equal ${featureGateProtocolVersion}`)
  }
  if (Array.isArray(input.targetSizes) === false
    || input.targetSizes.length !== featureGateTargetSizes.length
    || input.targetSizes.some((size, index) => size !== featureGateTargetSizes[index])) {
    throw new RangeError('manifest.targetSizes must equal 32, 48, 64')
  }
  if (Array.isArray(input.samples) === false || input.samples.length !== 30) {
    throw new RangeError('manifest.samples must contain exactly 30 portrait samples')
  }
  const samples = input.samples.map((entry, index) => {
    const sample = object(entry, `manifest.samples[${index}]`)
    return {
      imageId: text(sample.imageId, `manifest.samples[${index}].imageId`),
      challengeTags: uniqueTexts(sample.challengeTags, `manifest.samples[${index}].challengeTags`),
    }
  })
  if (new Set(samples.map((sample) => sample.imageId)).size !== samples.length) {
    throw new RangeError('manifest.samples must contain unique imageId values')
  }
  const commits = object(input.commits, 'manifest.commits')
  return {
    schemaVersion: 1,
    protocolVersion,
    datasetId: text(input.datasetId, 'manifest.datasetId'),
    targetSizes: [...featureGateTargetSizes],
    coreVersion: text(input.coreVersion, 'manifest.coreVersion'),
    commits: {
      core: text(commits.core, 'manifest.commits.core'),
      gateway: text(commits.gateway, 'manifest.commits.gateway'),
    },
    samples,
  }
}

export function validateFeatureGateRecord(value) {
  const input = object(value, 'record')
  if (input.schemaVersion !== 1) throw new RangeError('record.schemaVersion must equal 1')
  const protocolVersion = text(input.protocolVersion, 'record.protocolVersion')
  if (protocolVersion !== featureGateProtocolVersion) {
    throw new RangeError(`record.protocolVersion must equal ${featureGateProtocolVersion}`)
  }
  const size = integer(input.size, 'record.size', 1)
  if (featureGateTargetSizes.includes(size) === false) throw new RangeError('record.size has an unsupported value')
  if (Array.isArray(input.features) === false || input.features.length !== requiredFeatures.length) {
    throw new RangeError('record.features must contain both eyes, mouth, and nose')
  }
  const features = input.features.map((entry, index) => feature(entry, `record.features[${index}]`, size))
  const byId = new Map(features.map((entry) => [entry.featureId, entry]))
  for (const [featureId, kind] of requiredFeatures) {
    const required = byId.get(featureId)
    if (required?.kind !== kind) throw new RangeError(`record.features requires ${featureId} as ${kind}`)
    if (required.hard !== true) throw new RangeError(`record.features requires ${featureId} as a hard feature`)
  }
  return {
    schemaVersion: 1,
    protocolVersion,
    datasetId: text(input.datasetId, 'record.datasetId'),
    imageId: text(input.imageId, 'record.imageId'),
    size,
    evaluatorId: text(input.evaluatorId, 'record.evaluatorId'),
    candidateId: text(input.candidateId, 'record.candidateId'),
    features,
  }
}

function placementCells(size, x, y, count, horizontal = true) {
  return Array.from({ length: count }, (_, index) =>
    (y + (horizontal ? 0 : index)) * size + x + (horizontal ? index : 0))
}

function protocolFeature(featureId, kind, size, index, x, y, templates, counts) {
  const first = {
    candidateId: `${featureId}-${size}-a`,
    templateId: templates[0],
    occupiedCells: placementCells(size, x, y, counts[0]),
    score: 0.96,
  }
  const second = {
    candidateId: `${featureId}-${size}-b`,
    templateId: templates[1],
    occupiedCells: placementCells(size, x + 1, y, counts[1]),
    score: 0.91,
  }
  const selected = index % 3 === 0 ? second : first
  return {
    featureId,
    kind,
    hard: true,
    topCandidates: [first, second],
    acceptedCandidateIds: [selected.candidateId],
    selectedCandidateId: selected.candidateId,
    visibleCells: [...selected.occupiedCells],
  }
}

export function createFeatureGateProtocolFixtures() {
  return {
    schemaVersion: 1,
    protocolVersion: featureGateProtocolVersion,
    datasetId: 'feature-gate-protocol-fixtures-30',
    targetSizes: [...featureGateTargetSizes],
    coreVersion: 'protocol-fixture',
    commits: { core: 'protocol-fixture', gateway: 'protocol-fixture' },
    samples: Array.from({ length: 30 }, (_, index) => ({
      imageId: `portrait-${String(index + 1).padStart(2, '0')}`,
      challengeTags: [`case-${String(index % 10 + 1).padStart(2, '0')}`],
    })),
  }
}

export function createFeatureGateProtocolRecords(inputManifest) {
  const manifest = validateFeatureGateManifest(inputManifest)
  return manifest.samples.flatMap((sample, sampleIndex) => manifest.targetSizes.map((size) => {
    const eyeTemplates = size === 32
      ? ['eye-e1', 'eye-e2-h']
      : size === 48 ? ['eye-e2-h', 'eye-e4'] : ['eye-e4', 'eye-highlight']
    const eyeCounts = size === 32 ? [1, 2] : size === 48 ? [2, 4] : [4, 4]
    const mouthTemplates = size === 32
      ? ['mouth-m2', 'mouth-m3']
      : size === 48 ? ['mouth-m3', 'mouth-stair'] : ['mouth-stair', 'mouth-open']
    const mouthCounts = size === 32 ? [2, 3] : size === 48 ? [3, 3] : [3, 5]
    return {
      schemaVersion: 1,
      protocolVersion: manifest.protocolVersion,
      datasetId: manifest.datasetId,
      imageId: sample.imageId,
      size,
      evaluatorId: 'protocol-evaluator',
      candidateId: `${sample.imageId}-${size}`,
      features: [
        protocolFeature('left-eye-center', 'eye', size, sampleIndex, Math.floor(size * 0.35), Math.floor(size * 0.4), eyeTemplates, eyeCounts),
        protocolFeature('right-eye-center', 'eye', size, sampleIndex + 1, Math.floor(size * 0.62), Math.floor(size * 0.4), eyeTemplates, eyeCounts),
        protocolFeature('mouth-center', 'mouth', size, sampleIndex + 2, Math.floor(size * 0.48), Math.floor(size * 0.64), mouthTemplates, mouthCounts),
        protocolFeature('nose-tip', 'nose', size, sampleIndex + 1, Math.floor(size * 0.49), Math.floor(size * 0.52), ['nose-n1', 'nose-n2'], [1, 2]),
      ],
    }
  }))
}

export async function loadFeatureGateManifest(path) {
  return validateFeatureGateManifest(JSON.parse(await readFile(path, 'utf8')))
}

export async function loadFeatureGateRecords(path) {
  const source = await readFile(path, 'utf8')
  const records = []
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue
    try {
      records.push(validateFeatureGateRecord(JSON.parse(line)))
    } catch (error) {
      throw new Error(`Invalid Feature Gate record at line ${index + 1}: ${error.message}`)
    }
  }
  if (records.length === 0) throw new RangeError('Feature Gate records contain zero entries')
  return records
}
