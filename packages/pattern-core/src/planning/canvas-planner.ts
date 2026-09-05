import {
  validateCanvasPlan,
  type CanvasPlan,
  type FeatureBudget,
  type OccupancyMode,
  type StructuralUnitBudget,
} from '../contracts.js'
import { resolvedSubjectMask, subjectMaskConfidence, subjectMaskTrust } from '../analysis-evidence.js'
import { fitCropToCanvas, gridCellForSourcePoint, type CanvasFit } from '../image.js'
import {
  landmarkEffectiveConfidence,
  landmarkEvidenceReliability,
  landmarkGridRadiusCells,
  landmarkObservationState,
} from '../landmarks.js'
import { buildMedialGraph } from '../medial-graph.js'
import { petCrossSections, petOccupancyPathEdges, petStructuralUnits } from '../pet-structure.js'
import {
  buildSourceShapeModel,
  type ShapeRasterization,
} from '../shape.js'
import { ShapeVariantCache } from './shape-variant-cache.js'
import type {
  CropRect,
  GridSize,
  ImageAnalysis,
  ImageLandmark,
  LandmarkKind,
  SemanticRegion,
  StructuralRole,
} from '../types.js'

export interface CanvasPlanningInput {
  image: { width: number; height: number }
  analysis?: ImageAnalysis
  crop?: CropRect
  candidates: readonly GridSize[]
  occupancyMode?: OccupancyMode
  beadDiameterMm?: number
  shapeRefinementIterations?: number
  identitySeed?: string
}

interface FeatureProfile {
  minimum: number
  preferred: number
  maximum: number
  contrast: number
  shift: number
  scale: number
  weight: number
}

