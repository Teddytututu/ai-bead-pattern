import sharp from 'sharp'

import type {
  BinaryMask,
  CropRect,
  ImageAnalysis,
  ImageType,
  PixelImage,
} from '@ai-bead-pattern/pattern-core'
import { inferPetInstances, numericArrayFingerprintSync } from '@ai-bead-pattern/pattern-core'

export type SegmentationModel =
  | 'birefnet-general-lite'
  | 'birefnet-general'
  | 'birefnet-portrait'
  | 'isnet-general-use'

export interface SegmentationRequest {
  image: PixelImage
  imageTypeHint?: ImageType
  model?: SegmentationModel
  postProcessMask?: boolean
  signal?: AbortSignal
  timeoutMs?: number
}

export interface SegmentationResult {
  provider: 'rembg-http'
  model: SegmentationModel
  analysis: ImageAnalysis
  elapsedMs: number
}

export interface SegmentationProvider {
  segment(request: SegmentationRequest): Promise<SegmentationResult>
  probe?(signal?: AbortSignal): Promise<{
    status: 'ready' | 'degraded' | 'unavailable'
    latencyMs: number
    message?: string
  }>
}

export interface RembgHttpSegmentationProviderOptions {
  endpoint?: string
  defaultModel?: SegmentationModel
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  cropThreshold?: number
  cropPaddingRatio?: number
}

interface DecodedMask {
  width: number
  height: number
  values: Float32Array
}

const maximumResponseBytes = 64 * 1024 * 1024
const maximumImageSide = 2_048
const maximumImagePixels = 4_000_000
const secondaryComponentPrimaryAreaRatio = 0.35
const secondaryComponentImageAreaRatio = 0.003
const segmentationModels = new Set<SegmentationModel>([
  'birefnet-general-lite',
  'birefnet-general',
  'birefnet-portrait',
  'isnet-general-use',
])

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function normalizedEndpoint(value: string): string {
  const url = new URL(value)
  if ((url.protocol === 'http:' || url.protocol === 'https:') === false) {
    throw new RangeError('rembg endpoint must use HTTP or HTTPS')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new RangeError('rembg endpoint credentials must use deployment secrets')
  }
  return url.toString().replace(/\/$/, '')
}

function validateRequest(request: SegmentationRequest): void {
  const { image } = request
  if (Number.isInteger(image.width) === false || image.width <= 0
    || Number.isInteger(image.height) === false || image.height <= 0) {
    throw new RangeError('Segmentation image dimensions must be positive integers')
  }
  if (image.data.length !== image.width * image.height * 4) {
    throw new RangeError('Segmentation RGBA data length must equal width * height * 4')
  }
  if (image.width > maximumImageSide || image.height > maximumImageSide
    || image.width * image.height > maximumImagePixels) {
    throw new RangeError('Segmentation image exceeds the processing limit')
  }
  if (request.model !== undefined && segmentationModels.has(request.model) === false) {
    throw new RangeError('Segmentation model has an unsupported value')
  }
  if (request.postProcessMask !== undefined && typeof request.postProcessMask !== 'boolean') {
    throw new RangeError('Segmentation mask post-processing flag must be boolean')
  }
  if (request.timeoutMs !== undefined
    && (Number.isFinite(request.timeoutMs) === false || request.timeoutMs <= 0)) {
    throw new RangeError('Segmentation timeout must be a finite positive number')
  }
  if (request.imageTypeHint !== undefined
    && new Set<ImageType>(['portrait', 'pet', 'illustration', 'landscape', 'general']).has(request.imageTypeHint) === false) {
    throw new RangeError('Segmentation image type hint is invalid')
  }
}

async function encodePng(image: PixelImage): Promise<Buffer> {
  const pixels = Buffer.from(
    image.data.buffer,
    image.data.byteOffset,
    image.data.byteLength,
  )
  return sharp(pixels, {
    raw: { width: image.width, height: image.height, channels: 4 },
  }).png().toBuffer()
}

async function decodeMask(data: Uint8Array): Promise<DecodedMask> {
  const decoded = await sharp(data)
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const values = new Float32Array(decoded.info.width * decoded.info.height)
  for (let index = 0; index < values.length; index += 1) {
    values[index] = (decoded.data[index] ?? 0) / 255
  }
  return { width: decoded.info.width, height: decoded.info.height, values }
}

