import { colorDistance, prepareColors, type PreparedColor } from './color.js'
import type {
  ColorDistanceMethod,
  GridEditRecord,
  GridRefinementMode,
  GridRefinementSummary,
  Lab,
  MaterialColor,
} from './types.js'
import type { ResolvedFeaturePlacement } from './planning/feature-placement.js'

export interface GridRefinementInput {
  colorIds: readonly string[]
  width: number
  height: number
  activeMask: Uint8Array
  protectedCells: ReadonlySet<number>
  pixelLabs: readonly Lab[]
  colors: readonly MaterialColor[]
  boundaryStrength: Float32Array
  importance: readonly number[]
  featurePlacements: readonly ResolvedFeaturePlacement[]
  distanceMethod: ColorDistanceMethod
  mode: GridRefinementMode
}

export interface GridRefinementResult extends GridRefinementSummary {
  colorIds: readonly string[]
  edits: readonly GridEditRecord[]
}

const orthogonal = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const
const surrounding = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
] as const
const surroundingClockwise = [
  [-1, -1], [0, -1], [1, -1], [1, 0],
  [1, 1], [0, 1], [-1, 1], [-1, 0],
] as const
const clusterArcWeight = 2.5

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function validateInput(input: GridRefinementInput): void {
  if (Number.isInteger(input.width) === false || input.width <= 0
    || Number.isInteger(input.height) === false || input.height <= 0) {
    throw new RangeError('Grid refinement dimensions must be positive integers')
  }
  const cells = input.width * input.height
  if (input.colorIds.length !== cells || input.activeMask.length !== cells
    || input.pixelLabs.length !== cells || input.boundaryStrength.length !== cells
    || input.importance.length !== cells) {
    throw new RangeError('Grid refinement arrays must align with the grid')
  }
  if (input.colors.length === 0) throw new RangeError('Grid refinement requires material colors')
  const colorIds = new Set(input.colors.map((color) => color.id))
  for (let cell = 0; cell < cells; cell += 1) {
    if (input.activeMask[cell] !== 0 && input.activeMask[cell] !== 1) {
      throw new RangeError('Grid refinement mask must be binary')
    }
    if (input.activeMask[cell] === 1 && colorIds.has(input.colorIds[cell]!) === false) {
      throw new RangeError('Grid refinement cells must reference a material color')
    }
    if (input.pixelLabs[cell]!.some((value) => Number.isFinite(value) === false)
      || Number.isFinite(input.boundaryStrength[cell]) === false
      || Number.isFinite(input.importance[cell]) === false) {
      throw new RangeError('Grid refinement guidance must be finite')
    }
  }
  for (const cell of input.protectedCells) {
    if (Number.isInteger(cell) === false || cell < 0 || cell >= cells) {
      throw new RangeError('Grid refinement protected cells must stay inside the grid')
    }
  }
}

function cellIndex(x: number, y: number, width: number): number {
  return y * width + x
}

function isActive(input: GridRefinementInput, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < input.width && y < input.height
    && input.activeMask[cellIndex(x, y, input.width)] === 1
}

function symmetryAxis(input: GridRefinementInput): number | undefined {
  const eyes = input.featurePlacements.filter((placement) => placement.kind === 'eye')
    .sort((first, second) => first.center[0] - second.center[0] || first.featureId.localeCompare(second.featureId))
  if (eyes.length < 2) return undefined
  return (eyes[0]!.center[0] + eyes[eyes.length - 1]!.center[0]) / 2
}

function mirroredCell(
  input: GridRefinementInput,
  cell: number,
  axis: number | undefined,
): number | undefined {
  if (axis === undefined) return undefined
  const x = cell % input.width
  const y = Math.floor(cell / input.width)
  const mirrorX = Math.round(axis * 2 - x)
  return isActive(input, mirrorX, y) ? cellIndex(mirrorX, y, input.width) : undefined
}

function dataEnergy(
  input: GridRefinementInput,
  colorsById: ReadonlyMap<string, PreparedColor>,
  cell: number,
  colorId: string,
): number {
  const color = colorsById.get(colorId)!
  return colorDistance(input.pixelLabs[cell]!, color.lab, input.distanceMethod)
    * (0.65 + clamp(input.importance[cell] ?? 0, 0, 2) * 0.7)
}

function colorIdAt(
  colorIds: readonly string[],
  cell: number,
  overrideCell: number,
  overrideId: string,
): string {
  return cell === overrideCell ? overrideId : colorIds[cell]!
}

function neighborArcPenalty(
  input: GridRefinementInput,
  colorIds: readonly string[],
  center: number,
  overrideCell: number,
  overrideId: string,
): number {
  const x = center % input.width
  const y = Math.floor(center / input.width)
  const centerId = colorIdAt(colorIds, center, overrideCell, overrideId)
  let firstMatch: boolean | undefined
  let previousMatch = false
  let transitions = 0
  for (const [offsetX, offsetY] of surroundingClockwise) {
    const nextX = x + offsetX
    const nextY = y + offsetY
    if (isActive(input, nextX, nextY) === false) return 0
    const next = cellIndex(nextX, nextY, input.width)
    const matches = colorIdAt(colorIds, next, overrideCell, overrideId) === centerId
    if (firstMatch === undefined) firstMatch = matches
    else if (matches !== previousMatch) transitions += 1
    previousMatch = matches
  }
  if (previousMatch !== firstMatch) transitions += 1
  return Math.max(0, transitions - 2)
}

