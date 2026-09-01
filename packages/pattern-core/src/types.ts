import type {
  CanvasPlan,
  PalettePlan,
  StructurePlan,
  ValuePlan,
} from './contracts.js'
import type { ResolvedFeaturePlacement } from './planning/feature-placement.js'
import type {
  ArtDirectionExecutionSummary,
  PixelArtDirectionPlan,
} from './art-direction.js'

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

export type MaterialInventory = Readonly<Record<string, number>>
export type MaterialSubstitutionMap = Readonly<Record<string, readonly string[]>>

export interface MaterialPalette {
  id: string
  name: string
  colors: readonly MaterialColor[]
  /** Missing color ids represent unrestricted stock; supplied values are bead counts. */
  inventory?: MaterialInventory
  /** Ordered physical substitutes keyed by the preferred color id. */
  substituteColorIds?: MaterialSubstitutionMap
}

export type ImageType = 'portrait' | 'pet' | 'illustration' | 'landscape' | 'general'
/** Sampling modes; cell-aware follows the learned cell/aliasing split with a deterministic fallback. */
export type ResizeMethod = 'area' | 'bilinear' | 'nearest' | 'cell-aware'
export type ColorDistanceMethod = 'delta-e-76' | 'delta-e-2000'
export type PatternStyle = 'faithful' | 'cute' | 'simple' | 'high-contrast' | 'soft'
export type BaselineMode = 'a0' | 'a1' | 'mvp'
export type AlgorithmEngine = 'baseline'
export type GridRefinementMode = 'fast' | 'quality'

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
  refinementMode?: GridRefinementMode
}

export interface StructureOptions {
  importanceStrength?: number
  edgeStrength?: number
  valueLevels?: 2 | 3 | 4
  occupancyMode?: 'auto' | 'full-frame' | 'subject-shape'
  shapeRefinementIterations?: number
}

export interface ArtDirectionOptions {
  focus?: readonly [number, number]
  lightDirection?: readonly [number, number]
  depthRange?: readonly [number, number]
  mode?: 'single' | 'tile' | 'animation-frame'
  tileEdges?: Readonly<Record<'top' | 'right' | 'bottom' | 'left', string>>
  frame?: {
    poseVisibility: number
    actionArc: number
    sharedPaletteId: string
    sharedGridId?: string
  }
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
  artDirection?: ArtDirectionOptions
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
    | 'feature-placement' | 'cluster-refinement' | 'symmetry' | 'tile-seam'
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
  hardFeatureCompleteness: number
  featureCollisionCount: number
  featureSymmetryError: number
  sourceBoundaryAgreement: number
  planBoundaryAgreement: number
  referenceMeanColorDistance: number
  referenceBoundaryAgreement: number
  valueOrderAccuracy: number
  paletteRoleConsistency: number
  paletteOptimizationChanges: number
  gridRefinementChanges: number
  symmetryQuality: number
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
  artDirectionImportanceChanges: number
  artDirectionBackgroundCompressedCells: number
  artDirectionBudgetViolations: number
  transitionCells: number
  colorSwitches: number
  localNoiseCells: number
  ditherPatterns: number
  tileSeamMismatches: number
  tileSeamEdits: number
}

export interface GridRefinementBudgets {
  transitionCells: number
  ditherPatterns: number
  maximumColorSwitches: number
  localNoiseCells: number
}

export interface GridBudgetViolations {
  transitionCells: number
  ditherPatterns: number
  colorSwitches: number
  localNoiseCells: number
  total: number
}

export interface GridRefinementSummary {
  mode: GridRefinementMode
  changedCells: number
  energyBefore: number
  energyAfter: number
  iterations: number
  diagnosticsBefore: GridClusterDiagnostics
  diagnosticsAfter: GridClusterDiagnostics
  budgets?: GridRefinementBudgets
  budgetViolationsBefore: GridBudgetViolations
  budgetViolationsAfter: GridBudgetViolations
}

