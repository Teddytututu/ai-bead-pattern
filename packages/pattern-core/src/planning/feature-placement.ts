import type { CanvasPlan, FeatureBudget, FeatureConstraint } from '../contracts.js'
import { fitCropToCanvas, gridCellForSourcePoint } from '../image.js'
import type { BinaryMask, GridSize, ImageLandmark } from '../types.js'
import {
  selectFeatureTemplates,
} from './feature-template-library.js'
import type { FeatureCellRole, FeatureTemplateKind } from './feature-template.js'

export interface ResolvedFeaturePlacement {
  featureId: string
  kind: FeatureTemplateKind
  templateId: string
  center: readonly [number, number]
  occupiedCells: readonly number[]
  roles: readonly { cell: number; role: FeatureCellRole }[]
  shift: readonly [number, number]
  score: number
}

export interface FeaturePlacementSearchInput {
  canvasPlan: CanvasPlan
  budget: FeatureBudget
  landmark: ImageLandmark
  occupancyMask?: BinaryMask
  carrierMask?: BinaryMask
  blockedCells?: ReadonlySet<number>
  maximumCandidates?: number
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function validateMask(mask: BinaryMask | undefined, size: GridSize, label: string): void {
  if (mask === undefined) return
  if (mask.width !== size.width || mask.height !== size.height
    || mask.values.length !== size.width * size.height) {
    throw new RangeError(`${label} must align with the feature target grid`)
  }
  if (mask.values.some((value) => Number.isFinite(value) === false || value < 0 || value > 1)) {
    throw new RangeError(`${label} values must stay within 0..1`)
  }
}

function featureKind(kind: ImageLandmark['kind']): FeatureTemplateKind {
  if (kind !== 'eye' && kind !== 'mouth' && kind !== 'nose') {
    throw new RangeError(`Feature placement has no template library for ${kind}`)
  }
  return kind
}

function targetCenter(landmark: ImageLandmark, canvasPlan: CanvasPlan): readonly [number, number] {
  const fit = fitCropToCanvas(canvasPlan.crop, canvasPlan.size.width, canvasPlan.size.height)
  return gridCellForSourcePoint(canvasPlan.crop, fit, landmark.x, landmark.y)
}

export function createFeatureConstraint(
  budget: FeatureBudget,
  landmark: ImageLandmark,
  canvasPlan: CanvasPlan,
): FeatureConstraint {
  if (budget.featureId !== landmark.id || budget.kind !== landmark.kind) {
    throw new RangeError('Feature budget and landmark identity must match')
  }
  const kind = featureKind(landmark.kind)
  const maximumCells = Math.min(budget.maximumCells, budget.allocatedCells)
  const candidateTemplates = maximumCells < budget.minimumCells
    ? []
    : selectFeatureTemplates({
      kind,
      minimumCells: budget.minimumCells,
      maximumCells,
    }).map((template) => template.id)
  return {
    id: landmark.id,
    kind: landmark.kind,
    sourceCenter: [landmark.x, landmark.y],
    targetCenter: targetCenter(landmark, canvasPlan),
    candidateTemplates,
    minimumCells: budget.minimumCells,
    maximumCells,
    allowedShiftCells: budget.allowedShiftCells,
    minimumContrastDeltaE: budget.minimumContrast,
    hard: budget.hard,
    affectsOccupancy: landmark.affectsOccupancy === true,
    ...(landmark.symmetryGroup === undefined ? {} : { symmetryGroup: landmark.symmetryGroup }),
  }
}

export function validateResolvedFeaturePlacement(
  placement: ResolvedFeaturePlacement,
  size: GridSize,
): void {
  if (placement.featureId.trim().length === 0 || placement.templateId.trim().length === 0) {
    throw new RangeError('Resolved feature placement ids must be non-empty')
  }
  if (Number.isFinite(placement.center[0]) === false || Number.isFinite(placement.center[1]) === false
    || Number.isInteger(placement.shift[0]) === false || Number.isInteger(placement.shift[1]) === false) {
    throw new RangeError('Resolved feature placement coordinates are invalid')
  }
  if (placement.occupiedCells.length === 0
    || new Set(placement.occupiedCells).size !== placement.occupiedCells.length) {
    throw new RangeError('Resolved feature placement cells must be unique and non-empty')
  }
  for (const cell of placement.occupiedCells) {
    if (Number.isInteger(cell) === false || cell < 0 || cell >= size.width * size.height) {
      throw new RangeError('Resolved feature placement cell is outside the target grid')
    }
  }
  if (placement.roles.length !== placement.occupiedCells.length
    || placement.roles.some((entry) => placement.occupiedCells.includes(entry.cell) === false)) {
    throw new RangeError('Resolved feature placement roles must cover every occupied cell')
  }
  if (Number.isFinite(placement.score) === false || placement.score < 0 || placement.score > 1) {
    throw new RangeError('Resolved feature placement score must stay within 0..1')
  }
}

export function searchFeaturePlacements(
  input: FeaturePlacementSearchInput,
): readonly ResolvedFeaturePlacement[] {
  if (input.budget.featureId !== input.landmark.id || input.budget.kind !== input.landmark.kind) {
    throw new RangeError('Feature placement budget and landmark identity must match')
  }
  const kind = featureKind(input.landmark.kind)
  const crop = input.canvasPlan.crop
  if (input.landmark.x < crop.x || input.landmark.y < crop.y
    || input.landmark.x >= crop.x + crop.width
    || input.landmark.y >= crop.y + crop.height) return []
  validateMask(input.occupancyMask, input.canvasPlan.size, 'Feature occupancy mask')
  validateMask(input.carrierMask, input.canvasPlan.size, 'Feature carrier mask')
  const maximumCandidates = input.maximumCandidates ?? 16
  if (Number.isInteger(maximumCandidates) === false || maximumCandidates <= 0 || maximumCandidates > 128) {
    throw new RangeError('Feature placement candidate limit must stay within 1..128')
  }
  const maximumCells = Math.min(input.budget.maximumCells, input.budget.allocatedCells)
  if (maximumCells < input.budget.minimumCells) return []
  const templates = selectFeatureTemplates({
    kind,
    minimumCells: input.budget.minimumCells,
    maximumCells,
  })
  const center = targetCenter(input.landmark, input.canvasPlan)
  const placements: ResolvedFeaturePlacement[] = []
  for (const template of templates) {
    for (let shiftY = -input.budget.allowedShiftCells; shiftY <= input.budget.allowedShiftCells; shiftY += 1) {
      for (let shiftX = -input.budget.allowedShiftCells; shiftX <= input.budget.allowedShiftCells; shiftX += 1) {
        const originX = center[0] + shiftX - template.anchor[0]
        const originY = center[1] + shiftY - template.anchor[1]
        const roles = template.cells.map((cell) => {
          const x = originX + cell.x
          const y = originY + cell.y
          return { x, y, cell: y * input.canvasPlan.size.width + x, role: cell.role }
        })
        if (roles.some((entry) => entry.x < 0 || entry.y < 0
          || entry.x >= input.canvasPlan.size.width || entry.y >= input.canvasPlan.size.height)) continue
        if (roles.some((entry) => input.blockedCells?.has(entry.cell) === true)) continue
        if (roles.some((entry) => (input.occupancyMask?.values[entry.cell] ?? 1) < 0.5)) continue
        if (roles.some((entry) => (input.carrierMask?.values[entry.cell] ?? 1) < 0.5)) continue
        const targetCells = Math.min(input.budget.preferredCells, maximumCells)
        const budgetScore = 1 / (1 + Math.abs(template.cells.length - targetCells))
        const positionScore = 1 - clamp(
          Math.hypot(shiftX, shiftY) / Math.max(1, input.budget.allowedShiftCells * Math.SQRT2),
        )
        const compactnessScore = template.cells.length / (template.width * template.height)
        const placement: ResolvedFeaturePlacement = {
          featureId: input.landmark.id,
          kind,
          templateId: template.id,
          center: [center[0] + shiftX, center[1] + shiftY],
          occupiedCells: roles.map((entry) => entry.cell).sort((first, second) => first - second),
          roles: roles.map((entry) => ({ cell: entry.cell, role: entry.role }))
            .sort((first, second) => first.cell - second.cell),
          shift: [shiftX, shiftY],
          score: clamp(positionScore * 0.55 + budgetScore * 0.3 + compactnessScore * 0.15),
        }
        validateResolvedFeaturePlacement(placement, input.canvasPlan.size)
        placements.push(placement)
      }
    }
  }
  return [...placements].sort((first, second) =>
    second.score - first.score
      || first.templateId.localeCompare(second.templateId)
      || first.occupiedCells.join(',').localeCompare(second.occupiedCells.join(',')))
    .slice(0, maximumCandidates)
}