function localClusterArcEnergy(
  input: GridRefinementInput,
  colorIds: readonly string[],
  cell: number,
  candidateId: string,
): number {
  if (input.mode !== 'quality') return 0
  const x = cell % input.width
  const y = Math.floor(cell / input.width)
  const minimumX = Math.max(0, x - 1)
  const maximumX = Math.min(input.width - 1, x + 1)
  const minimumY = Math.max(0, y - 1)
  const maximumY = Math.min(input.height - 1, y + 1)
  let energy = 0
  for (let centerY = minimumY; centerY <= maximumY; centerY += 1) {
    for (let centerX = minimumX; centerX <= maximumX; centerX += 1) {
      const center = cellIndex(centerX, centerY, input.width)
      if (input.activeMask[center] !== 1) continue
      energy += neighborArcPenalty(input, colorIds, center, cell, candidateId)
    }
  }
  return energy * clusterArcWeight
}

function localEnergy(
  input: GridRefinementInput,
  colorIds: readonly string[],
  colorsById: ReadonlyMap<string, PreparedColor>,
  cell: number,
  candidateId: string,
  axis: number | undefined,
): number {
  const x = cell % input.width
  const y = Math.floor(cell / input.width)
  const coherence = input.mode === 'quality' ? 1.35 : 1
  let energy = dataEnergy(input, colorsById, cell, candidateId)
  let support = 0
  for (const [offsetX, offsetY] of orthogonal) {
    const nextX = x + offsetX
    const nextY = y + offsetY
    if (isActive(input, nextX, nextY) === false) continue
    const next = cellIndex(nextX, nextY, input.width)
    if (colorIds[next] === candidateId) support += 1
    else {
      const boundary = Math.max(input.boundaryStrength[cell]!, input.boundaryStrength[next]!)
      energy += coherence * 7 * (1 - clamp(boundary, 0, 1))
    }
  }
  if (support === 0) energy += input.mode === 'quality' ? 11 : 8
  else if (support === 1) energy += input.mode === 'quality' ? 3 : 1.5
  if (x > 0 && x + 1 < input.width && isActive(input, x - 1, y) && isActive(input, x + 1, y)) {
    const left = colorIds[cell - 1]
    const right = colorIds[cell + 1]
    if (left === right && left !== candidateId) energy += 6
  }
  if (y > 0 && y + 1 < input.height && isActive(input, x, y - 1) && isActive(input, x, y + 1)) {
    const top = colorIds[cell - input.width]
    const bottom = colorIds[cell + input.width]
    if (top === bottom && top !== candidateId) energy += 6
  }
  for (let top = Math.max(0, y - 1); top <= Math.min(y, input.height - 2); top += 1) {
    for (let left = Math.max(0, x - 1); left <= Math.min(x, input.width - 2); left += 1) {
      const cells = [
        cellIndex(left, top, input.width),
        cellIndex(left + 1, top, input.width),
        cellIndex(left, top + 1, input.width),
        cellIndex(left + 1, top + 1, input.width),
      ]
      if (cells.some((entry) => input.activeMask[entry] !== 1)) continue
      const values = cells.map((entry) => entry === cell ? candidateId : colorIds[entry]!)
      if (values[0] === values[3] && values[1] === values[2] && values[0] !== values[1]) {
        energy += input.mode === 'quality' ? 7 : 3
      }
    }
  }
  const mirror = mirroredCell(input, cell, axis)
  if (input.mode === 'quality' && mirror !== undefined && mirror !== cell
    && colorIds[mirror] !== candidateId) {
    energy += 2.5
  }
  energy += localClusterArcEnergy(input, colorIds, cell, candidateId)
  return energy
}

