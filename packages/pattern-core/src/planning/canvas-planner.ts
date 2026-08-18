import { validateCanvasPlan, type CanvasPlan, type FeatureBudget, type OccupancyMode } from '../contracts.js'
import { fitCropToCanvas, gridCellForSourcePoint, type CanvasFit } from '../image.js'
import { landmarkEffectiveConfidence, landmarkGridRadiusCells } from '../landmarks.js'
import {
  buildSourceShapeModel,
  rasterizeSourceShape,
  type ShapeRasterization,
  type SourceShapeModel,
} from '../shape.js'
import type { CropRect, GridSize, ImageAnalysis, ImageLandmark, LandmarkKind } from '../types.js'

export interface CanvasPlanningInput {
  image: { width: number; height: number }
  analysis?: ImageAnalysis
  crop?: CropRect
  candidates: readonly GridSize[]
  occupancyMode?: OccupancyMode
  beadDiameterMm?: number
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
  body: { minimum: 4, preferred: 12, maximum: 32, contrast: 8, shift: 1, scale: 18, weight: 0.7 },
  'identity-mark': { minimum: 1, preferred: 3, maximum: 8, contrast: 14, shift: 1, scale: 26, weight: 1.3 },
  custom: { minimum: 1, preferred: 2, maximum: 6, contrast: 10, shift: 1, scale: 30, weight: 0.8 },
}
const maximumOnlineGridCells = 96 * 96
const maximumImageSide = 2_048
const maximumImagePixels = 4_000_000
const maximumCanvasCandidates = 12
const plannerVersion = 'canvas-v1'

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
  const mask = input.analysis?.subjectMask
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
  if (input.beadDiameterMm !== undefined
    && (Number.isFinite(input.beadDiameterMm) === false || input.beadDiameterMm <= 0)) {
    throw new RangeError('Canvas planning bead diameter must be a finite positive number')
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
): string {
  const identity = JSON.stringify({ plannerVersion, size, crop, occupancyMode })
  return `canvas-${size.width}x${size.height}-${stableHash(identity)}`
}

function featureBudgets(
  landmarks: readonly ImageLandmark[],
  analysisConfidence: number,
  crop: CropRect,
  fit: CanvasFit,
  activeMask: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
): { budgets: FeatureBudget[]; score: number; rejectionReasons: string[] } {
  const activeCellCount = activeMask.reduce((sum, value) => sum + value, 0)
  const entries = landmarks
    .filter((landmark) => landmark.x >= crop.x && landmark.y >= crop.y
      && landmark.x < crop.x + crop.width && landmark.y < crop.y + crop.height)
    .map((landmark) => {
      const profile = featureProfiles[landmark.kind]
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
        ? Math.min(profile.maximum, activeCellCount)
        : Math.min(theoreticalAllocation, localCapacity)
      const confidence = landmarkEffectiveConfidence(landmark, analysisConfidence)
      return {
        landmark,
        profile,
        allocation,
        cell: gridY * canvasWidth + gridX,
        confidence,
        hard: landmark.priority === 'hard' && confidence >= 0.5,
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
    const enforced = group.filter((entry) => entry.landmark.priority === 'hard' && entry.confidence >= 0.5)
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

function buildCanvasPlans(
  input: CanvasPlanningInput,
  preparedShape?: SourceShapeModel,
): readonly CanvasPlan[] {
  validateInput(input)
  const crop = normalizedCrop(input)
  const occupancyMode = input.occupancyMode ?? (input.analysis?.subjectMask === undefined
    ? 'full-frame'
    : 'subject-shape')
  const uniqueCandidates = [...new Map(input.candidates.map((size) => [`${size.width}x${size.height}`, size])).values()]
  const shapeModel = preparedShape ?? (input.analysis?.subjectMask === undefined
    ? undefined
    : buildSourceShapeModel(
      input.analysis.subjectMask,
      input.analysis.confidence ?? 1,
      input.analysis.landmarks ?? [],
    ))
  const drafts = uniqueCandidates.map((size) => {
    const fit = fitCropToCanvas(crop, size.width, size.height)
    const shape = shapeModel === undefined || shapeModel.foregroundArea === 0
      ? undefined
      : rasterizeSourceShape(
        shapeModel,
        crop,
        fit,
        size.width,
        size.height,
        input.analysis?.landmarks ?? [],
        { refinementIterations: 0 },
      )
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
    return { size, fit, shape, subjectCells, estimatedBeads, activeMask }
  })
  return drafts.map((draft) => {
    const feature = featureBudgets(
      input.analysis?.landmarks ?? [],
      input.analysis?.confidence ?? 1,
      crop,
      draft.fit,
      draft.activeMask,
      draft.size.width,
      draft.size.height,
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
    const beadCost = clamp(draft.estimatedBeads / maximumOnlineGridCells)
    const buildTimeCost = Math.sqrt(beadCost)
    const total = clamp(
      feature.score * 0.38
        + subject * 0.18
        + composition * 0.16
        + boundary * 0.28
        - beadCost * 0.3
        - buildTimeCost * 0.1,
    )
    const plan: CanvasPlan = {
      id: canvasPlanId(draft.size, crop, occupancyMode),
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
      feasible: feature.rejectionReasons.length === 0,
      rejectionReasons: feature.rejectionReasons,
      score: {
        total,
        feature: feature.score,
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

/** Internal pipeline entry that avoids parsing a trusted subject mask twice. */
export function planCanvasesWithSourceShape(
  input: CanvasPlanningInput,
  sourceShape: SourceShapeModel,
): readonly CanvasPlan[] {
  return buildCanvasPlans(input, sourceShape)
}
