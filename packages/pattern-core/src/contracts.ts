import type {
  BinaryMask,
  CropRect,
  GridSize,
  Lab,
  LandmarkKind,
} from './types.js'

export type OccupancyMode = 'full-frame' | 'subject-shape' | 'solid-background'

export interface CanvasPlanScore {
  total: number
  feature: number
  subject: number
  composition: number
  boundary: number
  beadCost: number
  buildTimeCost: number
}

export interface FeatureBudget {
  featureId: string
  kind: LandmarkKind
  minimumCells: number
  preferredCells: number
  maximumCells: number
  minimumContrast: number
  allowedShiftCells: number
  symmetryGroup?: string
  confidence: number
}

export interface CanvasPlan {
  id: string
  size: GridSize
  crop: CropRect
  occupancyMode: OccupancyMode
  subjectCoverage: number
  estimatedBeads: number
  estimatedWidthMm?: number
  estimatedHeightMm?: number
  featureBudgets: readonly FeatureBudget[]
  score: CanvasPlanScore
}

export interface FeatureConstraint {
  id: string
  kind: LandmarkKind
  sourceCenter: readonly [number, number]
  targetCenter: readonly [number, number]
  candidateTemplates: readonly string[]
  minimumCells: number
  maximumCells: number
  allowedShiftCells: number
  minimumContrastDeltaE: number
  hard: boolean
  symmetryGroup?: string
}

export interface StructureRegion {
  id: number
  sourceRegionId?: string
  label?: string
  importance: number
  cellIndices: readonly number[]
  adjacentRegionIds: readonly number[]
}

export interface StructurePlan {
  width: number
  height: number
  occupancy: BinaryMask
  /** Two floats per grid cell: source x followed by source y. */
  sourceMapping: Float32Array
  regionIds: Int32Array
  boundaryStrength: Float32Array
  regions: readonly StructureRegion[]
  featureConstraints: readonly FeatureConstraint[]
  confidence: number
}

export type ValueRoleKind =
  | 'highlight'
  | 'light'
  | 'base'
  | 'shadow'
  | 'deep-shadow'
  | 'outline'

export interface ValueRole {
  id: string
  regionId: string
  kind: ValueRoleKind
  targetLightness: number
  minimumSeparation: number
  importance: number
}

export interface ValuePlan {
  roles: readonly ValueRole[]
}

export interface ColorRole {
  id: string
  regionId: string
  valueRoleId: string
  idealLab: Lab
  allowedHueShift: number
  mayShareColor: boolean
  importance: number
}

export interface PalettePlan {
  selectedColorIds: readonly string[]
  assignments: Readonly<Record<string, string>>
  allowedColorIdsByRole: Readonly<Record<string, readonly string[]>>
  totalCost: number
}

export interface CandidateMetricsV2 {
  sourceFidelity: number
  featureVisibility: number
  silhouetteQuality: number
  semanticBoundaryQuality: number
  regionAdjacencyPreservation: number
  valueOrderAccuracy: number
  paletteRoleConsistency: number
  clusterCleanliness: number
  symmetryQuality: number
  craftComplexity: number
  estimatedBuildMinutes: number
}
