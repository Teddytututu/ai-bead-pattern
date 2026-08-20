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

export function resolveMaskGateSample(indexUrl, index, sampleId) {
  if (index?.schemaVersion !== 1 || Array.isArray(index.samples) === false) {
    throw new RangeError('Mask gate index schema is unsupported')
  }
  const datasetId = text(index.datasetId, 'index.datasetId')
  const sample = index.samples.find((entry) => entry.imageId === sampleId)
  if (sample === undefined) throw new RangeError(`Mask gate sample ${sampleId} is missing`)
  return {
    datasetId,
    sample,
    analysisUrl: new URL(text(sample.analysis, 'sample.analysis'), indexUrl).toString(),
  }
}

export function createMaskGateAttempt(input) {
  const outcome = text(input.outcome, 'outcome')
  if (outcome !== 'confirmed' && outcome !== 'cancelled' && outcome !== 'error') {
    throw new RangeError('outcome has an unsupported value')
  }
  const correctionStartedAt = finite(input.correctionStartedAt, 'correctionStartedAt')
  const correctionEndedAt = finite(input.correctionEndedAt, 'correctionEndedAt')
  if (correctionEndedAt < correctionStartedAt) {
    throw new RangeError('correctionEndedAt must follow correctionStartedAt')
  }
  const attempt = {
    imageId: text(input.imageId, 'imageId'),
    outcome,
    correctionStartedAt,
    correctionEndedAt,
    beforeGenerationId: text(input.beforeGenerationId, 'beforeGenerationId'),
    initialSubjectAcceptable: Boolean(input.initialSubjectAcceptable),
    subjectAcceptable: outcome === 'confirmed' ? Boolean(input.subjectAcceptable) : false,
    patternPreference: outcome === 'confirmed'
      ? text(input.patternPreference, 'patternPreference')
      : 'unrated',
    deviceClass: text(input.deviceClass, 'deviceClass'),
    session: input.session,
  }
  if (outcome === 'confirmed') {
    attempt.afterGenerationId = text(input.afterGenerationId, 'afterGenerationId')
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
  if (metadata.schemaVersion !== 1 || metadata.imageId !== sampleId
    || metadata.datasetId !== resolved.datasetId) {
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
    datasetId: resolved.datasetId,
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
