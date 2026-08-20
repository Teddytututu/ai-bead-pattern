import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

import { numericArrayFingerprintSync } from '@ai-bead-pattern/pattern-core'
import sharp from 'sharp'

import { loadMaskGateManifest } from './manifest.mjs'

const maximumImageSide = 2_048
const maximumImagePixels = 4_000_000
const maximumInputPixels = 100_000_000

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function fitMaskGateSourceDimensions(width, height) {
  if (Number.isInteger(width) === false || Number.isInteger(height) === false
    || width < 1 || height < 1) {
    throw new RangeError('Source dimensions must be positive integers')
  }
  const scale = Math.min(
    1,
    maximumImageSide / width,
    maximumImageSide / height,
    Math.sqrt(maximumImagePixels / (width * height)),
  )
  const fitted = {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
  const sourceAspect = width / height
  const fittedAspect = fitted.width / fitted.height
  if (Math.abs(fittedAspect / sourceAspect - 1) > 0.01) {
    throw new RangeError('Source aspect ratio cannot be represented inside the processing limit')
  }
  return fitted
}

async function normalizedSource(path) {
  const metadata = await sharp(path, { limitInputPixels: maximumInputPixels }).metadata()
  const oriented = metadata.autoOrient ?? {
    width: metadata.width,
    height: metadata.height,
  }
  if (oriented.width === undefined || oriented.height === undefined) {
    throw new RangeError(`Image dimensions are unavailable for ${path}`)
  }
  const dimensions = fitMaskGateSourceDimensions(oriented.width, oriented.height)
  const normalized = await sharp(path, { limitInputPixels: maximumInputPixels })
    .autoOrient()
    .resize({
      width: dimensions.width,
      height: dimensions.height,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const image = {
    width: normalized.info.width,
    height: normalized.info.height,
    data: new Uint8ClampedArray(
      normalized.data.buffer,
      normalized.data.byteOffset,
      normalized.data.byteLength,
    ),
  }
  const png = await sharp(normalized.data, {
    raw: { width: normalized.info.width, height: normalized.info.height, channels: 4 },
  }).png().toBuffer()
  return { image, png }
}

function resolveSamplePath(manifestPath, imagePath) {
  return isAbsolute(imagePath)
    ? resolve(imagePath)
    : resolve(dirname(manifestPath), imagePath)
}

function sidecarFile(outputDirectory, fileName) {
  if (fileName.includes('/') || fileName.includes('\\')) {
    throw new RangeError('Sidecar artifact paths must use file names')
  }
  const root = resolve(outputDirectory)
  const path = resolve(root, fileName)
  if (path !== root && path.startsWith(`${root}${sep}`) === false) {
    throw new RangeError('Sidecar artifact path escapes the output directory')
  }
  return path
}

function maskBytes(values) {
  return Buffer.from(Array.from(
    values,
    (value) => Math.round(Math.min(1, Math.max(0, value)) * 255),
  ))
}

export async function generateMaskGateSidecars({
  manifestPath,
  outputDirectory,
  provider,
  model = 'birefnet-general-lite',
  postProcessMask = true,
  gatewayCommit = 'unknown',
}) {
  const manifest = await loadMaskGateManifest(manifestPath)
  const targetDirectory = resolve(outputDirectory)
  try {
    await stat(targetDirectory)
    throw new RangeError(`Mask gate output directory already exists: ${targetDirectory}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await mkdir(dirname(targetDirectory), { recursive: true })
  const stagingDirectory = `${targetDirectory}.staging-${process.pid}-${Date.now()}`
  await mkdir(stagingDirectory)
  const artifacts = []

  try {
    for (const sample of manifest.samples) {
      const source = await normalizedSource(resolveSamplePath(manifestPath, sample.imagePath))
      const segmentation = await provider.segment({
        image: source.image,
        model,
        postProcessMask,
      })
      const evidence = segmentation.analysis.subjectMaskEvidence
      if (evidence === undefined) {
        throw new RangeError(`Segmentation result for ${sample.imageId} lacks subject mask evidence`)
      }
      if (evidence.mask.width !== source.image.width || evidence.mask.height !== source.image.height) {
        throw new RangeError(`Segmentation mask dimensions differ for ${sample.imageId}`)
      }

      const sourceName = `${sample.imageId}.source.png`
      const maskName = `${sample.imageId}.mask.png`
      const analysisName = `${sample.imageId}.analysis.json`
      const maskRaw = maskBytes(evidence.mask.values)
      const encodedMaskValues = Float32Array.from(maskRaw, (value) => value / 255)
      const encodedMaskFingerprint = numericArrayFingerprintSync(encodedMaskValues)
      const maskPng = await sharp(maskRaw, {
        raw: { width: evidence.mask.width, height: evidence.mask.height, channels: 1 },
      }).png().toBuffer()
      const metadata = {
        schemaVersion: 1,
        imageId: sample.imageId,
        datasetId: manifest.datasetId,
        source: {
          path: sourceName,
          sha256: sha256(source.png),
          width: source.image.width,
          height: source.image.height,
        },
        mask: {
          path: maskName,
          sha256: sha256(maskPng),
          width: evidence.mask.width,
          height: evidence.mask.height,
          encoding: 'png-u8-gray',
          numericFingerprint: encodedMaskFingerprint,
        },
        evidence: {
          confidence: evidence.confidence,
          source: evidence.source,
          revision: `sidecar:${evidence.revision}:u8:${encodedMaskFingerprint}`,
          upstreamRevision: evidence.revision,
          ...(evidence.userConfirmed === undefined ? {} : { userConfirmed: evidence.userConfirmed }),
          ...(evidence.provenance === undefined ? {} : { provenance: evidence.provenance }),
        },
        modelVersions: segmentation.analysis.modelVersions ?? {},
        generator: {
          gatewayCommit,
          provider: segmentation.provider,
          model: segmentation.model,
          postProcessMask,
          elapsedMs: segmentation.elapsedMs,
        },
      }

      await Promise.all([
        writeFile(sidecarFile(stagingDirectory, sourceName), source.png),
        writeFile(sidecarFile(stagingDirectory, maskName), maskPng),
        writeFile(
          sidecarFile(stagingDirectory, analysisName),
          `${JSON.stringify(metadata, null, 2)}\n`,
        ),
      ])
      artifacts.push({
        imageId: sample.imageId,
        category: sample.category,
        cohort: sample.cohort,
        failureType: sample.failureType,
        sourceMetadata: sample.source,
        source: sourceName,
        mask: maskName,
        analysis: analysisName,
      })
    }

    const index = {
      schemaVersion: 1,
      datasetId: manifest.datasetId,
      samples: artifacts,
    }
    await writeFile(
      sidecarFile(stagingDirectory, 'index.json'),
      `${JSON.stringify(index, null, 2)}\n`,
    )
    await rename(stagingDirectory, targetDirectory)
    return index
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true })
    throw error
  }
}

function validateMetadata(metadata) {
  if (metadata?.schemaVersion !== 1) throw new RangeError('Sidecar schemaVersion must equal 1')
  if (typeof metadata.imageId !== 'string' || metadata.imageId.length === 0) {
    throw new TypeError('Sidecar imageId must be present')
  }
  if (typeof metadata.datasetId !== 'string' || metadata.datasetId.length === 0) {
    throw new TypeError('Sidecar datasetId must be present')
  }
  if (metadata.mask?.encoding !== 'png-u8-gray') {
    throw new RangeError('Sidecar mask encoding has an unsupported value')
  }
  if (typeof metadata.source?.path !== 'string' || typeof metadata.mask?.path !== 'string') {
    throw new TypeError('Sidecar artifact paths must be present')
  }
  if (typeof metadata.evidence?.revision !== 'string'
    || typeof metadata.evidence?.upstreamRevision !== 'string'
    || Number.isFinite(metadata.evidence?.confidence) === false) {
    throw new TypeError('Sidecar evidence metadata must be complete')
  }
  const expectedRevision = `sidecar:${metadata.evidence.upstreamRevision}:u8:${metadata.mask.numericFingerprint}`
  if (metadata.evidence.revision !== expectedRevision) {
    throw new RangeError('Sidecar evidence revision differs from mask identity')
  }
  return metadata
}

export async function loadMaskGateSidecar(path) {
  const source = await readFile(path, 'utf8')
  const metadata = validateMetadata(JSON.parse(source))
  const outputDirectory = dirname(path)
  const sourcePath = sidecarFile(outputDirectory, metadata.source.path)
  const maskPath = sidecarFile(outputDirectory, metadata.mask.path)
  const [sourcePng, maskPng] = await Promise.all([readFile(sourcePath), readFile(maskPath)])
  if (sha256(sourcePng) !== metadata.source.sha256) {
    throw new RangeError('Sidecar source hash differs from metadata')
  }
  if (sha256(maskPng) !== metadata.mask.sha256) {
    throw new RangeError('Sidecar mask hash differs from metadata')
  }
  const [sourceMetadata, decoded] = await Promise.all([
    sharp(sourcePng).metadata(),
    sharp(maskPng).greyscale().raw().toBuffer({ resolveWithObject: true }),
  ])
  if (sourceMetadata.width !== metadata.source.width
    || sourceMetadata.height !== metadata.source.height) {
    throw new RangeError('Sidecar source dimensions differ from metadata')
  }
  if (decoded.info.width !== metadata.mask.width || decoded.info.height !== metadata.mask.height) {
    throw new RangeError('Sidecar mask dimensions differ from metadata')
  }
  if (metadata.source.width !== metadata.mask.width
    || metadata.source.height !== metadata.mask.height) {
    throw new RangeError('Sidecar source and mask dimensions differ')
  }
  const values = Float32Array.from(decoded.data, (value) => value / 255)
  if (numericArrayFingerprintSync(values) !== metadata.mask.numericFingerprint) {
    throw new RangeError('Sidecar mask fingerprint differs from metadata')
  }
  return {
    metadata,
    sourcePath,
    mask: {
      width: decoded.info.width,
      height: decoded.info.height,
      values,
    },
  }
}