const featureProfiles: Readonly<Record<LandmarkKind, FeatureProfile>> = {
  eye: { minimum: 1, preferred: 2, maximum: 4, contrast: 18, shift: 1, scale: 32, weight: 1.5 },
  mouth: { minimum: 1, preferred: 3, maximum: 6, contrast: 14, shift: 1, scale: 28, weight: 1.25 },
  nose: { minimum: 1, preferred: 1, maximum: 3, contrast: 8, shift: 1, scale: 40, weight: 0.65 },
  ear: { minimum: 1, preferred: 3, maximum: 8, contrast: 10, shift: 1, scale: 26, weight: 0.9 },
  'face-contour': { minimum: 4, preferred: 12, maximum: 24, contrast: 10, shift: 1, scale: 20, weight: 1.2 },
  body: { minimum: 1, preferred: 1, maximum: 1, contrast: 8, shift: 1, scale: 18, weight: 0.3 },
  'identity-mark': { minimum: 1, preferred: 3, maximum: 8, contrast: 14, shift: 1, scale: 26, weight: 1.3 },
  custom: { minimum: 1, preferred: 2, maximum: 6, contrast: 10, shift: 1, scale: 30, weight: 0.8 },
}
const structuralEndpointProfile: FeatureProfile = {
  minimum: 1,
  preferred: 1,
  maximum: 3,
  contrast: 10,
  shift: 1,
  scale: 40,
  weight: 1.2,
}
const singleCellStructuralEndpointRoles = new Set<StructuralRole>(['upper-jaw', 'lower-jaw'])
const maximumOnlineGridCells = 96 * 96
const maximumImageSide = 2_048
const maximumImagePixels = 4_000_000
const maximumCanvasCandidates = 12
const plannerVersion = 'canvas-v4-robust-minimum-diameter'
const minimumTopologyContinuity = 0.85
// Ordinary twigs shorter than their measured width are unstable; semantic endpoints bypass this gate.
const minimumReliableBranchAspectRatio = 1.6
const topologyEndpointRoles = new Set<StructuralRole>([
  'ear-tip',
  'nose-tip',
  'upper-jaw',
  'lower-jaw',
  'front-paw',
  'rear-paw',
  'tail-tip',
])

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function normalizedCrop(input: CanvasPlanningInput): CropRect {
  const crop = input.crop ?? { x: 0, y: 0, width: input.image.width, height: input.image.height }
  const left = clamp(crop.x, 0, input.image.width - 1)
  const top = clamp(crop.y, 0, input.image.height - 1)
  const right = clamp(crop.x + crop.width, left + 1, input.image.width)
  const bottom = clamp(crop.y + crop.height, top + 1, input.image.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function validateInput(input: CanvasPlanningInput): void {
  if (Number.isInteger(input.image.width) === false || input.image.width <= 0
    || Number.isInteger(input.image.height) === false || input.image.height <= 0) {
    throw new RangeError('Canvas planning image dimensions must be positive integers')
  }
  if (input.image.width > maximumImageSide || input.image.height > maximumImageSide
    || input.image.width * input.image.height > maximumImagePixels) {
    throw new RangeError('Canvas planning image exceeds the processing limit')
  }
  if (input.candidates.length === 0) throw new RangeError('Canvas planning requires at least one candidate')
  if (input.candidates.length > maximumCanvasCandidates) {
    throw new RangeError('Canvas planning candidate count exceeds the processing limit')
  }
  if (input.crop !== undefined) {
    if ([input.crop.x, input.crop.y, input.crop.width, input.crop.height]
      .some((value) => Number.isFinite(value) === false)
      || input.crop.width <= 0 || input.crop.height <= 0) {
      throw new RangeError('Canvas planning crop must contain finite positive dimensions')
    }
  }
  for (const size of input.candidates) {
    if (Number.isInteger(size.width) === false || size.width <= 0
      || Number.isInteger(size.height) === false || size.height <= 0) {
      throw new RangeError('Canvas planning candidate dimensions must be positive integers')
    }
    if (size.width > 96 || size.height > 96 || size.width * size.height > maximumOnlineGridCells) {
      throw new RangeError('Canvas planning candidate exceeds the processing limit')
    }
  }
  const mask = resolvedSubjectMask(input.analysis)
  if (mask !== undefined && (mask.width !== input.image.width || mask.height !== input.image.height
    || mask.values.length !== mask.width * mask.height)) {
    throw new RangeError('Canvas planning subject mask must align with the source image')
  }
  if (mask?.values.some((value) => Number.isFinite(value) === false || value < 0 || value > 1)) {
    throw new RangeError('Canvas planning subject mask values must stay within 0..1')
  }
  for (const landmark of input.analysis?.landmarks ?? []) {
    if ([landmark.x, landmark.y, landmark.confidence].some((value) => Number.isFinite(value) === false)
      || landmark.confidence < 0 || landmark.confidence > 1) {
      throw new RangeError('Canvas planning landmarks must contain finite coordinates and confidence')
    }
  }
  for (const region of input.analysis?.semanticRegions ?? []) {
    if (region.id.trim().length === 0 || region.label.trim().length === 0
      || Number.isFinite(region.confidence) === false || region.confidence < 0 || region.confidence > 1
      || region.mask.width !== input.image.width || region.mask.height !== input.image.height
      || region.mask.values.length !== region.mask.width * region.mask.height
      || region.mask.values.some((value) => Number.isFinite(value) === false || value < 0 || value > 1)) {
      throw new RangeError('Canvas planning semantic regions must align with the source image')
    }
  }
  if (input.beadDiameterMm !== undefined
    && (Number.isFinite(input.beadDiameterMm) === false || input.beadDiameterMm <= 0)) {
    throw new RangeError('Canvas planning bead diameter must be a finite positive number')
  }
  if (input.shapeRefinementIterations !== undefined
    && (Number.isInteger(input.shapeRefinementIterations) === false
      || input.shapeRefinementIterations < 0 || input.shapeRefinementIterations > 32)) {
    throw new RangeError('Canvas planning refinement iterations must stay within 0..32')
  }
  if (input.identitySeed !== undefined && input.identitySeed.trim().length === 0) {
    throw new RangeError('Canvas planning identity seed must be non-empty')
  }
}

function diskCells(radius: number): number {
  let cells = 0
  const limit = Math.max(0, Math.round(radius))
  for (let y = -limit; y <= limit; y += 1) {
    for (let x = -limit; x <= limit; x += 1) {
      if (Math.hypot(x, y) <= limit + 0.25) cells += 1
    }
  }
  return Math.max(1, cells)
}

function allocatedCells(
  landmark: ImageLandmark,
  profile: FeatureProfile,
  crop: CropRect,
  fit: CanvasFit,
): number {
  const hasRadius = landmark.gridRadiusCells !== undefined
    || landmark.sourceRadiusPx !== undefined
    || landmark.radius !== undefined
  const estimate = hasRadius
    ? diskCells(landmarkGridRadiusCells(landmark, crop, fit))
    : Math.round((Math.min(fit.width, fit.height) / profile.scale) ** 2 * profile.preferred)
  return clamp(Math.max(1, estimate), 0, profile.maximum)
}

function featureProfileForLandmark(landmark: ImageLandmark): FeatureProfile {
  return landmark.structuralRole !== undefined
    && singleCellStructuralEndpointRoles.has(landmark.structuralRole)
    ? structuralEndpointProfile
    : featureProfiles[landmark.kind]
}

function localFeatureCapacity(
  centerX: number,
  centerY: number,
  theoreticalCells: number,
  allowedShiftCells: number,
  activeMask: Uint8Array,
  width: number,
  height: number,
): number {
  const footprintRadius = Math.max(0, Math.ceil((Math.sqrt(theoreticalCells) - 1) / 2))
  const searchRadius = allowedShiftCells + footprintRadius
  let capacity = 0
  for (let offsetY = -searchRadius; offsetY <= searchRadius; offsetY += 1) {
    for (let offsetX = -searchRadius; offsetX <= searchRadius; offsetX += 1) {
      const x = centerX + offsetX
      const y = centerY + offsetY
      if (x < 0 || y < 0 || x >= width || y >= height) continue
      capacity += activeMask[y * width + x] === 1 ? 1 : 0
    }
  }
  return capacity
}

function fittedActiveMask(width: number, height: number, fit: CanvasFit): Uint8Array {
  const activeMask = new Uint8Array(width * height)
  for (let y = fit.y; y < fit.y + fit.height; y += 1) {
    for (let x = fit.x; x < fit.x + fit.width; x += 1) activeMask[y * width + x] = 1
  }
  return activeMask
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, '0')
}

function canvasPlanId(
  size: GridSize,
  crop: CropRect,
  occupancyMode: OccupancyMode,
  identitySeed: string,
): string {
  const identity = JSON.stringify({ plannerVersion, size, crop, occupancyMode, identitySeed })
  return `canvas-${size.width}x${size.height}-${stableHash(identity)}`
}

function maskHash(values: ArrayLike<number> | undefined): number | undefined {
  if (values === undefined) return undefined
  let hash = 0x811c9dc5
  for (let index = 0; index < values.length; index += 1) {
    hash ^= Math.round((values[index] ?? 0) * 65_535)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function analysisIdentity(input: CanvasPlanningInput): string {
  return stableHash(JSON.stringify({
    image: input.image,
    subjectMaskConfidence: subjectMaskConfidence(input.analysis),
    subjectMaskEvidence: input.analysis?.subjectMaskEvidence === undefined ? undefined : {
      confidence: input.analysis.subjectMaskEvidence.confidence,
      source: input.analysis.subjectMaskEvidence.source,
      revision: input.analysis.subjectMaskEvidence.revision,
      userConfirmed: input.analysis.subjectMaskEvidence.userConfirmed,
      provenance: input.analysis.subjectMaskEvidence.provenance,
    },
    maskHash: maskHash(resolvedSubjectMask(input.analysis)?.values),
    semanticRegions: [...(input.analysis?.semanticRegions ?? [])]
      .sort((first, second) => first.id.localeCompare(second.id))
      .map((region) => ({
        id: region.id,
        label: region.label,
        confidence: region.confidence,
        importance: region.importance,
        maskHash: maskHash(region.mask.values),
      })),
    landmarks: (input.analysis?.landmarks ?? []).map((landmark) => ({
      id: landmark.id,
      kind: landmark.kind,
      x: landmark.x,
      y: landmark.y,
      confidence: landmark.confidence,
      priority: landmark.priority,
      affectsOccupancy: landmark.affectsOccupancy ?? false,
      structuralRole: landmark.structuralRole,
      observationState: landmark.observationState,
      symmetryGroup: landmark.symmetryGroup,
      sourceRadiusPx: landmark.sourceRadiusPx,
      gridRadiusCells: landmark.gridRadiusCells,
    })),
  }))
}

function featureBudgets(
  landmarks: readonly ImageLandmark[],
  crop: CropRect,
  fit: CanvasFit,
  activeMask: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
): { budgets: FeatureBudget[]; score: number; rejectionReasons: string[] } {
  const activeCellCount = activeMask.reduce((sum, value) => sum + value, 0)
  const entries = landmarks
    .filter((landmark) => landmark.x >= crop.x && landmark.y >= crop.y
      && landmark.x < crop.x + crop.width && landmark.y < crop.y + crop.height
      && landmarkObservationState(landmark) !== 'missing')
    .map((landmark) => {
      const profile = featureProfileForLandmark(landmark)
      const theoreticalAllocation = allocatedCells(landmark, profile, crop, fit)
      const [gridX, gridY] = gridCellForSourcePoint(crop, fit, landmark.x, landmark.y)
      const localCapacity = localFeatureCapacity(
        gridX,
        gridY,
        theoreticalAllocation,
        profile.shift,
        activeMask,
        canvasWidth,
        canvasHeight,
      )
      const allocation = landmark.kind === 'body'
        ? Number(localCapacity > 0 && activeCellCount > 0)
        : Math.min(theoreticalAllocation, localCapacity)
      const confidence = landmarkEffectiveConfidence(landmark)
      return {
        landmark,
        profile,
        allocation,
        cell: gridY * canvasWidth + gridX,
        confidence,
        hard: landmark.priority === 'hard'
          && landmarkObservationState(landmark) === 'observed'
          && confidence >= 0.5,
        feasible: allocation >= profile.minimum,
        collision: false,
      }
    })

  const groups = new Map<string, typeof entries>()
  for (const entry of entries) {
    if (entry.landmark.symmetryGroup === undefined) continue
    const group = groups.get(entry.landmark.symmetryGroup) ?? []
    group.push(entry)
    groups.set(entry.landmark.symmetryGroup, group)
  }
  for (const group of groups.values()) {
    const enforced = group.filter((entry) => entry.landmark.priority === 'hard'
      && landmarkObservationState(entry.landmark) === 'observed'
      && entry.confidence >= 0.5)
    if (enforced.length > 1 && new Set(enforced.map((entry) => entry.cell)).size < enforced.length) {
      for (const entry of enforced) {
        entry.feasible = false
        entry.collision = true
      }
    }
  }

  let missedWeight = 0
  let totalWeight = 0
  const budgets = entries.map((entry): FeatureBudget => {
    const baseWeight = entry.profile.weight * (entry.landmark.priority === 'hard' ? 1.25 : 1)
    const effectiveWeight = baseWeight * entry.confidence
    const preferredProgress = clamp(entry.allocation / entry.profile.preferred)
    const satisfaction = entry.feasible
      ? entry.hard
        ? 0.8 + preferredProgress * 0.2
        : preferredProgress
      : 0
    missedWeight += effectiveWeight * (1 - satisfaction)
    totalWeight += effectiveWeight
    return {
      featureId: entry.landmark.id,
      kind: entry.landmark.kind,
      hard: entry.hard,
      minimumCells: entry.profile.minimum,
      preferredCells: entry.profile.preferred,
      maximumCells: entry.profile.maximum,
      allocatedCells: entry.allocation,
      feasible: entry.feasible,
      minimumContrast: entry.profile.contrast,
      allowedShiftCells: entry.profile.shift,
      ...(entry.landmark.symmetryGroup === undefined
        ? {}
        : { symmetryGroup: entry.landmark.symmetryGroup }),
      confidence: entry.confidence,
    }
  })
  const rejectionReasons = new Set<string>()
  for (const entry of entries) {
    if (entry.hard === false || entry.feasible) continue
    rejectionReasons.add(entry.collision
      ? 'canvas-hard-feature-collision'
      : 'canvas-hard-feature-underbudget')
  }
  return {
    budgets,
    score: totalWeight === 0 ? 1 : clamp(1 - missedWeight / totalWeight),
    rejectionReasons: [...rejectionReasons].sort(),
  }
}

function landmarkInsideRegion(landmark: ImageLandmark, region: SemanticRegion): boolean {
  const x = Math.round(landmark.x)
  const y = Math.round(landmark.y)
  return x >= 0 && y >= 0 && x < region.mask.width && y < region.mask.height
    && (region.mask.values[y * region.mask.width + x] ?? 0) >= 0.2
}

function regionStructuralLandmarks(
  region: SemanticRegion,
  landmarks: readonly ImageLandmark[],
): readonly ImageLandmark[] {
  return landmarks.filter((landmark) => landmark.structuralRole !== undefined && (
    landmark.carrierRegionId === region.id
    || landmark.featureRegionId === region.id
    || landmarkInsideRegion(landmark, region)
  ))
}

function minimumRegionCrossSection(
  region: SemanticRegion,
  crop: CropRect,
  landmarks: readonly ImageLandmark[],
): number {
  const model = buildSourceShapeModel(region.mask, region.confidence)
  const structuralLandmarks = regionStructuralLandmarks(region, landmarks)
  const graph = buildMedialGraph(model, {
    crop,
    landmarks: structuralLandmarks,
    minimumSpurGeodesicLength: 2.5,
  })
  const reliableBranches = graph.branches.filter((branch) =>
    branch.geodesicLength >= Math.max(
      2.5,
      branch.robustMinimumDiameter * minimumReliableBranchAspectRatio,
    )
    || branch.endpointRoleHits.some((hit) => hit.hard))
  const narrowestBranch = [...reliableBranches].sort((first, second) =>
    first.robustMinimumDiameter - second.robustMinimumDiameter
    || second.geodesicLength - first.geodesicLength)[0]
  if (narrowestBranch !== undefined) return narrowestBranch.robustMinimumDiameter
  const widestNode = [...graph.nodes].sort((first, second) =>
    second.localRadius - first.localRadius || first.pixelIndex - second.pixelIndex)[0]
  return (widestNode?.localRadius ?? 0) * 2
}

function structuralRegionCrossSections(
  analysis: ImageAnalysis | undefined,
  crop: CropRect,
): ReadonlyMap<string, number> {
  const result = new Map<string, number>()
  for (const region of analysis?.semanticRegions ?? []) {
    const identity = `${region.id} ${region.label}`.toLowerCase()
    const structural = petCrossSections.some((definition) =>
      definition.regionIds.some((id) => identity.includes(id)))
    if (structural) result.set(
      region.id,
      minimumRegionCrossSection(region, crop, analysis?.landmarks ?? []),
    )
  }
  return result
}

function structuralUnitBudgets(
  analysis: ImageAnalysis | undefined,
  crop: CropRect,
  fit: CanvasFit,
  crossSectionSpans: ReadonlyMap<string, number>,
): { budgets: readonly StructuralUnitBudget[]; score: number; rejectionReasons: readonly string[] } {
  const landmarks = analysis?.landmarks ?? []
  const landmarkGroups = new Map<string, ImageLandmark[]>()
  for (const landmark of landmarks) {
    const separator = landmark.id.indexOf(':')
    const instanceId = separator > 0 ? landmark.id.slice(0, separator) : 'primary'
    const group = landmarkGroups.get(instanceId) ?? []
    group.push(landmark)
    landmarkGroups.set(instanceId, group)
  }
  const regions = analysis?.semanticRegions ?? []
  const regionById = new Map(regions.map((region) => [region.id, region]))
  const scale = Math.min(fit.width / crop.width, fit.height / crop.height)
  let weightedSatisfaction = 0
  let totalWeight = 0
  const satisfactionByInstance = new Map<string, { weighted: number; weight: number }>()
  const recordSatisfaction = (
    instanceId: string,
    satisfaction: number,
    weight: number,
  ): void => {
    weightedSatisfaction += satisfaction * weight
    totalWeight += weight
    const current = satisfactionByInstance.get(instanceId) ?? { weighted: 0, weight: 0 }
    current.weighted += satisfaction * weight
    current.weight += weight
    satisfactionByInstance.set(instanceId, current)
  }
  const pathBudgets = [...landmarkGroups.entries()].flatMap(([instanceId, group]) => {
    const byRole = new Map<StructuralRole, ImageLandmark>()
    for (const landmark of group) {
      if (landmark.structuralRole === undefined || landmarkObservationState(landmark) === 'missing') continue
      const current = byRole.get(landmark.structuralRole)
      if (current === undefined
        || landmarkEffectiveConfidence(landmark) > landmarkEffectiveConfidence(current)) {
        byRole.set(landmark.structuralRole, landmark)
      }
    }
    return petStructuralUnits.flatMap((definition): readonly StructuralUnitBudget[] => {
      const from = byRole.get(definition.from)
      const to = byRole.get(definition.to)
      if (from === undefined || to === undefined) return []
      const confidence = Math.min(landmarkEffectiveConfidence(from), landmarkEffectiveConfidence(to))
      const evidenceReliability = Math.min(
        landmarkEvidenceReliability(from),
        landmarkEvidenceReliability(to),
      )
      if (confidence < 0.2 || evidenceReliability < 0.12) return []
      const carrierIds = [...new Set([
        from.carrierRegionId,
        to.carrierRegionId,
        from.featureRegionId,
        to.featureRegionId,
      ].filter((value): value is string => value !== undefined))]
      const carrierReliability = carrierIds.length === 0
        ? 1
        : Math.min(...carrierIds.map((id) => regionById.get(id)?.confidence ?? 1))
      const reliability = Math.min(evidenceReliability, carrierReliability)
      const sourceSpanPixels = Math.hypot(to.x - from.x, to.y - from.y)
      const allocatedCells = sourceSpanPixels * scale
      const hard = definition.hard
        && landmarkObservationState(from) === 'observed'
        && landmarkObservationState(to) === 'observed'
        && reliability >= 0.6
      const requiredScale = definition.minimumCells / sourceSpanPixels
      const preferredScale = definition.preferredCells / sourceSpanPixels
      const feasible = scale + 1e-9 >= requiredScale
      const weight = definition.weight * reliability
      const satisfaction = hard && feasible
        ? 1
        : clamp(scale / preferredScale)
      recordSatisfaction(instanceId, satisfaction, weight)
      return [{
        id: instanceId === 'primary' ? definition.id : `${instanceId}:${definition.id}`,
        fromLandmarkId: from.id,
        toLandmarkId: to.id,
        measurement: 'path-length',
        sourceSpanPixels,
        projectedSpanCells: allocatedCells,
        reliability,
        expectedVisible: true,
        minimumCells: definition.minimumCells,
        preferredCells: definition.preferredCells,
        allocatedCells,
        confidence,
        hard,
        feasible,
      }]
    })
  })
  const crossSectionBudgets = regions.flatMap((region): readonly StructuralUnitBudget[] => {
    const normalizedRegionId = region.id.toLowerCase()
    const normalizedLabel = region.label.toLowerCase()
    const definition = petCrossSections.find((candidate) => candidate.regionIds.some((id) =>
      normalizedRegionId === id || normalizedRegionId.endsWith(`:${id}`) || normalizedLabel === id))
    if (definition === undefined || region.confidence < 0.2) return []
    const sourceSpanPixels = crossSectionSpans.get(region.id) ?? 0
    if (sourceSpanPixels <= 0) return []
    const reliability = region.confidence
    const allocatedCells = sourceSpanPixels * scale
    const heuristicOnly = (region.provenance?.length ?? 0) > 0
      && region.provenance!.every((entry) => entry.origin === 'heuristic')
    const hard = definition.hard && heuristicOnly === false && reliability >= 0.6
    const requiredScale = definition.minimumCells / sourceSpanPixels
    const preferredScale = definition.preferredCells / sourceSpanPixels
    const feasible = scale + 1e-9 >= requiredScale
    const weight = definition.weight * reliability
    const satisfaction = hard && feasible
      ? 1
      : clamp(scale / preferredScale)
    const separator = normalizedRegionId.indexOf(':')
    recordSatisfaction(separator > 0 ? normalizedRegionId.slice(0, separator) : 'primary', satisfaction, weight)
    return [{
      id: normalizedRegionId.includes(':')
        ? `${normalizedRegionId.slice(0, normalizedRegionId.indexOf(':'))}:${definition.id}`
        : definition.id,
      fromLandmarkId: `${region.id}:cross-section-a`,
      toLandmarkId: `${region.id}:cross-section-b`,
      measurement: 'cross-section',
      sourceRegionId: region.id,
      sourceSpanPixels,
      projectedSpanCells: allocatedCells,
      reliability,
      expectedVisible: true,
      minimumCells: definition.minimumCells,
      preferredCells: definition.preferredCells,
      allocatedCells,
      confidence: region.confidence,
      hard,
      feasible,
    }]
  })
  const budgets = [...pathBudgets, ...crossSectionBudgets]
  const globalScore = totalWeight === 0 ? 1 : clamp(weightedSatisfaction / totalWeight)
  const petInstanceScores = [...satisfactionByInstance.entries()]
    .filter(([instanceId, entry]) => /^pet-\d+$/.test(instanceId) && entry.weight > 0)
    .map(([, entry]) => clamp(entry.weighted / entry.weight))
  const score = petInstanceScores.length < 2
    ? globalScore
    : clamp(
      Math.min(...petInstanceScores) * 0.65
        + globalScore * 0.35,
    )
  return {
    budgets,
    score,
    rejectionReasons: budgets.some((budget) => budget.hard && budget.feasible === false)
      ? ['canvas-structural-unit-underbudget']
      : [],
  }
}

function compositionScore(shape: ShapeRasterization | undefined): number {
  if (shape === undefined) return 1
  let count = 0
  let sumX = 0
  let sumY = 0
  for (let index = 0; index < shape.activeMask.length; index += 1) {
    if (shape.activeMask[index] === 0) continue
    count += 1
    sumX += index % shape.width
    sumY += Math.floor(index / shape.width)
  }
  if (count === 0) return 0
  const centerX = (sumX / count + 0.5) / shape.width
  const centerY = (sumY / count + 0.5) / shape.height
  return clamp(1 - Math.hypot(centerX - 0.5, centerY - 0.48) / 0.6)
}

function activeComponentLabels(activeMask: Uint8Array, width: number, height: number): Int32Array {
  const labels = new Int32Array(activeMask.length)
  labels.fill(-1)
  const queue = new Int32Array(activeMask.length)
  let component = 0
  for (let start = 0; start < activeMask.length; start += 1) {
    if (activeMask[start] !== 1 || labels[start] !== -1) continue
    let head = 0
    let tail = 0
    labels[start] = component
    queue[tail++] = start
    while (head < tail) {
      const index = queue[head++]!
      const x = index % width
      const y = Math.floor(index / width)
      for (const [offsetX, offsetY] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
        const next = nextY * width + nextX
        if (activeMask[next] === 1 && labels[next] === -1) {
          labels[next] = component
          queue[tail++] = next
        }
      }
    }
    component += 1
  }
  return labels
}

function nearestActiveCell(
  labels: Int32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
): number | undefined {
  let best: number | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      const candidateX = x + offsetX
      const candidateY = y + offsetY
      if (candidateX < 0 || candidateY < 0 || candidateX >= width || candidateY >= height) continue
      const index = candidateY * width + candidateX
      if (labels[index] === -1) continue
      const distance = offsetX * offsetX + offsetY * offsetY
      if (distance < bestDistance || (distance === bestDistance && index < (best ?? Number.MAX_SAFE_INTEGER))) {
        best = index
        bestDistance = distance
      }
    }
  }
  return best
}

function hardSemanticPathStatus(input: {
  analysis: ImageAnalysis | undefined
  crop: CropRect
  fit: CanvasFit
  activeMask: Uint8Array
  width: number
  height: number
}): { required: boolean; feasible: boolean } {
  const groups = new Map<string, Map<StructuralRole, ImageLandmark>>()
  for (const landmark of input.analysis?.landmarks ?? []) {
    if (landmark.structuralRole === undefined || landmarkObservationState(landmark) === 'missing') continue
    const separator = landmark.id.indexOf(':')
    const instanceId = separator > 0 ? landmark.id.slice(0, separator) : 'primary'
    const byRole = groups.get(instanceId) ?? new Map<StructuralRole, ImageLandmark>()
    const current = byRole.get(landmark.structuralRole)
    if (current === undefined
      || landmarkEffectiveConfidence(landmark) > landmarkEffectiveConfidence(current)) {
      byRole.set(landmark.structuralRole, landmark)
    }
    groups.set(instanceId, byRole)
  }
  const labels = activeComponentLabels(input.activeMask, input.width, input.height)
  let required = false
  for (const byRole of groups.values()) {
    for (const [fromRole, toRole] of petOccupancyPathEdges) {
      const from = byRole.get(fromRole)
      const to = byRole.get(toRole)
      if (from === undefined || to === undefined) continue
      const endpoints = [from, to]
      const hard = endpoints.some((landmark) =>
        landmark.structuralRole !== undefined
        && topologyEndpointRoles.has(landmark.structuralRole)
        && landmark.priority === 'hard'
        && landmarkObservationState(landmark) === 'observed'
        && landmarkEffectiveConfidence(landmark) >= 0.6
        && landmark.affectsOccupancy === true)
      if (hard === false) continue
      required = true
      const [fromX, fromY] = gridCellForSourcePoint(input.crop, input.fit, from.x, from.y)
      const [toX, toY] = gridCellForSourcePoint(input.crop, input.fit, to.x, to.y)
      const radius = Math.max(
        1,
        Math.ceil(landmarkGridRadiusCells(from, input.crop, input.fit)),
        Math.ceil(landmarkGridRadiusCells(to, input.crop, input.fit)),
      )
      const fromCell = nearestActiveCell(labels, input.width, input.height, fromX, fromY, radius)
      const toCell = nearestActiveCell(labels, input.width, input.height, toX, toY, radius)
      if (fromCell === undefined || toCell === undefined || labels[fromCell] !== labels[toCell]) {
        return { required: true, feasible: false }
      }
    }
  }
  return { required, feasible: true }
}

function buildCanvasPlans(
  input: CanvasPlanningInput,
  preparedVariants?: ReadonlyMap<string, ShapeRasterization>,
): readonly CanvasPlan[] {
  validateInput(input)
  const crop = normalizedCrop(input)
  const subjectMask = resolvedSubjectMask(input.analysis)
  const occupancyMode = input.occupancyMode ?? (subjectMask === undefined
    ? 'full-frame'
    : 'subject-shape')
  const uniqueCandidates = [...new Map(input.candidates.map((size) => [`${size.width}x${size.height}`, size])).values()]
  const shapeModel = preparedVariants !== undefined || subjectMask === undefined
    ? undefined
    : buildSourceShapeModel(
      subjectMask,
      subjectMaskTrust(input.analysis),
      input.analysis?.landmarks ?? [],
    )
  const shapeCache = preparedVariants === undefined && shapeModel !== undefined
    ? new ShapeVariantCache(shapeModel, input.analysis?.landmarks ?? [])
    : undefined
  const refinementIterations = input.shapeRefinementIterations ?? 2
  const identitySeed = input.identitySeed ?? analysisIdentity(input)
  const crossSectionSpans = structuralRegionCrossSections(input.analysis, crop)
  const drafts = uniqueCandidates.map((size) => {
    const fit = fitCropToCanvas(crop, size.width, size.height)
    const shape = preparedVariants?.get(`${size.width}x${size.height}`)
      ?? shapeCache?.get({
        crop,
        size,
        refinementIterations,
      })
    if (shape !== undefined && (shape.width !== size.width || shape.height !== size.height)) {
      throw new RangeError('Prepared shape variant must align with its canvas size')
    }
    const subjectCells = shape?.activeMask.reduce((sum, value) => sum + value, 0)
      ?? fit.width * fit.height
    const fittedCells = fit.width * fit.height
    const estimatedBeads = occupancyMode === 'subject-shape'
      ? subjectCells
      : occupancyMode === 'solid-background'
        ? size.width * size.height
        : fittedCells
    const activeMask = occupancyMode === 'subject-shape'
      ? shape?.activeMask ?? new Uint8Array(size.width * size.height)
      : occupancyMode === 'solid-background'
        ? new Uint8Array(size.width * size.height).fill(1)
        : fittedActiveMask(size.width, size.height, fit)
    const featureMask = shape?.activeMask ?? activeMask
    return { size, fit, shape, subjectCells, estimatedBeads, featureMask }
  })
  return drafts.map((draft) => {
    const feature = featureBudgets(
      input.analysis?.landmarks ?? [],
      crop,
      draft.fit,
      draft.featureMask,
      draft.size.width,
      draft.size.height,
    )
    const structural = structuralUnitBudgets(
      input.analysis,
      crop,
      draft.fit,
      crossSectionSpans,
    )
    const subjectCoverage = clamp(draft.subjectCells / (draft.size.width * draft.size.height))
    const occupancyComposition = draft.shape === undefined
      ? 1
      : clamp(1 - Math.abs(subjectCoverage - 0.55) / 0.55)
    const subject = draft.shape === undefined
      ? occupancyComposition
      : clamp(occupancyComposition * 0.45 + draft.shape.diagnostics.coverageIoU * 0.55)
    const composition = compositionScore(draft.shape)
    const boundary = draft.shape === undefined
      ? 1
      : clamp(
        draft.shape.diagnostics.boundaryIoU * 0.65
          + (1 / (1 + draft.shape.diagnostics.meanBoundaryDistance)) * 0.35,
      )
    const topology = draft.shape?.diagnostics.topologyScore ?? 1
    const semanticPaths = hardSemanticPathStatus({
      analysis: input.analysis,
      crop,
      fit: draft.fit,
      activeMask: draft.featureMask,
      width: draft.size.width,
      height: draft.size.height,
    })
    const topologyFeasible = draft.shape === undefined
      || semanticPaths.required === false
      || (
        semanticPaths.feasible
        && draft.shape.diagnostics.topologyWeightedCenterlineRecall >= minimumTopologyContinuity
        && topology >= minimumTopologyContinuity
      )
    const beadCost = clamp(draft.estimatedBeads / maximumOnlineGridCells)
    const buildTimeCost = Math.sqrt(beadCost)
    const total = clamp(
      feature.score * 0.27
        + structural.score * 0.15
        + subject * 0.14
        + composition * 0.12
        + boundary * 0.14
        + topology * 0.18
        - beadCost * 0.3
        - buildTimeCost * 0.1,
    )
    const rejectionReasons = [...new Set([
      ...feature.rejectionReasons,
      ...structural.rejectionReasons,
      ...(topologyFeasible ? [] : ['canvas-topology-underbudget']),
    ])].sort()
    const plan: CanvasPlan = {
      id: canvasPlanId(draft.size, crop, occupancyMode, identitySeed),
      size: draft.size,
      crop,
      occupancyMode,
      subjectCoverage,
      estimatedBeads: draft.estimatedBeads,
      ...(input.beadDiameterMm === undefined ? {} : {
        estimatedWidthMm: draft.size.width * input.beadDiameterMm,
        estimatedHeightMm: draft.size.height * input.beadDiameterMm,
      }),
      featureBudgets: feature.budgets,
      structuralUnitBudgets: structural.budgets,
      topologyFeasible,
      feasible: rejectionReasons.length === 0,
      rejectionReasons,
      score: {
        total,
        feature: feature.score,
        structuralScale: structural.score,
        topology,
        subject,
        composition,
        boundary,
        beadCost,
        buildTimeCost,
      },
    }
    validateCanvasPlan(plan)
    return plan
  })
}

export function planCanvases(input: CanvasPlanningInput): readonly CanvasPlan[] {
  return buildCanvasPlans(input)
}

/** Internal pipeline entry that shares executed shape variants with candidate generation. */
export function planCanvasesWithShapeVariants(
  input: CanvasPlanningInput,
  variants: ReadonlyMap<string, ShapeRasterization>,
): readonly CanvasPlan[] {
  return buildCanvasPlans(input, variants)
}
