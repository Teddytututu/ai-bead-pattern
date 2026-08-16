import type {
  BinaryMask,
  CropRect,
  GridSize,
  Lab,
  LandmarkKind,
} from './types.js'

/** @experimental V2 planning contract; fields may change before the V2 engine ships. */
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
  /** Absolute source-image pixel coordinates. */
  sourceCenter: readonly [number, number]
  /** Floating-point target-grid coordinates. */
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
  /** Two absolute source-image pixel coordinates per grid cell: x followed by y. */
  sourceMapping: Float32Array
  regionIds: Int32Array
  /** Per-cell boundary strength in the inclusive range 0..1. */
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

export interface MetricValue {
  value: number
  confidence: number
  available: boolean
}

export interface CandidateMetricsV2 {
  sourceFidelity: MetricValue
  featureVisibility: MetricValue
  silhouetteQuality: MetricValue
  semanticBoundaryQuality: MetricValue
  regionAdjacencyPreservation: MetricValue
  valueOrderAccuracy: MetricValue
  paletteRoleConsistency: MetricValue
  clusterCleanliness: MetricValue
  symmetryQuality: MetricValue
  craftComplexity: MetricValue
  estimatedBuildMinutes: MetricValue
}

function assertFinite(value: number, label: string): void {
  if (Number.isFinite(value) === false) throw new RangeError(`${label} must be finite`)
}

function assertUnitInterval(value: number, label: string): void {
  assertFinite(value, label)
  if (value < 0 || value > 1) throw new RangeError(`${label} must stay within 0..1`)
}

export function validateCanvasPlan(plan: CanvasPlan): void {
  if (Number.isInteger(plan.size.width) === false || plan.size.width <= 0
    || Number.isInteger(plan.size.height) === false || plan.size.height <= 0) {
    throw new RangeError('Canvas plan size must contain positive integers')
  }
  for (const [label, value] of Object.entries(plan.crop)) assertFinite(value, `Canvas crop ${label}`)
  if (plan.crop.width <= 0 || plan.crop.height <= 0) {
    throw new RangeError('Canvas crop dimensions must be positive')
  }
  assertUnitInterval(plan.subjectCoverage, 'Canvas subject coverage')
  assertFinite(plan.estimatedBeads, 'Canvas estimated beads')
  if (plan.estimatedBeads < 0) throw new RangeError('Canvas estimated beads must be non-negative')
  for (const budget of plan.featureBudgets) {
    if (budget.minimumCells < 0
      || budget.minimumCells > budget.preferredCells
      || budget.preferredCells > budget.maximumCells) {
      throw new RangeError(`Feature budget ${budget.featureId} must satisfy minimum <= preferred <= maximum`)
    }
    assertUnitInterval(budget.confidence, `Feature budget ${budget.featureId} confidence`)
    assertFinite(budget.minimumContrast, `Feature budget ${budget.featureId} contrast`)
    assertFinite(budget.allowedShiftCells, `Feature budget ${budget.featureId} shift`)
  }
  for (const [label, value] of Object.entries(plan.score)) assertUnitInterval(value, `Canvas score ${label}`)
}

export function validateStructurePlan(plan: StructurePlan): void {
  if (Number.isInteger(plan.width) === false || plan.width <= 0
    || Number.isInteger(plan.height) === false || plan.height <= 0) {
    throw new RangeError('Structure plan dimensions must contain positive integers')
  }
  const cells = plan.width * plan.height
  if (plan.occupancy.width !== plan.width || plan.occupancy.height !== plan.height
    || plan.occupancy.values.length !== cells) {
    throw new RangeError('Structure occupancy must align with the target grid')
  }
  if (plan.sourceMapping.length !== cells * 2) {
    throw new RangeError('Structure sourceMapping must contain two coordinates per cell')
  }
  if (plan.regionIds.length !== cells) throw new RangeError('Structure regionIds must align with the target grid')
  if (plan.boundaryStrength.length !== cells) {
    throw new RangeError('Structure boundaryStrength must align with the target grid')
  }
  for (const value of plan.occupancy.values) assertUnitInterval(value, 'Structure occupancy value')
  for (const value of plan.sourceMapping) assertFinite(value, 'Structure source mapping coordinate')
  for (const value of plan.boundaryStrength) assertUnitInterval(value, 'Structure boundary strength')
  const validRegionIds = new Set(plan.regions.map((region) => region.id))
  for (const regionId of plan.regionIds) {
    if (regionId !== -1 && validRegionIds.has(regionId) === false) {
      throw new RangeError(`Structure region id ${regionId} has no matching region`)
    }
  }
  for (const constraint of plan.featureConstraints) {
    if (constraint.minimumCells < 0 || constraint.minimumCells > constraint.maximumCells) {
      throw new RangeError(`Feature constraint ${constraint.id} has an invalid cell budget`)
    }
    for (const value of [...constraint.sourceCenter, ...constraint.targetCenter]) {
      assertFinite(value, `Feature constraint ${constraint.id} coordinate`)
    }
  }
  assertUnitInterval(plan.confidence, 'Structure plan confidence')
}
