import type {
  EvidenceProvenance,
  ImageAnalysis,
  ImageLandmark,
  PixelImage,
} from '@ai-bead-pattern/pattern-core'

export interface NormalizedFaceLandmark {
  x: number
  y: number
  z?: number
  visibility?: number
  presence?: number
}

export interface MediaPipeFaceCandidate {
  landmarks: readonly NormalizedFaceLandmark[]
  confidence: number
}

export type PrimaryFaceSelection =
  | { status: 'none' }
  | { status: 'ambiguous' }
  | { status: 'primary'; primaryFaceIndex: number }

export interface FaceLandmarkMappingOptions {
  width: number
  height: number
  modelVersion: string
}

export interface FaceLandmarkModelRequest {
  image: PixelImage
  signal?: AbortSignal
}

export interface FaceLandmarkModelResult {
  faces: readonly MediaPipeFaceCandidate[]
  modelVersion: string
}

export interface MediaPipeFaceLandmarkProviderOptions {
  detect(request: FaceLandmarkModelRequest): Promise<FaceLandmarkModelResult>
}

export type FaceLandmarkAnalysisResult = PrimaryFaceSelection & {
  analysis: ImageAnalysis
  faces: readonly MediaPipeFaceCandidate[]
  modelVersion: string
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function validateImage(image: PixelImage): void {
  if (Number.isInteger(image.width) === false || image.width <= 0
    || Number.isInteger(image.height) === false || image.height <= 0) {
    throw new RangeError('Face landmark image dimensions must be positive integers')
  }
  if (image.data.length !== image.width * image.height * 4) {
    throw new RangeError('Face landmark RGBA data length must equal width * height * 4')
  }
}

function validateCandidate(candidate: MediaPipeFaceCandidate): void {
  if (candidate.landmarks.length < 468) {
    throw new RangeError('MediaPipe face candidate must contain at least 468 landmarks')
  }
  if (Number.isFinite(candidate.confidence) === false
    || candidate.confidence < 0 || candidate.confidence > 1) {
    throw new RangeError('MediaPipe face confidence must stay within 0..1')
  }
  for (const landmark of candidate.landmarks) {
    if (Number.isFinite(landmark.x) === false || Number.isFinite(landmark.y) === false) {
      throw new RangeError('MediaPipe face landmarks must contain finite coordinates')
    }
  }
}

function faceArea(candidate: MediaPipeFaceCandidate): number {
  const left = candidate.landmarks[234]!
  const right = candidate.landmarks[454]!
  const top = candidate.landmarks[10]!
  const bottom = candidate.landmarks[152]!
  return Math.abs(right.x - left.x) * Math.abs(bottom.y - top.y)
}

export function selectPrimaryFace(
  faces: readonly MediaPipeFaceCandidate[],
  dominanceRatio = 1.35,
): PrimaryFaceSelection {
  if (Number.isFinite(dominanceRatio) === false || dominanceRatio <= 1) {
    throw new RangeError('Primary-face dominance ratio must be greater than 1')
  }
  if (faces.length === 0) return { status: 'none' }
  const scored = faces.map((face, index) => {
    validateCandidate(face)
    return { index, score: faceArea(face) * face.confidence }
  }).sort((first, second) => second.score - first.score || first.index - second.index)
  const first = scored[0]!
  if (first.score <= 0 || faces[first.index]!.confidence < 0.5) return { status: 'none' }
  const second = scored[1]
  if (second !== undefined && first.score < second.score * dominanceRatio) {
    return { status: 'ambiguous' }
  }
  return { status: 'primary', primaryFaceIndex: first.index }
}

function point(candidate: MediaPipeFaceCandidate, index: number): NormalizedFaceLandmark {
  const value = candidate.landmarks[index]
  if (value === undefined) throw new RangeError(`MediaPipe face landmark ${index} is missing`)
  return value
}

function average(
  candidate: MediaPipeFaceCandidate,
  firstIndex: number,
  secondIndex: number,
): NormalizedFaceLandmark {
  const first = point(candidate, firstIndex)
  const second = point(candidate, secondIndex)
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
}

export function mapMediaPipeFaceLandmarks(
  candidate: MediaPipeFaceCandidate,
  options: FaceLandmarkMappingOptions,
): readonly ImageLandmark[] {
  validateCandidate(candidate)
  if (Number.isInteger(options.width) === false || options.width <= 0
    || Number.isInteger(options.height) === false || options.height <= 0) {
    throw new RangeError('Face landmark source dimensions must be positive integers')
  }
  if (typeof options.modelVersion !== 'string' || options.modelVersion.trim().length === 0) {
    throw new TypeError('Face landmark model version must be a non-empty string')
  }
  const provenance: readonly EvidenceProvenance[] = [{
    origin: 'model',
    provider: 'mediapipe-face-landmarker',
    model: 'face-landmarker',
    version: options.modelVersion.trim(),
  }]
  const faceWidth = Math.abs(point(candidate, 454).x - point(candidate, 234).x) * options.width
  const irisAvailable = candidate.landmarks.length >= 478
  const definitions = [
    { id: 'chin', kind: 'face-contour' as const, point: point(candidate, 152), priority: 'soft' as const, radius: 0.025 },
    { id: 'face-left', kind: 'face-contour' as const, point: point(candidate, 454), priority: 'soft' as const, radius: 0.025, symmetryGroup: 'face-sides' },
    { id: 'face-right', kind: 'face-contour' as const, point: point(candidate, 234), priority: 'soft' as const, radius: 0.025, symmetryGroup: 'face-sides' },
    { id: 'left-eye-center', kind: 'eye' as const, point: irisAvailable ? point(candidate, 473) : average(candidate, 362, 263), priority: 'hard' as const, radius: 0.04, symmetryGroup: 'eyes' },
    { id: 'mouth-center', kind: 'mouth' as const, point: average(candidate, 13, 14), priority: 'hard' as const, radius: 0.035 },
    { id: 'mouth-left', kind: 'mouth' as const, point: point(candidate, 291), priority: 'hard' as const, radius: 0.025, symmetryGroup: 'mouth-corners' },
    { id: 'mouth-right', kind: 'mouth' as const, point: point(candidate, 61), priority: 'hard' as const, radius: 0.025, symmetryGroup: 'mouth-corners' },
    { id: 'nose-tip', kind: 'nose' as const, point: point(candidate, 1), priority: 'soft' as const, radius: 0.025 },
    { id: 'right-eye-center', kind: 'eye' as const, point: irisAvailable ? point(candidate, 468) : average(candidate, 33, 133), priority: 'hard' as const, radius: 0.04, symmetryGroup: 'eyes' },
  ]
  return definitions.map((definition) => ({
    id: definition.id,
    kind: definition.kind,
    x: clamp(definition.point.x, 0, 1) * options.width,
    y: clamp(definition.point.y, 0, 1) * options.height,
    confidence: candidate.confidence,
    priority: definition.priority,
    sourceRadiusPx: Math.max(1, faceWidth * definition.radius),
    gridRadiusCells: definition.kind === 'eye' ? 1 : 0,
    ...(definition.symmetryGroup === undefined ? {} : { symmetryGroup: definition.symmetryGroup }),
    carrierRegionId: 'face-skin',
    affectsOccupancy: false,
    provenance,
  }))
}

export class MediaPipeFaceLandmarkProvider {
  readonly #detect: MediaPipeFaceLandmarkProviderOptions['detect']

  constructor(options: MediaPipeFaceLandmarkProviderOptions) {
    if (typeof options?.detect !== 'function') {
      throw new TypeError('MediaPipe face landmark provider requires a detect function')
    }
    this.#detect = options.detect
  }

  async analyze(request: FaceLandmarkModelRequest): Promise<FaceLandmarkAnalysisResult> {
    validateImage(request.image)
    request.signal?.throwIfAborted()
    const modelResult = await this.#detect({
      image: request.image,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    request.signal?.throwIfAborted()
    if (typeof modelResult.modelVersion !== 'string'
      || modelResult.modelVersion.trim().length === 0) {
      throw new TypeError('Face landmark model version must be a non-empty string')
    }
    const selection = selectPrimaryFace(modelResult.faces)
    if (selection.status !== 'primary') {
      return {
        ...selection,
        analysis: {},
        faces: modelResult.faces,
        modelVersion: modelResult.modelVersion.trim(),
      }
    }
    const face = modelResult.faces[selection.primaryFaceIndex]!
    const landmarks = mapMediaPipeFaceLandmarks(face, {
      width: request.image.width,
      height: request.image.height,
      modelVersion: modelResult.modelVersion,
    })
    return {
      ...selection,
      analysis: {
        landmarks,
        imageType: 'portrait',
        confidence: face.confidence,
        modelVersions: { faceLandmarks: `mediapipe/${modelResult.modelVersion.trim()}` },
        provenance: landmarks.flatMap((landmark) => landmark.provenance ?? []),
      },
      faces: modelResult.faces,
      modelVersion: modelResult.modelVersion.trim(),
    }
  }
}
