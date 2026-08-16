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

const occupancyModes = new Set<OccupancyMode>(['full-frame', 'subject-shape', 'solid-background'])
const landmarkKinds = new Set<LandmarkKind>([
  'eye',
  'mouth',
  'nose',
  'ear',
  'face-contour',
  'body',
  'identity-mark',
  'custom',
])
const candidateMetricNames = [
  'sourceFidelity',
  'featureVisibility',
  'silhouetteQuality',
  'semanticBoundaryQuality',
  'regionAdjacencyPreservation',
  'valueOrderAccuracy',
  'paletteRoleConsistency',
  'clusterCleanliness',
  'symmetryQuality',
  'craftComplexity',
  'estimatedBuildMinutes',
] as const satisfies readonly (keyof CandidateMetricsV2)[]

function assertFinite(value: number, label: string): void {
  if (Number.isFinite(value) === false) throw new RangeError(`${label} must be finite`)
}

function assertUnitInterval(value: number, label: string): void {
  assertFinite(value, label)
  if (value < 0 || value > 1) throw new RangeError(`${label} must stay within 0..1`)
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (Number.isInteger(value) === false || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`)
  }
}

function assertUniqueStrings(values: readonly string[], label: string): void {
  if (values.some((value) => value.trim().length === 0) || new Set(values).size !== values.length) {
    throw new RangeError(`${label} must contain unique non-empty ids`)
  }
}

function assertLandmarkKind(value: LandmarkKind, label: string): void {
  if (landmarkKinds.has(value) === false) throw new RangeError(`${label} has an invalid feature kind`)
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
  if (occupancyModes.has(plan.occupancyMode) === false) {
    throw new RangeError('Canvas occupancy mode is invalid')
  }
  assertUnitInterval(plan.subjectCoverage, 'Canvas subject coverage')
  assertNonNegativeInteger(plan.estimatedBeads, 'Canvas estimated beads')
  if (plan.estimatedBeads > plan.size.width * plan.size.height) {
    throw new RangeError('Canvas estimated beads cannot exceed the grid capacity')
  }
  for (const [label, value] of [
    ['estimated width', plan.estimatedWidthMm],
    ['estimated height', plan.estimatedHeightMm],
  ] as const) {
    if (value !== undefined && (Number.isFinite(value) === false || value <= 0)) {
      throw new RangeError(`Canvas ${label} must be a finite positive number`)
    }
  }
  assertUniqueStrings(plan.featureBudgets.map((budget) => budget.featureId), 'Feature budget ids')
  for (const budget of plan.featureBudgets) {
    assertLandmarkKind(budget.kind, `Feature budget ${budget.featureId}`)
    assertNonNegativeInteger(budget.minimumCells, `Feature budget ${budget.featureId} minimum cells`)
    assertNonNegativeInteger(budget.preferredCells, `Feature budget ${budget.featureId} preferred cells`)
    assertNonNegativeInteger(budget.maximumCells, `Feature budget ${budget.featureId} maximum cells`)
    assertNonNegativeInteger(budget.allowedShiftCells, `Feature budget ${budget.featureId} shift`)
    if (budget.minimumCells > budget.preferredCells
      || budget.preferredCells > budget.maximumCells) {
      throw new RangeError(`Feature budget ${budget.featureId} must satisfy minimum <= preferred <= maximum`)
    }
    assertUnitInterval(budget.confidence, `Feature budget ${budget.featureId} confidence`)
    assertFinite(budget.minimumContrast, `Feature budget ${budget.featureId} contrast`)
    if (budget.minimumContrast < 0) {
      throw new RangeError(`Feature budget ${budget.featureId} contrast must be non-negative`)
    }
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
  const regionIdValues = plan.regions.map((region) => region.id)
  for (const regionId of regionIdValues) {
    assertNonNegativeInteger(regionId, 'Structure region id')
  }
  const validRegionIds = new Set(regionIdValues)
  if (validRegionIds.size !== regionIdValues.length) {
    throw new RangeError('Structure region ids must be unique')
  }
  const ownedCells = new Map<number, number>()
  for (const region of plan.regions) {
    assertUnitInterval(region.importance, `Structure region ${region.id} importance`)
    if (new Set(region.cellIndices).size !== region.cellIndices.length) {
      throw new RangeError(`Structure region ${region.id} cell indices must be unique`)
    }
    for (const cell of region.cellIndices) {
      if (Number.isInteger(cell) === false || cell < 0 || cell >= cells) {
        throw new RangeError(`Structure region ${region.id} has an out-of-range cell`)
      }
      if (ownedCells.has(cell)) throw new RangeError(`Structure cell ${cell} has multiple owners`)
      ownedCells.set(cell, region.id)
      if (plan.regionIds[cell] !== region.id) {
        throw new RangeError(`Structure region ${region.id} cell ownership disagrees with regionIds`)
      }
    }
    if (new Set(region.adjacentRegionIds).size !== region.adjacentRegionIds.length) {
      throw new RangeError(`Structure region ${region.id} adjacency must be unique`)
    }
    for (const adjacentId of region.adjacentRegionIds) {
      assertNonNegativeInteger(adjacentId, `Structure region ${region.id} adjacent region id`)
      if (adjacentId === region.id) throw new RangeError(`Structure region ${region.id} has a self-loop`)
      if (validRegionIds.has(adjacentId) === false) {
        throw new RangeError(`Structure region ${region.id} references an unknown adjacent region`)
      }
    }
  }
  for (const regionId of plan.regionIds) {
    if (Number.isInteger(regionId) === false || regionId < -1) {
      throw new RangeError('Structure regionIds must contain integers greater than or equal to -1')
    }
    if (regionId !== -1 && validRegionIds.has(regionId) === false) {
      throw new RangeError(`Structure region id ${regionId} has no matching region`)
    }
  }
  for (let cell = 0; cell < cells; cell += 1) {
    const regionId = plan.regionIds[cell]!
    if (regionId !== -1 && ownedCells.get(cell) !== regionId) {
      throw new RangeError(`Structure cell ${cell} is absent from its region cellIndices`)
    }
  }
  const regionsById = new Map(plan.regions.map((region) => [region.id, region]))
  for (const region of plan.regions) {
    for (const adjacentId of region.adjacentRegionIds) {
      if (regionsById.get(adjacentId)?.adjacentRegionIds.includes(region.id) !== true) {
        throw new RangeError(`Structure adjacency ${region.id}-${adjacentId} must be symmetric`)
      }
    }
  }
  assertUniqueStrings(plan.featureConstraints.map((constraint) => constraint.id), 'Feature constraint ids')
  for (const constraint of plan.featureConstraints) {
    assertLandmarkKind(constraint.kind, `Feature constraint ${constraint.id}`)
    assertNonNegativeInteger(constraint.minimumCells, `Feature constraint ${constraint.id} minimum cells`)
    assertNonNegativeInteger(constraint.maximumCells, `Feature constraint ${constraint.id} maximum cells`)
    assertNonNegativeInteger(constraint.allowedShiftCells, `Feature constraint ${constraint.id} shift`)
    if (constraint.minimumCells > constraint.maximumCells) {
      throw new RangeError(`Feature constraint ${constraint.id} has an invalid cell budget`)
    }
    if (constraint.candidateTemplates.length === 0) {
      throw new RangeError(`Feature constraint ${constraint.id} requires a candidate template`)
    }
    assertUniqueStrings(constraint.candidateTemplates, `Feature constraint ${constraint.id} templates`)
    assertFinite(constraint.minimumContrastDeltaE, `Feature constraint ${constraint.id} contrast`)
    if (constraint.minimumContrastDeltaE < 0) {
      throw new RangeError(`Feature constraint ${constraint.id} contrast must be non-negative`)
    }
    for (const value of [...constraint.sourceCenter, ...constraint.targetCenter]) {
      assertFinite(value, `Feature constraint ${constraint.id} coordinate`)
    }
    if (constraint.targetCenter[0] < 0 || constraint.targetCenter[0] >= plan.width
      || constraint.targetCenter[1] < 0 || constraint.targetCenter[1] >= plan.height) {
      throw new RangeError(`Feature constraint ${constraint.id} target center must stay inside the grid`)
    }
  }
  assertUnitInterval(plan.confidence, 'Structure plan confidence')
}

export function validateValuePlan(plan: ValuePlan): void {
  assertUniqueStrings(plan.roles.map((role) => role.id), 'Value role ids')
  const kinds = new Set<ValueRoleKind>(['highlight', 'light', 'base', 'shadow', 'deep-shadow', 'outline'])
  for (const role of plan.roles) {
    if (role.regionId.trim().length === 0 || kinds.has(role.kind) === false) {
      throw new RangeError(`Value role ${role.id} has invalid identity fields`)
    }
    assertFinite(role.targetLightness, `Value role ${role.id} target lightness`)
    if (role.targetLightness < 0 || role.targetLightness > 100) {
      throw new RangeError(`Value role ${role.id} target lightness must stay within 0..100`)
    }
    assertFinite(role.minimumSeparation, `Value role ${role.id} minimum separation`)
    if (role.minimumSeparation < 0) {
      throw new RangeError(`Value role ${role.id} minimum separation must be non-negative`)
    }
    assertUnitInterval(role.importance, `Value role ${role.id} importance`)
  }
}

export function validatePalettePlan(plan: PalettePlan): void {
  assertUniqueStrings(plan.selectedColorIds, 'Palette selected color ids')
  const selected = new Set(plan.selectedColorIds)
  assertFinite(plan.totalCost, 'Palette total cost')
  if (plan.totalCost < 0) throw new RangeError('Palette total cost must be non-negative')
  for (const [roleId, allowedIds] of Object.entries(plan.allowedColorIdsByRole)) {
    if (roleId.trim().length === 0) throw new RangeError('Palette role ids must be non-empty')
    assertUniqueStrings(allowedIds, `Palette allowed colors for ${roleId}`)
  }
  for (const [roleId, colorId] of Object.entries(plan.assignments)) {
    if (roleId.trim().length === 0 || colorId.trim().length === 0 || selected.has(colorId) === false) {
      throw new RangeError(`Palette assignment ${roleId} must reference a selected color`)
    }
    const allowed = plan.allowedColorIdsByRole[roleId]
    if (allowed !== undefined && allowed.includes(colorId) === false) {
      throw new RangeError(`Palette assignment ${roleId} must use an allowed color`)
    }
  }
}

export function validateCandidateMetricsV2(metrics: CandidateMetricsV2): void {
  for (const name of candidateMetricNames) {
    const metric = metrics[name]
    if (metric === undefined || metric === null || typeof metric !== 'object') {
      throw new RangeError(`Candidate required metric ${name} is missing`)
    }
    if (typeof metric.available !== 'boolean') throw new RangeError(`Candidate metric ${name} availability is invalid`)
    assertFinite(metric.value, `Candidate metric ${name} value`)
    assertUnitInterval(metric.confidence, `Candidate metric ${name} confidence`)
    if (name === 'estimatedBuildMinutes') {
      if (metric.value < 0) throw new RangeError(`Candidate metric ${name} must be non-negative`)
    } else if (metric.value < 0 || metric.value > 1) {
      throw new RangeError(`Candidate metric ${name} must stay within 0..1`)
    }
  }
}