function maskCertaintyHeuristic(values: Float32Array): number {
  if (values.length === 0) return 0
  let total = 0
  let foreground = 0
  for (const value of values) {
    total += Math.abs(value - 0.5) * 2
    if (value >= 0.5) foreground += 1
  }
  if (foreground === 0) return 0
  return clamp(total / values.length, 0, 1)
}

function boundaryImportance(mask: DecodedMask): Float32Array {
  const weights = new Float32Array(mask.values.length)
  const offsets = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      const index = y * mask.width + x
      const value = mask.values[index] ?? 0
      let boundary = 0
      for (const [offsetX, offsetY] of offsets) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX < 0 || nextY < 0 || nextX >= mask.width || nextY >= mask.height) continue
        boundary = Math.max(boundary, Math.abs(value - (mask.values[nextY * mask.width + nextX] ?? 0)))
      }
      weights[index] = clamp(value * 0.55 + boundary * 0.75, 0, 1)
    }
  }
  return weights
}

function significantConnectedMask(mask: DecodedMask, threshold: number): DecodedMask {
  const labels = new Uint32Array(mask.values.length)
  const componentSizes = [0]
  for (let start = 0; start < mask.values.length; start += 1) {
    if (labels[start] !== 0 || (mask.values[start] ?? 0) < threshold) continue
    const label = componentSizes.length
    const queue = [start]
    let componentSize = 0
    labels[start] = label
    while (queue.length > 0) {
      const index = queue.pop()!
      componentSize += 1
      const x = index % mask.width
      const y = Math.floor(index / mask.width)
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue
          const nextX = x + offsetX
          const nextY = y + offsetY
          if (nextX < 0 || nextY < 0 || nextX >= mask.width || nextY >= mask.height) continue
          const next = nextY * mask.width + nextX
          if (labels[next] !== 0 || (mask.values[next] ?? 0) < threshold) continue
          labels[next] = label
          queue.push(next)
        }
      }
    }
    componentSizes.push(componentSize)
  }
  if (componentSizes.length === 1) return mask
  let primaryLabel = 1
  for (let label = 2; label < componentSizes.length; label += 1) {
    if (componentSizes[label]! > componentSizes[primaryLabel]!) primaryLabel = label
  }
  const retainedLabels = new Uint8Array(componentSizes.length)
  retainedLabels[primaryLabel] = 1
  const primaryArea = componentSizes[primaryLabel]!
  for (let label = 1; label < componentSizes.length; label += 1) {
    const area = componentSizes[label]!
    if (area >= primaryArea * secondaryComponentPrimaryAreaRatio
      && area >= mask.values.length * secondaryComponentImageAreaRatio) {
      retainedLabels[label] = 1
    }
  }
  const keep = new Uint8Array(mask.values.length)
  for (let index = 0; index < labels.length; index += 1) {
    if (retainedLabels[labels[index]!] === 1) keep[index] = 1
  }
  // Connected-component filtering uses hard foreground; retained regions recover one soft-alpha ring.
  for (let index = 0; index < labels.length; index += 1) {
    if (retainedLabels[labels[index]!] !== 1) continue
    const x = index % mask.width
    const y = Math.floor(index / mask.width)
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX < 0 || nextY < 0 || nextX >= mask.width || nextY >= mask.height) continue
        const next = nextY * mask.width + nextX
        if ((mask.values[next] ?? 0) > 0) keep[next] = 1
      }
    }
  }
  return {
    width: mask.width,
    height: mask.height,
    values: Float32Array.from(mask.values, (value, index) => keep[index] === 1 ? value : 0),
  }
}

function rectangularMask(width: number, height: number, crop: CropRect): BinaryMask {
  const values = new Float32Array(width * height)
  const right = Math.min(width, crop.x + crop.width)
  const bottom = Math.min(height, crop.y + crop.height)
  for (let y = Math.max(0, crop.y); y < bottom; y += 1) {
    for (let x = Math.max(0, crop.x); x < right; x += 1) values[y * width + x] = 1
  }
  return { width, height, values }
}

function subjectCrop(
  mask: DecodedMask,
  threshold: number,
  paddingRatio: number,
): CropRect | undefined {
  let minimumX = mask.width
  let minimumY = mask.height
  let maximumX = -1
  let maximumY = -1
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if ((mask.values[y * mask.width + x] ?? 0) < threshold) continue
      minimumX = Math.min(minimumX, x)
      minimumY = Math.min(minimumY, y)
      maximumX = Math.max(maximumX, x)
      maximumY = Math.max(maximumY, y)
    }
  }
  if (maximumX < minimumX || maximumY < minimumY) return undefined
  const padding = Math.round(Math.max(mask.width, mask.height) * paddingRatio)
  const x = Math.max(0, minimumX - padding)
  const y = Math.max(0, minimumY - padding)
  const right = Math.min(mask.width, maximumX + padding + 1)
  const bottom = Math.min(mask.height, maximumY + padding + 1)
  return { x, y, width: right - x, height: bottom - y }
}

