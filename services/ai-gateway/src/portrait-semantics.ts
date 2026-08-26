import {
  resolvedSubjectMask,
  subjectMaskConfidence,
  type BinaryMask,
  type EvidenceProvenance,
  type ImageAnalysis,
  type PixelImage,
  type SemanticRegion,
} from '@ai-bead-pattern/pattern-core'

export type PortraitSemanticLabel = 'hair' | 'face-skin' | 'body-skin' | 'clothes'

export type PortraitSemanticCategories = Readonly<Record<
  PortraitSemanticLabel,
  Float32Array
>>

export interface PortraitSemanticMappingInput {
  subjectAnalysis: ImageAnalysis
  width: number
  height: number
  categories: PortraitSemanticCategories
  modelVersion: string
}

export interface PortraitSemanticModelRequest {
  image: PixelImage
  signal?: AbortSignal
}

export interface PortraitSemanticModelResult {
  width: number
  height: number
  categories: PortraitSemanticCategories
  modelVersion: string
}

export interface MediaPipePortraitSemanticProviderOptions {
  segment(request: PortraitSemanticModelRequest): Promise<PortraitSemanticModelResult>
}

export interface PortraitSemanticProviderRequest extends PortraitSemanticModelRequest {
  subjectAnalysis: ImageAnalysis
}

export interface PortraitSemanticAnalysisResult {
  analysis: ImageAnalysis
  modelVersion: string
}

const importance: Readonly<Record<PortraitSemanticLabel, number>> = {
  hair: 0.9,
  'face-skin': 1,
  'body-skin': 0.7,
  clothes: 0.55,
}

const semanticLabels = ['face-skin', 'hair', 'body-skin', 'clothes'] as const

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function intersectMask(subject: BinaryMask, values: Float32Array): BinaryMask | undefined {
  if (values.length !== subject.values.length) {
    throw new RangeError('Portrait semantic category dimensions differ from the subject mask')
  }
  const output = new Float32Array(values.length)
  let maximum = 0
  for (let index = 0; index < output.length; index += 1) {
    const value = clamp(values[index] ?? 0) * clamp(subject.values[index] ?? 0)
    output[index] = value
    maximum = Math.max(maximum, value)
  }
  if (maximum <= 0) return undefined
  return { width: subject.width, height: subject.height, values: output }
}

function maskConfidence(mask: BinaryMask): number {
  let total = 0
  let count = 0
  for (const value of mask.values) {
    if (value <= 0) continue
    total += value
    count += 1
  }
  return count === 0 ? 0 : total / count
}

export function mapPortraitSemanticRegions(input: PortraitSemanticMappingInput): ImageAnalysis {
  if (Number.isInteger(input.width) === false || input.width <= 0
    || Number.isInteger(input.height) === false || input.height <= 0) {
    throw new RangeError('Portrait semantic dimensions must be positive integers')
  }
  const subject = resolvedSubjectMask(input.subjectAnalysis)
  if (subject === undefined) throw new RangeError('Portrait semantics require authoritative subject evidence')
  if (subject.width !== input.width || subject.height !== input.height) {
    throw new RangeError('Portrait semantic dimensions differ from the subject mask')
  }
  if (typeof input.modelVersion !== 'string' || input.modelVersion.trim().length === 0) {
    throw new TypeError('Portrait semantic model version must be a non-empty string')
  }
  const expectedLength = input.width * input.height
  for (const label of semanticLabels) {
    const values = input.categories?.[label]
    if ((values instanceof Float32Array) === false) {
      throw new TypeError(`Portrait semantic category ${label} must be a Float32Array`)
    }
    if (values.length !== expectedLength) {
      throw new RangeError(`Portrait semantic category ${label} dimensions differ from the source image`)
    }
    for (const value of values) {
      if (Number.isFinite(value) === false) {
        throw new RangeError(`Portrait semantic category ${label} must contain finite values`)
      }
    }
  }
  const provenance: readonly EvidenceProvenance[] = [{
    origin: 'model',
    provider: 'mediapipe-selfie-multiclass',
    model: 'selfie-multiclass',
    version: input.modelVersion.trim(),
  }]
  const subjectRegion: SemanticRegion = {
    id: 'subject',
    label: 'subject',
    mask: subject,
    confidence: subjectMaskConfidence(input.subjectAnalysis),
    importance: 0.8,
    ...(input.subjectAnalysis.subjectMaskEvidence?.provenance === undefined
      ? {}
      : { provenance: input.subjectAnalysis.subjectMaskEvidence.provenance }),
  }
  const regions: SemanticRegion[] = [subjectRegion]
  for (const label of semanticLabels) {
    const mask = intersectMask(subject, input.categories[label])
    if (mask === undefined) continue
    regions.push({
      id: label,
      label,
      mask,
      confidence: maskConfidence(mask),
      importance: importance[label],
      provenance,
    })
  }
  return {
    semanticRegions: regions,
    imageType: 'portrait',
    confidence: regions.length === 1
      ? subjectRegion.confidence
      : regions.slice(1).reduce((sum, region) => sum + region.confidence, 0) / (regions.length - 1),
    modelVersions: { portraitSemantics: `mediapipe/${input.modelVersion.trim()}` },
    provenance,
  }
}

export class MediaPipePortraitSemanticProvider {
  readonly #segment: MediaPipePortraitSemanticProviderOptions['segment']

  constructor(options: MediaPipePortraitSemanticProviderOptions) {
    if (typeof options?.segment !== 'function') {
      throw new TypeError('MediaPipe portrait semantic provider requires a segment function')
    }
    this.#segment = options.segment
  }

  async analyze(request: PortraitSemanticProviderRequest): Promise<PortraitSemanticAnalysisResult> {
    if (Number.isInteger(request.image.width) === false || request.image.width <= 0
      || Number.isInteger(request.image.height) === false || request.image.height <= 0
      || request.image.data.length !== request.image.width * request.image.height * 4) {
      throw new RangeError('Portrait semantic image must contain valid RGBA dimensions')
    }
    request.signal?.throwIfAborted()
    const modelResult = await this.#segment({
      image: request.image,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    request.signal?.throwIfAborted()
    if (modelResult.width !== request.image.width || modelResult.height !== request.image.height) {
      throw new RangeError('Portrait semantic model dimensions differ from the source image')
    }
    const analysis = mapPortraitSemanticRegions({
      subjectAnalysis: request.subjectAnalysis,
      width: modelResult.width,
      height: modelResult.height,
      categories: modelResult.categories,
      modelVersion: modelResult.modelVersion,
    })
    return { analysis, modelVersion: modelResult.modelVersion.trim() }
  }
}
