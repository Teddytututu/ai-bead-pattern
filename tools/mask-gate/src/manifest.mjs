import { readFile } from 'node:fs/promises'

const categories = new Set(['portrait', 'pet', 'illustration-object', 'control-extreme'])
const cohorts = new Set(['failure', 'control', 'extreme'])
const permissions = new Set(['owned', 'licensed', 'public-domain', 'research-consent'])

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

function enumValue(value, name, allowed) {
  const normalized = text(value, name)
  if (allowed.has(normalized) === false) {
    throw new RangeError(`${name} has an unsupported value`)
  }
  return normalized
}

function validateSample(value, index) {
  const input = object(value, `samples[${index}]`)
  const source = object(input.source, `samples[${index}].source`)
  const permission = enumValue(
    source.permission,
    `samples[${index}].source.permission`,
    permissions,
  )
  const reference = text(source.reference, `samples[${index}].source.reference`)

  return {
    imageId: text(input.imageId, `samples[${index}].imageId`),
    imagePath: text(input.imagePath, `samples[${index}].imagePath`),
    category: enumValue(input.category, `samples[${index}].category`, categories),
    cohort: enumValue(input.cohort, `samples[${index}].cohort`, cohorts),
    failureType: text(input.failureType, `samples[${index}].failureType`),
    source: {
      permission,
      reference,
      ...(source.url === undefined ? {} : { url: text(source.url, `samples[${index}].source.url`) }),
      ...(source.notes === undefined ? {} : { notes: text(source.notes, `samples[${index}].source.notes`) }),
    },
  }
}

export function validateMaskGateManifest(value) {
  const input = object(value, 'manifest')
  if (input.schemaVersion !== 1) {
    throw new RangeError('manifest.schemaVersion must equal 1')
  }
  const datasetId = text(input.datasetId, 'manifest.datasetId')
  if (Array.isArray(input.samples) === false || input.samples.length === 0) {
    throw new RangeError('manifest.samples must contain at least one sample')
  }
  if (input.samples.length > 200) {
    throw new RangeError('manifest.samples exceeds the 200-sample evaluation limit')
  }
  const samples = input.samples.map(validateSample)
  const ids = new Set()
  for (const sample of samples) {
    if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(sample.imageId) === false) {
      throw new RangeError(`imageId ${sample.imageId} must use letters, numbers, underscore, or hyphen`)
    }
    if (ids.has(sample.imageId)) {
      throw new RangeError(`Duplicate imageId: ${sample.imageId}`)
    }
    ids.add(sample.imageId)
  }
  return { schemaVersion: 1, datasetId, samples }
}

export async function loadMaskGateManifest(path) {
  const source = await readFile(path, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new SyntaxError(`Mask gate manifest JSON is malformed: ${error.message}`)
  }
  return validateMaskGateManifest(parsed)
}