function analysisFromMask(
  mask: DecodedMask,
  image: PixelImage,
  model: SegmentationModel,
  cropThreshold: number,
  cropPaddingRatio: number,
  imageTypeHint?: ImageType,
): ImageAnalysis {
  const cleanedMask = significantConnectedMask(mask, cropThreshold)
  const subjectMask: BinaryMask = {
    width: cleanedMask.width,
    height: cleanedMask.height,
    values: cleanedMask.values,
  }
  const confidence = maskCertaintyHeuristic(cleanedMask.values)
  const componentCrop = subjectCrop(cleanedMask, cropThreshold, cropPaddingRatio)
  const inferredPetGroup = imageTypeHint === 'portrait' || imageTypeHint === 'illustration' || imageTypeHint === 'landscape'
    ? undefined
    : inferPetInstances(image, subjectMask)
  const petGroup = inferredPetGroup !== undefined
    && (imageTypeHint === 'pet' || inferredPetGroup.confidence >= 0.62)
    ? inferredPetGroup
    : undefined
  const crop = petGroup?.suggestedCrop ?? componentCrop
  const provenance = [{
    origin: 'model' as const,
    provider: 'rembg-http',
    model,
    version: 'mask-v1-certainty-v1',
  }]
  const maskFingerprint = numericArrayFingerprintSync(cleanedMask.values)
  const analysis: ImageAnalysis = {
    confidence,
    subjectMask,
    subjectMaskEvidence: {
      mask: subjectMask,
      confidence,
      source: 'ai',
      revision: `rembg-http:${model}:mask-v2-certainty-v1:${maskFingerprint}`,
      provenance,
    },
    importanceMap: {
      width: cleanedMask.width,
      height: cleanedMask.height,
      weights: boundaryImportance(cleanedMask),
    },
    semanticRegions: [{
      id: 'subject',
      label: 'subject',
      confidence,
      importance: 0.8,
      mask: subjectMask,
      provenance,
    }, ...(petGroup === undefined ? [] : petGroup.instances.flatMap((instance) => [{
      id: `${instance.instanceId}:subject`,
      label: 'pet instance',
      confidence: instance.confidence,
      importance: 0.95,
      mask: instance.instanceMask,
      provenance: [{ origin: 'heuristic' as const, provider: 'pet-components', version: 'significant-components-v1' }],
    }, {
      id: `${instance.instanceId}:pet-face`,
      label: 'pet face',
      confidence: instance.confidence,
      importance: 1,
      mask: instance.faceMask,
      provenance: [{ origin: 'heuristic' as const, provider: 'pet-geometry', version: 'pet-face-v3' }],
    }, ...instance.bodyRegions]))],
    ...(petGroup === undefined ? {} : {
      imageType: 'pet' as const,
      landmarks: petGroup.instances.flatMap((instance) => instance.landmarks),
    }),
    modelVersions: {
      segmentation: `rembg/${model}`,
      ...(petGroup === undefined ? {} : {
        petAnalysis: 'pattern-core/pet-analysis-v3-ap10k',
        petInstances: String(petGroup.instances.length),
        petHeadPose: petGroup.instances.map((instance) => instance.headPose).join(','),
      }),
    },
    provenance,
  }
  if (crop !== undefined) {
    analysis.suggestedCrop = crop
    analysis.suggestedCropSource = 'automatic'
    analysis.suggestedCropConfidence = petGroup?.confidence ?? confidence
  }
  return analysis
}

async function readResponseBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > limit) throw new Error('rembg mask exceeds the response limit')
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new Error('rembg mask exceeds the response limit')
    }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function responseMessage(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < 4_096) {
    const next = await reader.read()
    if (next.done) break
    const remaining = 4_096 - total
    const chunk = next.value.subarray(0, remaining)
    chunks.push(chunk)
    total += chunk.byteLength
    if (chunk.byteLength < next.value.byteLength) break
  }
  await reader.cancel()
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const message = new TextDecoder().decode(bytes).replace(/\s+/g, ' ').trim().slice(0, 500)
  return message.length > 0 ? `: ${message}` : ''
}

