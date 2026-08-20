import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { maskGateProtocolVersion } from './protocol.mjs'

const categories = new Set(['portrait', 'pet', 'illustration', 'object'])
const cohorts = new Set(['targeted-failure', 'clean-control', 'extreme'])
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

function integer(value, name, minimum = 0) {
  if (Number.isInteger(value) === false || value < minimum) {
    throw new RangeError(`${name} must be an integer greater than or equal to ${minimum}`)
  }
  return value
}

function enumValue(value, name, allowed) {
  const normalized = text(value, name)
  if (allowed.has(normalized) === false) {
    throw new RangeError(`${name} has an unsupported value`)
  }
  return normalized
}

function uniqueTexts(value, name) {
  if (Array.isArray(value) === false || value.length === 0) {
    throw new RangeError(`${name} must contain at least one value`)
  }
  const items = value.map((entry, index) => text(entry, `${name}[${index}]`))
  if (new Set(items).size !== items.length) throw new RangeError(`${name} must contain unique values`)
  return items
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
  if (typeof input.targetMobile !== 'boolean') {
    throw new TypeError(`samples[${index}].targetMobile must be boolean`)
  }

  return {
    imageId: text(input.imageId, `samples[${index}].imageId`),
    imagePath: text(input.imagePath, `samples[${index}].imagePath`),
    category: enumValue(input.category, `samples[${index}].category`, categories),
    cohort: enumValue(input.cohort, `samples[${index}].cohort`, cohorts),
    failureTags: uniqueTexts(input.failureTags, `samples[${index}].failureTags`),
    subjectCount: integer(input.subjectCount, `samples[${index}].subjectCount`, 1),
    targetMobile: input.targetMobile,
    source: {
      permission,
      reference,
      ...(source.url === undefined ? {} : { url: text(source.url, `samples[${index}].source.url`) }),
      ...(source.notes === undefined ? {} : { notes: text(source.notes, `samples[${index}].source.notes`) }),
    },
  }
}

function validateCommits(value) {
  const input = object(value, 'manifest.commits')
  return {
    core: text(input.core, 'manifest.commits.core'),
    demo: text(input.demo, 'manifest.commits.demo'),
    gateway: text(input.gateway, 'manifest.commits.gateway'),
  }
}

export function validateMaskGateManifest(value) {
  const input = object(value, 'manifest')
  if (input.schemaVersion !== 2) throw new RangeError('manifest.schemaVersion must equal 2')
  const protocolVersion = text(input.protocolVersion, 'manifest.protocolVersion')
  if (protocolVersion !== maskGateProtocolVersion) {
    throw new RangeError(`manifest.protocolVersion must equal ${maskGateProtocolVersion}`)
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
    if (ids.has(sample.imageId)) throw new RangeError(`Duplicate imageId: ${sample.imageId}`)
    ids.add(sample.imageId)
  }
  return {
    schemaVersion: 2,
    protocolVersion,
    datasetId,
    sampleOrderSeed: text(input.sampleOrderSeed, 'manifest.sampleOrderSeed'),
    modelConfigurationId: text(
      input.modelConfigurationId,
      'manifest.modelConfigurationId',
    ),
    commits: validateCommits(input.commits),
    samples,
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).toSorted().map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function fingerprintMaskGateManifest(value) {
  return sha256(JSON.stringify(canonicalize(validateMaskGateManifest(value))))
}

export function createMaskGateSampleOrder(value) {
  const manifest = validateMaskGateManifest(value)
  return manifest.samples
    .map((sample) => ({
      imageId: sample.imageId,
      orderKey: sha256(`${manifest.sampleOrderSeed}\0${sample.imageId}`),
    }))
    .toSorted((first, second) => first.orderKey.localeCompare(second.orderKey)
      || first.imageId.localeCompare(second.imageId))
    .map((entry, index) => ({ imageId: entry.imageId, sampleOrder: index + 1 }))
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
