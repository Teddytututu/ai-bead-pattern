import type { CanvasPlan, FeatureBudget, FeatureConstraint } from '../contracts.js'
import { fitCropToCanvas, gridCellForSourcePoint } from '../image.js'
import type { BinaryMask, GridSize, ImageLandmark, Lab } from '../types.js'
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
  reservedCells?: readonly number[]
  rotationDegrees?: number
  templateVersion?: string
}

export interface FeaturePlacementSearchInput {
  canvasPlan: CanvasPlan
  budget: FeatureBudget
  landmark: ImageLandmark
  occupancyMask?: BinaryMask
  carrierMask?: BinaryMask
  blockedCells?: ReadonlySet<number>
  maximumCandidates?: number
  pixelLabs?: readonly Lab[]
  lightDirection?: readonly [number, number]
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
  if (kind !== 'eye' && kind !== 'mouth' && kind !== 'nose'
    && kind !== 'ear' && kind !== 'identity-mark' && kind !== 'custom') {
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
    }).filter(template => landmark.templateId === undefined || template.id === landmark.templateId).map((template) => template.id)
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
  }).filter(template => (input.landmark.templateId === undefined || template.id === input.landmark.templateId)
    && (input.landmark.templateId !== undefined || (input.landmark.featureShape?.expression === 'closed'
      ? template.expression === 'closed' || (kind === 'mouth' && template.height === 1)
      : template.expression !== 'closed')))
  const center = targetCenter(input.landmark, input.canvasPlan)
  const fit = fitCropToCanvas(crop, input.canvasPlan.size.width, input.canvasPlan.size.height)
  const shape = input.landmark.featureShape
  const targetWidth = shape === undefined ? undefined : Math.max(1, Math.round(shape.widthPx * fit.width / crop.width))
  const targetHeight = shape === undefined ? undefined : Math.max(1, Math.round(shape.heightPx * fit.height / crop.height))
  const rotationDegrees = Math.round((shape?.angleDegrees ?? 0) / 45) * 45
  const quarterTurns = Math.round(rotationDegrees / 90)
  const radians = (rotationDegrees - quarterTurns * 90) * Math.PI / 180
  // Three integer shears are bijective: rotating cannot collapse two bead cells.
  const rotate = (x: number, y: number): readonly [number, number] => {
    x -= Math.round(Math.tan(radians / 2) * y)
    y += Math.round(Math.sin(radians) * x)
    x -= Math.round(Math.tan(radians / 2) * y)
    const turns = ((quarterTurns % 4) + 4) % 4
    return turns === 1 ? [-y, x] : turns === 2 ? [-x, -y] : turns === 3 ? [y, -x] : [x, y]
  }
  const placements: ResolvedFeaturePlacement[] = []
  for (const template of templates) {
    if (input.landmark.templateId === undefined && targetWidth !== undefined && targetHeight !== undefined
      && (template.width > targetWidth + 1 || template.height > targetHeight + 1)) continue
    for (let shiftY = -input.budget.allowedShiftCells; shiftY <= input.budget.allowedShiftCells; shiftY += 1) {
      for (let shiftX = -input.budget.allowedShiftCells; shiftX <= input.budget.allowedShiftCells; shiftX += 1) {
        const originX = center[0] + shiftX
        const originY = center[1] + shiftY
        const transform = (x: number, y: number): readonly [number, number] => {
          const [dx, dy] = rotate(x - template.anchor[0], y - template.anchor[1])
          return [originX + dx, originY + dy]
        }
        const roles = template.cells.map((cell) => {
          const [x, y] = transform(cell.x, cell.y)
          return { x, y, cell: y * input.canvasPlan.size.width + x, role: cell.role }
        })
        if (new Set(roles.map(entry => entry.cell)).size !== roles.length) continue
        const reservedCells: number[] = []
        for (let y = 0; y < template.height; y++) for (let x = 0; x < template.width; x++) {
          if (template.cells.some(cell => cell.x === x && cell.y === y)) continue
          const [tx, ty] = transform(x, y)
          if (tx >= 0 && ty >= 0 && tx < input.canvasPlan.size.width && ty < input.canvasPlan.size.height) reservedCells.push(ty * input.canvasPlan.size.width + tx)
        }
        if (reservedCells.some(cell => input.blockedCells?.has(cell))) continue
        if (roles.some((entry) => entry.x < 0 || entry.y < 0
          || entry.x >= input.canvasPlan.size.width || entry.y >= input.canvasPlan.size.height)) continue
        if (roles.some((entry) => input.blockedCells?.has(entry.cell) === true)) continue
        if (roles.some((entry) => (input.occupancyMask?.values[entry.cell] ?? 1) < 0.5)) continue
        if (roles.some((entry) => (input.carrierMask?.values[entry.cell] ?? 1) < 0.5)) continue
        // Highlight stays on the light-facing screen side instead of blindly rotating/mirroring.
        const highlight = roles.find(entry => entry.role === 'eye-highlight')
        if (highlight !== undefined && rotationDegrees !== 0) {
          const light = input.lightDirection ?? [-1, -1]
          const preferred = [...roles].sort((a, b) => (b.x * light[0] + b.y * light[1]) - (a.x * light[0] + a.y * light[1]) || a.cell - b.cell)[0]!
          const previous = preferred.role; preferred.role = highlight.role; highlight.role = previous
        }
        const targetCells = Math.min(input.budget.preferredCells, maximumCells)
        const budgetScore = 1 / (1 + Math.abs(template.cells.length - targetCells))
        const positionScore = 1 - clamp(
          Math.hypot(shiftX, shiftY) / Math.max(1, input.budget.allowedShiftCells * Math.SQRT2),
        )
        const compactnessScore = template.cells.length / (template.width * template.height)
        const shapeScore = targetWidth === undefined || targetHeight === undefined ? compactnessScore
          : 1 / (1 + Math.abs(template.width - targetWidth) + Math.abs(template.height - targetHeight))
        const local = roles.map(entry => input.pixelLabs?.[entry.cell]?.[0] ?? 50)
        const low = Math.min(...local), high = Math.max(...local)
        const appearanceScore = high - low < 3 ? 0.5 : roles.reduce((sum, entry, index) => {
          const brightness = (local[index]! - low) / (high - low)
          return sum + (entry.role.endsWith('-dark') ? 1 - brightness : entry.role === 'eye-highlight' || entry.role === 'eye-white' ? brightness : 0.5)
        }, 0) / roles.length
        const placement: ResolvedFeaturePlacement = {
          featureId: input.landmark.id,
          kind,
          templateId: template.id,
          templateVersion: template.version ?? 'feature-templates-v1',
          rotationDegrees,
          reservedCells: [...new Set(reservedCells)].filter(cell => !roles.some(entry => entry.cell === cell)),
          center: [center[0] + shiftX, center[1] + shiftY],
          occupiedCells: roles.map((entry) => entry.cell).sort((first, second) => first - second),
          roles: roles.map((entry) => ({ cell: entry.cell, role: entry.role }))
            .sort((first, second) => first.cell - second.cell),
          shift: [shiftX, shiftY],
          score: clamp(positionScore * 0.4 + budgetScore * 0.2 + shapeScore * 0.2 + appearanceScore * 0.15 + compactnessScore * 0.05),
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