export class RembgHttpSegmentationProvider implements SegmentationProvider {
  readonly #endpoint: string
  readonly #defaultModel: SegmentationModel
  readonly #fetch: typeof globalThis.fetch
  readonly #timeoutMs: number
  readonly #cropThreshold: number
  readonly #cropPaddingRatio: number

  constructor(options: RembgHttpSegmentationProviderOptions = {}) {
    this.#endpoint = normalizedEndpoint(options.endpoint ?? 'http://127.0.0.1:7000')
    const defaultModel = options.defaultModel ?? 'birefnet-general-lite'
    if (segmentationModels.has(defaultModel) === false) {
      throw new RangeError('Segmentation model has an unsupported value')
    }
    const timeoutMs = options.timeoutMs ?? 30_000
    if (Number.isFinite(timeoutMs) === false || timeoutMs <= 0) {
      throw new RangeError('Segmentation timeout must be a finite positive number')
    }
    const cropThreshold = options.cropThreshold ?? 0.5
    if (Number.isFinite(cropThreshold) === false || cropThreshold < 0 || cropThreshold > 1) {
      throw new RangeError('Segmentation crop threshold must stay within 0..1')
    }
    const cropPaddingRatio = options.cropPaddingRatio ?? 0.04
    if (Number.isFinite(cropPaddingRatio) === false || cropPaddingRatio < 0 || cropPaddingRatio > 0.25) {
      throw new RangeError('Segmentation crop padding must stay within 0..0.25')
    }
    this.#defaultModel = defaultModel
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#timeoutMs = timeoutMs
    this.#cropThreshold = cropThreshold
    this.#cropPaddingRatio = cropPaddingRatio
  }

  async segment(request: SegmentationRequest): Promise<SegmentationResult> {
    validateRequest(request)
    request.signal?.throwIfAborted()
    const startedAt = performance.now()
    const model = request.model ?? this.#defaultModel
    const form = new FormData()
    const image = await encodePng(request.image)
    request.signal?.throwIfAborted()
    form.append('file', new Blob([Uint8Array.from(image)], { type: 'image/png' }), 'input.png')
    form.append('model', model)
    form.append('om', 'true')
    form.append('ppm', String(request.postProcessMask ?? false))

    const controller = new AbortController()
    const forwardAbort = () => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', forwardAbort, { once: true })
    const timeout = setTimeout(
      () => controller.abort(new Error('Segmentation request timed out')),
      request.timeoutMs ?? this.#timeoutMs,
    )
    try {
      const response = await this.#fetch(`${this.#endpoint}/api/remove`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      })
      if (response.ok === false) {
        throw new Error(`rembg returned ${response.status}${await responseMessage(response)}`)
      }
      const contentLength = Number(response.headers.get('content-length') ?? 0)
      if (contentLength > maximumResponseBytes) throw new Error('rembg mask exceeds the response limit')
      const payload = await readResponseBytes(response, maximumResponseBytes)
      const mask = await decodeMask(payload)
      if (mask.width !== request.image.width || mask.height !== request.image.height) {
        throw new Error(`rembg mask dimensions ${mask.width}x${mask.height} differ from the source image`)
      }
      return {
        provider: 'rembg-http',
        model,
        analysis: analysisFromMask(
          mask,
          request.image,
          model,
          this.#cropThreshold,
          this.#cropPaddingRatio,
          request.imageTypeHint,
        ),
        elapsedMs: Math.max(0, performance.now() - startedAt),
      }
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', forwardAbort)
    }
  }
  async probe(signal?: AbortSignal): Promise<{
    status: 'ready' | 'degraded' | 'unavailable'
    latencyMs: number
    message?: string
  }> {
    signal?.throwIfAborted()
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', forwardAbort, { once: true })
    const timeout = setTimeout(
      () => controller.abort(new Error('rembg health probe timed out')),
      Math.min(this.#timeoutMs, 5_000),
    )
    const startedAt = performance.now()
    try {
      const response = await this.#fetch(`${this.#endpoint}/api`, {
        method: 'GET',
        signal: controller.signal,
      })
      if (response.body !== null) await response.body.cancel()
      return {
        status: response.ok ? 'ready' : 'unavailable',
        latencyMs: Math.max(0, performance.now() - startedAt),
        ...(response.ok ? {} : { message: `rembg returned ${response.status}` }),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        status: 'unavailable',
        latencyMs: Math.max(0, performance.now() - startedAt),
        message: message.replace(/\s+/g, ' ').trim().slice(0, 500),
      }
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', forwardAbort)
    }
  }
}
