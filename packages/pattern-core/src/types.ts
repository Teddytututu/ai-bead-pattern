export type RGB = readonly [red: number, green: number, blue: number]

export type Lab = readonly [lightness: number, a: number, b: number]

export interface PixelImage {
  width: number
  height: number
  /** Row-major RGBA bytes. The expected length is width * height * 4. */
  data: Uint8ClampedArray
}

export interface MaterialColor {
  id: string
  name: string
  hex: string
  rgb: RGB
  lab?: Lab
}

export interface MaterialPalette {
  id: string
  name: string
  colors: readonly MaterialColor[]
}

export type ImageType = 'portrait' | 'pet' | 'illustration' | 'landscape' | 'general'
export type ResizeMethod = 'area' | 'bilinear' | 'nearest'
export type ColorDistanceMethod = 'delta-e-76' | 'delta-e-2000'
export type PatternStyle = 'faithful' | 'cute' | 'simple' | 'high-contrast' | 'soft'
export type BaselineMode = 'a0' | 'a1' | 'mvp'

export interface GridSize {
  width: number
  height: number
}

export type CanvasOptions =
  | { mode: 'auto'; candidates: readonly GridSize[] }
  | { mode: 'fixed'; size: GridSize }

export interface OptimizationOptions {
  minRegionSize?: number
  isolatedPixelPenalty?: number
  edgeProtection?: number
  stripePenalty?: number
}

export interface PatternOptions {
  /** Legacy fixed-size fields. Prefer canvas for new integrations. */
  width?: number
  height?: number
  canvas?: CanvasOptions
  maxColors: number
  maxCandidates?: number
  styles?: readonly PatternStyle[]
  imageType?: ImageType
  resizeMethod?: ResizeMethod
  colorDistanceMethod?: ColorDistanceMethod
  baseline?: BaselineMode
  backgroundRgb?: RGB
  aiEnhancement?: boolean
  optimization?: OptimizationOptions
  beadDiameterMm?: number
}

export interface ImportanceMap {
  width: number
  height: number
  /** Row-major weights in the inclusive range 0..1. */
  weights: Float32Array
}

export interface BinaryMask {
  width: number
  height: number
  /** Row-major mask values in the inclusive range 0..1. */
  values: Float32Array
}

export interface SemanticRegion {
  id: string
  label: string
  mask: BinaryMask
  confidence: number
  importance?: number
}

export type LandmarkKind =
  | 'eye'
  | 'mouth'
  | 'nose'
  | 'ear'
  | 'face-contour'
  | 'body'
  | 'identity-mark'
  | 'custom'

export type LandmarkPriority = 'hard' | 'soft'

export interface ImageLandmark {
  id: string
  kind: LandmarkKind
  x: number
  y: number
  confidence: number
  priority: LandmarkPriority
  radius?: number
  symmetryGroup?: string
}

export interface ImageAnalysis {
  subjectMask?: BinaryMask
  semanticRegions?: readonly SemanticRegion[]
  landmarks?: readonly ImageLandmark[]
  importanceMap?: ImportanceMap
  suggestedCrop?: CropRect
  imageType?: ImageType
  confidence?: number
}

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PatternCell {
  x: number
  y: number
  colorId: string
}

export interface PatternMetadata {
  sourceWidth: number
  sourceHeight: number
  /** Occupied grid cells. Blank fitted margins are excluded. */
  totalBeads: number
  generatedAt: number
  algorithmVersion: string
  aiEnhanced: boolean
  style: PatternStyle
  baseline: BaselineMode
  aiProvider?: string
  aiModel?: string
  beadDiameterMm?: number
}

export interface BeadPattern {
  width: number
  height: number
  palette: readonly MaterialColor[]
  /** Occupied beads only. Missing grid coordinates represent blank board space. */
  cells: readonly PatternCell[]
  metadata: PatternMetadata
}

export interface MaterialCount {
  colorId: string
  count: number
}

export interface GridEditRecord {
  x: number
  y: number
  fromColorId: string
  toColorId: string
  reason: 'small-region' | 'isolated-cell' | 'stripe' | 'topology'
}

export interface GenerationMetrics {
  processingTimeMs: number
  uniqueColors: number
  removedSmallRegions: number
  totalBeads: number
  meanColorDistance: number
  isolatedCells: number
  thinStripes: number
}

export interface CandidateScore {
  total: number
  colorFidelity: number
  structure: number
  featureProtection: number
  cleanliness: number
  craftEase: number
  canvasFit: number
}

export interface PatternCandidate {
  id: string
  style: PatternStyle
  pattern: BeadPattern
  materialCounts: readonly MaterialCount[]
  metrics: GenerationMetrics
  score: CandidateScore
  edits: readonly GridEditRecord[]
}

export interface CandidateEvaluation {
  rankedCandidateIds: readonly string[]
  scores: Readonly<Record<string, CandidateScore>>
}

export interface PatternGenerationRequest {
  image: PixelImage
  palette: MaterialPalette
  options: PatternOptions
  analysis?: ImageAnalysis
}

export interface PatternGenerationResult {
  /** Compatibility aliases for the recommended candidate. */
  pattern: BeadPattern
  materialCounts: readonly MaterialCount[]
  metrics: GenerationMetrics
  recommended: PatternCandidate
  alternatives: readonly PatternCandidate[]
  evaluation: CandidateEvaluation
}
