const protocolVersion = 'mask-gate-v2'

function text(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function finite(value, name) {
  if (Number.isFinite(value) === false) throw new TypeError(`${name} must be finite`)
  return value
}

function integer(value, name, minimum = 0) {
  if (Number.isInteger(value) === false || value < minimum) {
    throw new RangeError(`${name} must be an integer greater than or equal to ${minimum}`)
  }
  return value
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(
    typeof value === 'string' ? value : JSON.stringify(canonicalize(value)),
  )
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((entry) => entry.toString(16).padStart(2, '0'))
    .join('')
}

function snapshot(value, name) {
  if (value === null || typeof value !== 'object') throw new TypeError(`${name} must be an object`)
  return {
    generationId: text(value.generationId, `${name}.generationId`),
    candidateId: text(value.candidateId, `${name}.candidateId`),
    patternHash: text(value.patternHash, `${name}.patternHash`),
    optionsHash: text(value.optionsHash, `${name}.optionsHash`),
    width: integer(value.width, `${name}.width`, 1),
    height: integer(value.height, `${name}.height`, 1),
    colorCount: integer(value.colorCount, `${name}.colorCount`),
    totalBeads: integer(value.totalBeads, `${name}.totalBeads`),
  }
}

function device(value) {
  if (value === null || typeof value !== 'object') throw new TypeError('device must be an object')
  if (['desktop', 'tablet', 'mobile'].includes(value.class) === false) {
    throw new RangeError('device.class has an unsupported value')
  }
  if (['mouse', 'touch', 'pen'].includes(value.inputModality) === false) {
    throw new RangeError('device.inputModality has an unsupported value')
  }
  return {
    class: value.class,
    inputModality: value.inputModality,
    viewportWidth: integer(value.viewportWidth, 'device.viewportWidth', 1),
    viewportHeight: integer(value.viewportHeight, 'device.viewportHeight', 1),
    devicePixelRatio: finite(value.devicePixelRatio, 'device.devicePixelRatio'),
    maxTouchPoints: integer(value.maxTouchPoints, 'device.maxTouchPoints'),
    platform: text(value.platform, 'device.platform'),
  }
}

function identity(input) {
  if (input.protocolVersion !== protocolVersion) {
    throw new RangeError(`protocolVersion must equal ${protocolVersion}`)
  }
  return {
    protocolVersion,
    attemptId: text(input.attemptId, 'attemptId'),
    datasetId: text(input.datasetId, 'datasetId'),
    manifestFingerprint: text(input.manifestFingerprint, 'manifestFingerprint'),
    imageId: text(input.imageId, 'imageId'),
    raterId: text(input.raterId, 'raterId'),
    sampleOrder: integer(input.sampleOrder, 'sampleOrder', 1),
    sampleOrderSeed: text(input.sampleOrderSeed, 'sampleOrderSeed'),
    coreCommit: text(input.coreCommit, 'coreCommit'),
    demoCommit: text(input.demoCommit, 'demoCommit'),
    gatewayCommit: text(input.gatewayCommit, 'gatewayCommit'),
    modelConfigurationId: text(input.modelConfigurationId, 'modelConfigurationId'),
  }
}

export function resolveMaskGateSample(indexUrl, index, sampleId) {
  if (index?.schemaVersion !== 2 || index.protocolVersion !== protocolVersion
    || Array.isArray(index.samples) === false) {
    throw new RangeError('Mask gate index schema is unsupported')
  }
  const datasetId = text(index.datasetId, 'index.datasetId')
  const sample = index.samples.find((entry) => entry.imageId === sampleId)
  if (sample === undefined) throw new RangeError(`Mask gate sample ${sampleId} is missing`)
  return {
    protocolVersion,
    datasetId,
    manifestFingerprint: text(index.manifestFingerprint, 'index.manifestFingerprint'),
    sampleOrderSeed: text(index.sampleOrderSeed, 'index.sampleOrderSeed'),
    modelConfigurationId: text(index.modelConfigurationId, 'index.modelConfigurationId'),
    commits: index.commits,
    sample,
    analysisUrl: new URL(text(sample.analysis, 'sample.analysis'), indexUrl).toString(),
  }
}

export async function createBlindComparison(input) {
  const seed = await sha256([
    text(input.datasetId, 'datasetId'),
    text(input.imageId, 'imageId'),
    text(input.raterId, 'raterId'),
    text(input.protocolVersion, 'protocolVersion'),
  ].join('\0'))
  return {
    leftVariant: Number.parseInt(seed.slice(0, 8), 16) % 2 === 0 ? 'before' : 'after',
    seed,
  }
}

export async function createGatePatternSnapshot({ generationId, candidate, options }) {
  if (candidate?.pattern === undefined) throw new TypeError('candidate.pattern must be present')
  const pattern = candidate.pattern
  return {
    generationId: text(generationId, 'generationId'),
    candidateId: text(candidate.id, 'candidate.id'),
    patternHash: await sha256({
      width: pattern.width,
      height: pattern.height,
      cells: pattern.cells,
      metadata: pattern.metadata,
    }),
    optionsHash: await sha256(options),
    width: integer(pattern.width, 'pattern.width', 1),
    height: integer(pattern.height, 'pattern.height', 1),
    colorCount: integer(candidate.materialCounts?.length ?? 0, 'colorCount'),
    totalBeads: integer(pattern.metadata?.totalBeads ?? pattern.cells?.length ?? 0, 'totalBeads'),
  }
}

export function detectMaskGateDevice(scope = globalThis, pointerType) {
  const width = integer(Math.round(scope.innerWidth), 'innerWidth', 1)
  const height = integer(Math.round(scope.innerHeight), 'innerHeight', 1)
  const maxTouchPoints = integer(scope.navigator?.maxTouchPoints ?? 0, 'maxTouchPoints')
  const inputModality = ['touch', 'pen', 'mouse'].includes(pointerType)
    ? pointerType
    : maxTouchPoints > 0 ? 'touch' : 'mouse'
  return {
    class: width <= 600 ? 'mobile' : width <= 900 ? 'tablet' : 'desktop',
    inputModality,
    viewportWidth: width,
    viewportHeight: height,
    devicePixelRatio: Number.isFinite(scope.devicePixelRatio) ? scope.devicePixelRatio : 1,
    maxTouchPoints,
    platform: String(scope.navigator?.userAgentData?.platform
      ?? scope.navigator?.platform
      ?? 'unknown'),
  }
}

export function createMaskGateAttempt(input) {
  const recordIdentity = identity(input)
  const outcome = text(input.outcome, 'outcome')
  if (['accepted', 'confirmed', 'cancelled', 'error'].includes(outcome) === false) {
    throw new RangeError('outcome has an unsupported value')
  }
  const initialSubjectAcceptable = Boolean(input.initialSubjectAcceptable)
  if (outcome === 'accepted' && initialSubjectAcceptable === false) {
    throw new RangeError('accepted outcome requires an acceptable initial rating')
  }
  if (outcome !== 'accepted' && initialSubjectAcceptable) {
    throw new RangeError('edit outcomes require an initial failure rating')
  }
  const attempt = {
    ...recordIdentity,
    initialRatingAt: finite(input.initialRatingAt, 'initialRatingAt'),
    initialSubjectAcceptable,
    outcome,
    outcomeAt: finite(input.outcomeAt, 'outcomeAt'),
    beforeSnapshot: snapshot(input.beforeSnapshot, 'beforeSnapshot'),
    device: device(input.device),
  }
  if (outcome !== 'accepted' && input.correctionStartedAt !== undefined) {
    attempt.correctionStartedAt = finite(input.correctionStartedAt, 'correctionStartedAt')
    attempt.correctionEndedAt = finite(input.correctionEndedAt, 'correctionEndedAt')
    attempt.session = input.session
  }
  if (outcome === 'confirmed') {
    attempt.afterSnapshot = snapshot(input.afterSnapshot, 'afterSnapshot')
    attempt.subjectAcceptable = Boolean(input.subjectAcceptable)
    attempt.blindComparison = {
      leftVariant: input.blindComparison?.leftVariant,
      choice: input.blindComparison?.choice,
      seed: text(input.blindComparison?.seed, 'blindComparison.seed'),
    }
    attempt.ratedAt = finite(input.ratedAt, 'ratedAt')
  }
  if (outcome === 'error') {
    attempt.error = {
      code: text(input.error?.code, 'error.code'),
      message: text(input.error?.message, 'error.message'),
    }
  }
  return attempt
}

async function fetchOk(fetch, url, type) {
  const response = await fetch(url)
  if (response.ok === false) throw new Error(`${type} request failed with ${response.status}`)
  return response
}

async function hashBlob(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

async function blobPixels(blob, greyscale = false) {
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  if (greyscale) {
    return {
      width: canvas.width,
      height: canvas.height,
      values: Float32Array.from({ length: canvas.width * canvas.height }, (_, index) =>
        pixels[index * 4] / 255),
    }
  }
  return { width: canvas.width, height: canvas.height, data: pixels }
}

export async function loadMaskGateSample({ indexUrl, sampleId, fetch = globalThis.fetch }) {
  const absoluteIndexUrl = new URL(indexUrl, globalThis.location?.href).toString()
  const index = await (await fetchOk(fetch, absoluteIndexUrl, 'Mask gate index')).json()
  const resolved = resolveMaskGateSample(absoluteIndexUrl, index, sampleId)
  const metadata = await (await fetchOk(fetch, resolved.analysisUrl, 'Mask gate analysis')).json()
  if (metadata.schemaVersion !== 2 || metadata.protocolVersion !== protocolVersion
    || metadata.imageId !== sampleId || metadata.datasetId !== resolved.datasetId
    || metadata.manifestFingerprint !== resolved.manifestFingerprint) {
    throw new RangeError('Mask gate sidecar identity differs from the index')
  }
  const sourceUrl = new URL(metadata.source.path, resolved.analysisUrl).toString()
  const maskUrl = new URL(metadata.mask.path, resolved.analysisUrl).toString()
  const [sourceBlob, maskBlob] = await Promise.all([
    (await fetchOk(fetch, sourceUrl, 'Mask gate source')).blob(),
    (await fetchOk(fetch, maskUrl, 'Mask gate mask')).blob(),
  ])
  const [sourceHash, maskHash, image, mask] = await Promise.all([
    hashBlob(sourceBlob),
    hashBlob(maskBlob),
    blobPixels(sourceBlob),
    blobPixels(maskBlob, true),
  ])
  if (sourceHash !== metadata.source.sha256 || maskHash !== metadata.mask.sha256) {
    throw new RangeError('Mask gate artifact hash differs from the sidecar')
  }
  if (image.width !== mask.width || image.height !== mask.height
    || image.width !== metadata.source.width || image.height !== metadata.source.height) {
    throw new RangeError('Mask gate source and mask dimensions differ')
  }
  const expectedRevision = `sidecar:${metadata.evidence.upstreamRevision}:u8:${metadata.mask.numericFingerprint}`
  if (metadata.evidence.revision !== expectedRevision) {
    throw new RangeError('Mask gate evidence revision differs from the mask identity')
  }
  const evidence = {
    mask,
    confidence: metadata.evidence.confidence,
    source: metadata.evidence.source,
    revision: metadata.evidence.revision,
    ...(metadata.evidence.provenance === undefined
      ? {}
      : { provenance: metadata.evidence.provenance }),
  }
  return {
    protocolVersion,
    datasetId: resolved.datasetId,
    manifestFingerprint: resolved.manifestFingerprint,
    sampleOrderSeed: resolved.sampleOrderSeed,
    modelConfigurationId: resolved.modelConfigurationId,
    commits: resolved.commits,
    sample: resolved.sample,
    image,
    analysis: {
      subjectMask: mask,
      subjectMaskEvidence: evidence,
      confidence: evidence.confidence,
      source: 'birefnet-sidecar',
      modelVersions: metadata.modelVersions,
    },
  }
}

export function downloadMaskGateAttempt(attempt) {
  const blob = new Blob([`${JSON.stringify(attempt, null, 2)}\n`], {
    type: 'application/json',
  })
  const link = document.createElement('a')
  link.download = `${attempt.imageId}.attempt.json`
  link.href = URL.createObjectURL(blob)
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 0)
}