function totalEnergy(
  input: GridRefinementInput,
  colorIds: readonly string[],
  colorsById: ReadonlyMap<string, PreparedColor>,
  axis: number | undefined,
): number {
  let energy = 0
  for (let cell = 0; cell < colorIds.length; cell += 1) {
    if (input.activeMask[cell] !== 1) continue
    energy += dataEnergy(input, colorsById, cell, colorIds[cell]!)
    const x = cell % input.width
    const y = Math.floor(cell / input.width)
    for (const [offsetX, offsetY] of [[1, 0], [0, 1]] as const) {
      const nextX = x + offsetX
      const nextY = y + offsetY
      if (isActive(input, nextX, nextY) === false) continue
      const next = cellIndex(nextX, nextY, input.width)
      if (colorIds[next] === colorIds[cell]) continue
      const boundary = Math.max(input.boundaryStrength[cell]!, input.boundaryStrength[next]!)
      energy += (input.mode === 'quality' ? 1.35 : 1) * 7 * (1 - clamp(boundary, 0, 1))
    }
    const support = orthogonal.reduce((count, [offsetX, offsetY]) => {
      const nextX = x + offsetX
      const nextY = y + offsetY
      return count + Number(isActive(input, nextX, nextY)
        && colorIds[cellIndex(nextX, nextY, input.width)] === colorIds[cell])
    }, 0)
    if (support === 0) energy += input.mode === 'quality' ? 11 : 8
    else if (support === 1) energy += input.mode === 'quality' ? 3 : 1.5
    const mirror = mirroredCell(input, cell, axis)
    if (input.mode === 'quality' && mirror !== undefined && cell < mirror
      && colorIds[mirror] !== colorIds[cell]) energy += 2.5
    if (input.mode === 'quality') {
      energy += neighborArcPenalty(input, colorIds, cell, cell, colorIds[cell]!) * clusterArcWeight
    }
  }
  for (let y = 0; y + 1 < input.height; y += 1) {
    for (let x = 0; x + 1 < input.width; x += 1) {
      const cells = [
        cellIndex(x, y, input.width),
        cellIndex(x + 1, y, input.width),
        cellIndex(x, y + 1, input.width),
        cellIndex(x + 1, y + 1, input.width),
      ]
      if (cells.some((cell) => input.activeMask[cell] !== 1)) continue
      const values = cells.map((cell) => colorIds[cell]!)
      if (values[0] === values[3] && values[1] === values[2] && values[0] !== values[1]) {
        energy += input.mode === 'quality' ? 7 : 3
      }
    }
  }
  return energy
}

function candidateColors(
  input: GridRefinementInput,
  colorIds: readonly string[],
  cell: number,
  axis: number | undefined,
): readonly string[] {
  const x = cell % input.width
  const y = Math.floor(cell / input.width)
  const candidates = new Set([colorIds[cell]!])
  const offsets = input.mode === 'quality' ? surrounding : orthogonal
  for (const [offsetX, offsetY] of offsets) {
    const nextX = x + offsetX
    const nextY = y + offsetY
    if (isActive(input, nextX, nextY)) {
      candidates.add(colorIds[cellIndex(nextX, nextY, input.width)]!)
    }
  }
  const mirror = mirroredCell(input, cell, axis)
  if (input.mode === 'quality' && mirror !== undefined) candidates.add(colorIds[mirror]!)
  return [...candidates].sort()
}

export function refineGridClusters(input: GridRefinementInput): GridRefinementResult {
  validateInput(input)
  const preparedColors = prepareColors(input.colors)
  const colorsById = new Map(preparedColors.map((color) => [color.id, color]))
  const axis = symmetryAxis(input)
  const original = [...input.colorIds]
  const colorIds = [...input.colorIds]
  const energyBefore = totalEnergy(input, colorIds, colorsById, axis)
  let acceptedEnergy = energyBefore
  let completedIterations = 0
  const maximumIterations = input.mode === 'quality' ? 4 : 1
  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    const snapshot = [...colorIds]
    const order = Array.from({ length: colorIds.length }, (_, index) => index)
    if (iteration % 2 === 1) order.reverse()
    let changes = 0
    for (const cell of order) {
      if (input.activeMask[cell] !== 1 || input.protectedCells.has(cell)) continue
      const currentId = colorIds[cell]!
      let bestId = currentId
      let bestEnergy = localEnergy(input, colorIds, colorsById, cell, currentId, axis)
      for (const candidateId of candidateColors(input, colorIds, cell, axis)) {
        if (candidateId === currentId) continue
        const energy = localEnergy(input, colorIds, colorsById, cell, candidateId, axis)
        if (energy < bestEnergy - 0.25
          || (Math.abs(energy - bestEnergy) <= 1e-9 && candidateId.localeCompare(bestId) < 0)) {
          bestId = candidateId
          bestEnergy = energy
        }
      }
      if (bestId !== currentId) {
        colorIds[cell] = bestId
        changes += 1
      }
    }
    if (changes === 0) break
    const candidateEnergy = totalEnergy(input, colorIds, colorsById, axis)
    if (candidateEnergy > acceptedEnergy + 1e-6) {
      colorIds.splice(0, colorIds.length, ...snapshot)
      break
    }
    acceptedEnergy = candidateEnergy
    completedIterations += 1
  }
  const edits: GridEditRecord[] = []
  for (let cell = 0; cell < colorIds.length; cell += 1) {
    if (input.activeMask[cell] !== 1 || original[cell] === colorIds[cell]) continue
    const mirror = mirroredCell(input, cell, axis)
    edits.push({
      x: cell % input.width,
      y: Math.floor(cell / input.width),
      fromColorId: original[cell]!,
      toColorId: colorIds[cell]!,
      reason: mirror !== undefined && original[mirror] === colorIds[cell]
        ? 'symmetry'
        : 'cluster-refinement',
    })
  }
  return {
    mode: input.mode,
    colorIds,
    edits,
    changedCells: edits.length,
    energyBefore,
    energyAfter: acceptedEnergy,
    iterations: completedIterations,
  }
}
