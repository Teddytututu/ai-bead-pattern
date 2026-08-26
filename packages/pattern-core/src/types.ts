import type { CanvasPlan } from './contracts.js'
import type { ResolvedFeaturePlacement } from './planning/feature-placement.js'

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
export type AlgorithmEngine = 'baseline'

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
  paletteCoherence?: number
  localSearchIterations?: number
  aliasPenalty?: number
}

export interface StructureOptions {
  importanceStrength?: number
  edgeStrength?: number
  valueLevels?: 2 | 3 | 4
  occupancyMode?: 'auto' | 'full-frame' | 'subject-shape'
  shapeRefinementIterations?: number
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
  structure?: StructureOptions
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

export type EvidenceOrigin = 'model' | 'source' | 'heuristic' | 'manual' | 'fused'

export interface EvidenceProvenance {
  origin: EvidenceOrigin
  provider: string
  model?: string
  version?: string
}

export type SubjectMaskSource =
  | 'ai'
  | 'alpha'
  | 'heuristic'
  | 'manual'
  | 'ai+manual'
  | 'fused'
  | 'legacy'

export interface SubjectMaskEvidence {
  mask: BinaryMask
  confidence: number
  source: SubjectMaskSource
  revision: string
  userConfirmed?: boolean
  provenance?: readonly EvidenceProvenance[]
}

export interface SemanticRegion {
  id: string
  label: string
  mask: BinaryMask
  confidence: number
  importance?: number
  provenance?: readonly EvidenceProvenance[]
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
  /** Radius in source-image pixels for importance-map expansion. */
  sourceRadiusPx?: number
  /** Radius in output grid cells for feature constraints and hard locks. */
  gridRadiusCells?: number
  /** @deprecated Prefer sourceRadiusPx and gridRadiusCells. */
  radius?: number
  symmetryGroup?: string
  /** Semantic region occupied by the feature itself. */
  featureRegionId?: string
  /** Semantic region that visually carries the feature, such as face around an eye. */
  carrierRegionId?: string
  /** Allows a silhouette anchor to add occupied subject cells. Internal features leave this unset. */
  affectsOccupancy?: boolean
  provenance?: readonly EvidenceProvenance[]
}

export interface ImageAnalysis {
  /** Compatibility field. Prefer subjectMaskEvidence for new integrations. */
  subjectMask?: BinaryMask
  /** Authoritative subject-mask evidence when both mask fields are present. */
  subjectMaskEvidence?: SubjectMaskEvidence
  semanticRegions?: readonly SemanticRegion[]
  landmarks?: readonly ImageLandmark[]
  importanceMap?: ImportanceMap
  suggestedCrop?: CropRect
  suggestedCropConfidence?: number
  suggestedCropSource?: 'automatic' | 'manual'
  imageType?: ImageType
  confidence?: number
  /** Stable model names and versions used to produce this analysis. */
  modelVersions?: Readonly<Record<string, string>>
  provenance?: readonly EvidenceProvenance[]
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
  engine?: AlgorithmEngine
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
  reason: 'small-region' | 'isolated-cell' | 'stripe' | 'topology' | 'palette-coherence'
    | 'feature-placement'
}

export interface GenerationMetrics {
  /** Time spent on this candidate after shared planning has completed. */
  processingTimeMs: number
  uniqueColors: number
  removedSmallRegions: number
  totalBeads: number
  meanColorDistance: number
  sourceMeanColorDistance: number
  planMeanColorDistance: number
  isolatedCells: number
  thinStripes: number
  featureExpressibility: number
  featureVisibilityConfidence: number
  featureCoverage: number
  featurePurity: number
  featureConnectivity: number
  featureLocalContrast: number
  sourceBoundaryAgreement: number
  planBoundaryAgreement: number
  referenceMeanColorDistance: number
  referenceBoundaryAgreement: number
  paletteOptimizationChanges: number
  topologyEdits: number
  shapeApplied: boolean
  subjectOccupancyRatio: number
  silhouetteBoundaryIoU: number
  subjectCoverageIoU: number
  shapeMeanBoundaryDistance: number
  referenceShapeComponents: number
  targetShapeComponents: number
  referenceShapeHoles: number
  targetShapeHoles: number
  shapeEdits: number
}

export interface GenerationTiming {
  /** End-to-end pattern-core generation time, including shared planning and ranking. */
  coreTotalMs: number
  shapeModelMs: number
  shapePlanningMs: number
  canvasPlanningMs: number
  candidateGenerationMs: number
}

export interface CandidateScore {
  total: number
  colorFidelity: number
  sourceFidelity: number
  planFidelity: number
  structure: number
  featureProtection: number
  featureProtectionConfidence: number
  cleanliness: number
  craftEase: number
  canvasFit: number
}

export interface PatternCandidate {
  id: string
  generationId: string
  variantId: string
  style: PatternStyle
  valid: boolean
  rejectionReasons: readonly string[]
  pattern: BeadPattern
  materialCounts: readonly MaterialCount[]
  metrics: GenerationMetrics
  score: CandidateScore
  /** @experimental Executable V2 planning diagnostics for this candidate. */
  canvasPlan?: CanvasPlan
  /** @experimental Discrete feature placements resolved before color quantization. */
  featurePlacements?: readonly ResolvedFeaturePlacement[]
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

export type GenerationStatus = 'success' | 'best-effort' | 'no-valid-candidate'

interface PatternGenerationResultBase {
  status: GenerationStatus
  generationId: string
  timing: GenerationTiming
  /** Compatibility aliases exist only when a valid recommendation exists. */
  pattern?: BeadPattern
  materialCounts?: readonly MaterialCount[]
  metrics?: GenerationMetrics
  recommended?: PatternCandidate
  bestEffort?: PatternCandidate
  alternatives: readonly PatternCandidate[]
  rejectedCandidates: readonly PatternCandidate[]
  evaluation: CandidateEvaluation
}

export interface PatternGenerationSuccess extends PatternGenerationResultBase {
  status: 'success'
  pattern: BeadPattern
  materialCounts: readonly MaterialCount[]
  metrics: GenerationMetrics
  recommended: PatternCandidate
}

export interface PatternGenerationBestEffort extends PatternGenerationResultBase {
  status: 'best-effort'
  bestEffort: PatternCandidate
}

export interface PatternGenerationNoValidCandidate extends PatternGenerationResultBase {
  status: 'no-valid-candidate'
}

export type PatternGenerationResult =
  | PatternGenerationSuccess
  | PatternGenerationBestEffort
  | PatternGenerationNoValidCandidate

export interface PatternAdaptationRequest {
  pattern: BeadPattern
  palette: MaterialPalette
  /** Actual colors in cells that have already been fabricated. */
  fixedCells: readonly PatternCell[]
  /** Values above 0.5 mark cells that may be replanned. */
  editableMask?: BinaryMask
  maxChangedCells?: number
  coherence?: number
}

export interface PatternAdaptationChange {
  x: number
  y: number
  fromColorId: string
  toColorId: string
}

export interface MaterialDelta {
  colorId: string
  delta: number
}

export interface PatternAdaptationResult {
  pattern: BeadPattern
  changes: readonly PatternAdaptationChange[]
  fixedCellsPreserved: number
  visualDeviation: number
  materialDelta: readonly MaterialDelta[]
}
