import sharp from 'sharp'

import type {
  BinaryMask,
  CropRect,
  ImageAnalysis,
  PixelImage,
} from '@ai-bead-pattern/pattern-core'

export type SegmentationModel =
  | 'birefnet-general-lite'
  | 'birefnet-general'
  | 'birefnet-portrait'
  | 'isnet-general-use'

export interface SegmentationRequest {
  image: PixelImage
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

function maskConfidence(values: Float32Array): number {
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
  model: SegmentationModel,
  cropThreshold: number,
  cropPaddingRatio: number,
): ImageAnalysis {
  const subjectMask: BinaryMask = {
    width: mask.width,
    height: mask.height,
    values: mask.values,
  }
  const confidence = maskConfidence(mask.values)
  const crop = subjectCrop(mask, cropThreshold, cropPaddingRatio)
  const analysis: ImageAnalysis = {
    confidence,
    subjectMask,
    importanceMap: {
      width: mask.width,
      height: mask.height,
      weights: boundaryImportance(mask),
    },
    semanticRegions: [{
      id: 'subject',
      label: 'subject',
      confidence,
      importance: 0.8,
      mask: subjectMask,
    }],
    modelVersions: { segmentation: `rembg/${model}` },
  }
  if (crop !== undefined) {
    analysis.suggestedCrop = crop
    analysis.suggestedCropSource = 'automatic'
    analysis.suggestedCropConfidence = confidence
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
    form.append('ppm', String(request.postProcessMask ?? true))

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
        analysis: analysisFromMask(mask, model, this.#cropThreshold, this.#cropPaddingRatio),
        elapsedMs: Math.max(0, performance.now() - startedAt),
      }
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', forwardAbort)
    }
  }
}