export interface GridClusterDiagnostics {
  fragmentedArcSegments: number
  smallComponents: number
  singleCellBands: number
  transitionCells: number
  colorSwitches: number
  localNoiseCells: number
  ditherPatterns: number
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
  silhouette: number
  identity: number
  identityAppearance?: number
  valueHierarchy: number
  pixelClusters: number
  craftCost: number
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
  /** @experimental Region graph, bounded source mapping, and feature constraints. */
  structurePlan?: StructurePlan
  /** @experimental Region-level light, base, shadow, and outline roles. */
  valuePlan?: ValuePlan
  /** @experimental Global material-color subset and role assignments. */
  palettePlan?: PalettePlan
  /** @experimental Unified cluster cleanup diagnostics. */
  gridRefinement?: GridRefinementSummary
  /** @experimental Executable scale, style, scene, material, outline, tile, animation, and craft budgets. */
  artDirection?: PixelArtDirectionPlan
  /** @experimental Summary of explicit art-direction changes applied to this candidate. */
  artDirectionExecution?: ArtDirectionExecutionSummary
  edits: readonly GridEditRecord[]
}

export interface CandidateEvaluation {
  rankedCandidateIds: readonly string[]
  scores: Readonly<Record<string, CandidateScore>>
  /** Present when rule, neural, and learned-preference evidence has been fused. */
  version?: 2
  ruleRankedCandidateIds?: readonly string[]
  learnedRankedCandidateIds?: readonly string[]
  finalRankedCandidateIds?: readonly string[]
  candidateScores?: Readonly<Record<string, CandidateEvaluationScoreV2>>
  neuralPreferenceFeatures?: readonly CandidateNeuralPreferenceFeatures[]
  providerContributions?: readonly CandidateProviderContribution[]
  sourceWeights?: CandidateEvaluationSourceWeights
  appliedSourceWeights?: CandidateEvaluationSourceWeights
  selectedModel?: CandidateEvaluationModelIdentity
}

export interface CandidateEvaluationSourceWeights {
  rule: number
  neural: number
  humanPreference: number
}

export interface CandidateEvaluationModelIdentity {
  name: string
  version: string
}

export interface CandidateEvaluationScoreV2 {
  rule: number
  neural: number
  humanPreference: number
  final: number
}

export interface CandidateNeuralPreferenceFeatures {
  providerId: string
  modelId: string
  candidateId?: string
  names: readonly string[]
  values: readonly number[]
  confidence: number
}

export interface CandidateProviderContribution {
  providerId: string
  modelId: string
  capabilities: readonly string[]
  status: 'used' | 'failed'
  confidence?: number
  elapsedMs: number
  message?: string
}

export interface SelectedPreferenceRankingInput {
  rankedCandidateIds: readonly string[]
  scores: Readonly<Record<string, number>>
  model: CandidateEvaluationModelIdentity
}

export interface CandidateEvaluationV2 extends CandidateEvaluation {
  version: 2
  ruleRankedCandidateIds: readonly string[]
  learnedRankedCandidateIds: readonly string[]
  finalRankedCandidateIds: readonly string[]
  candidateScores: Readonly<Record<string, CandidateEvaluationScoreV2>>
  neuralPreferenceFeatures: readonly CandidateNeuralPreferenceFeatures[]
  providerContributions: readonly CandidateProviderContribution[]
  sourceWeights: CandidateEvaluationSourceWeights
  appliedSourceWeights: CandidateEvaluationSourceWeights
}

export interface CandidateEvaluationV2Input {
  scores: Readonly<Record<string, CandidateScore>>
  selectedPreferenceRanking?: SelectedPreferenceRankingInput
  neuralPreferenceFeatures?: readonly CandidateNeuralPreferenceFeatures[]
  providerContributions?: readonly CandidateProviderContribution[]
  sourceWeights?: CandidateEvaluationSourceWeights
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
