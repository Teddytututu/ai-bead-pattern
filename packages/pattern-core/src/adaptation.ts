import { colorDistance, prepareColors } from './color.js'
import type {
  MaterialDelta,
  PatternAdaptationChange,
  PatternAdaptationRequest,
  PatternAdaptationResult,
  PatternCell,
} from './types.js'

const offsets = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const

function key(x: number, y: number): string {
  return `${x},${y}`
}

function countMaterials(cells: readonly PatternCell[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const cell of cells) counts.set(cell.colorId, (counts.get(cell.colorId) ?? 0) + 1)
  return counts
}

function validateRequest(request: PatternAdaptationRequest): void {
  const { pattern } = request
  if (pattern.width <= 0 || pattern.height <= 0) throw new RangeError('Pattern dimensions must be positive')
  if (request.editableMask !== undefined
    && (request.editableMask.width !== pattern.width
      || request.editableMask.height !== pattern.height
      || request.editableMask.values.length !== pattern.width * pattern.height)) {
    throw new RangeError('Editable mask must align with the pattern')
  }
  for (const value of request.editableMask?.values ?? []) {
    if (Number.isFinite(value) === false || value < 0 || value > 1) {
      throw new RangeError('Editable mask values must stay within 0..1')
    }
  }
  if (request.coherence !== undefined
    && (Number.isFinite(request.coherence) === false || request.coherence < 0)) {
    throw new RangeError('Adaptation coherence must be a finite non-negative number')
  }
  if (request.maxChangedCells !== undefined
    && (Number.isFinite(request.maxChangedCells) === false || request.maxChangedCells < 0)) {
    throw new RangeError('maxChangedCells must be a finite non-negative number')
  }
  const paletteIds = new Set(request.palette.colors.map((color) => color.id))
  for (const cell of [...pattern.cells, ...request.fixedCells]) {
    if (cell.x < 0 || cell.y < 0 || cell.x >= pattern.width || cell.y >= pattern.height) {
      throw new RangeError('Pattern adaptation cell falls outside the board')
    }
    if (paletteIds.has(cell.colorId) === false) {
      throw new RangeError(`Pattern adaptation references unknown color ${cell.colorId}`)
    }
  }
}

export function adaptPattern(
  request: PatternAdaptationRequest,
  algorithmVersion: string,
  generatedAt: number,
): PatternAdaptationResult {
  validateRequest(request)
  const preparedPalette = prepareColors(request.palette.colors)
  const paletteById = new Map(preparedPalette.map((color) => [color.id, color]))
  const target = new Map(request.pattern.cells.map((cell) => [key(cell.x, cell.y), cell.colorId]))
  const fixed = new Map(request.fixedCells.map((cell) => [key(cell.x, cell.y), cell.colorId]))
  const current = new Map(target)
  for (const [cellKey, colorId] of fixed) {
    if (target.has(cellKey)) current.set(cellKey, colorId)
  }
  const editable = (x: number, y: number): boolean => {
    const cellKey = key(x, y)
    if (target.has(cellKey) === false || fixed.has(cellKey)) return false
    if (request.editableMask === undefined) return true
    return (request.editableMask.values[y * request.pattern.width + x] ?? 0) > 0.5
  }
  const coherence = Math.max(0, request.coherence ?? 1.4)
  for (let iteration = 0; iteration < 4; iteration += 1) {
    let changed = 0
    for (const cell of request.pattern.cells) {
      if (editable(cell.x, cell.y) === false) continue
      const cellKey = key(cell.x, cell.y)
      const targetColor = paletteById.get(target.get(cellKey)!)!
      let bestId = current.get(cellKey)!
      let bestEnergy = Number.POSITIVE_INFINITY
      for (const candidate of preparedPalette) {
        let energy = colorDistance(targetColor.lab, candidate.lab, 'delta-e-2000') / 45
        if (candidate.id !== targetColor.id) energy += 0.35
        for (const [offsetX, offsetY] of offsets) {
          const neighbor = current.get(key(cell.x + offsetX, cell.y + offsetY))
          if (neighbor !== undefined && neighbor !== candidate.id) energy += coherence
        }
        if (energy < bestEnergy || (energy === bestEnergy && candidate.id.localeCompare(bestId) < 0)) {
          bestEnergy = energy
          bestId = candidate.id
        }
      }
      if (bestId !== current.get(cellKey)) {
        current.set(cellKey, bestId)
        changed += 1
      }
    }
    if (changed === 0) break
  }
  let proposed = request.pattern.cells
    .filter((cell) => editable(cell.x, cell.y))
    .map((cell) => ({
      x: cell.x,
      y: cell.y,
      fromColorId: target.get(key(cell.x, cell.y))!,
      toColorId: current.get(key(cell.x, cell.y))!,
    }))
    .filter((change) => change.fromColorId !== change.toColorId)
  const maximumChanges = Math.max(0, Math.floor(request.maxChangedCells ?? proposed.length))
  if (proposed.length > maximumChanges) {
    const fixedPoints = request.fixedCells.map((cell) => [cell.x, cell.y] as const)
    proposed = proposed
      .sort((first, second) => {
        const firstDistance = Math.min(...fixedPoints.map(([x, y]) => Math.abs(first.x - x) + Math.abs(first.y - y)))
        const secondDistance = Math.min(...fixedPoints.map(([x, y]) => Math.abs(second.x - x) + Math.abs(second.y - y)))
        return firstDistance - secondDistance || first.y - second.y || first.x - second.x
      })
      .slice(0, maximumChanges)
    const retained = new Set(proposed.map((change) => key(change.x, change.y)))
    for (const cell of request.pattern.cells) {
      const cellKey = key(cell.x, cell.y)
      if (fixed.has(cellKey) === false && retained.has(cellKey) === false) current.set(cellKey, target.get(cellKey)!)
    }
  }
  const changes: PatternAdaptationChange[] = proposed.map((change) => ({ ...change }))
  const cells = request.pattern.cells.map((cell) => ({
    ...cell,
    colorId: current.get(key(cell.x, cell.y))!,
  }))
  const usedIds = new Set(cells.map((cell) => cell.colorId))
  const beforeCounts = countMaterials(request.pattern.cells)
  const afterCounts = countMaterials(cells)
  const materialDelta: MaterialDelta[] = request.palette.colors
    .map((color) => ({
      colorId: color.id,
      delta: (afterCounts.get(color.id) ?? 0) - (beforeCounts.get(color.id) ?? 0),
    }))
    .filter((entry) => entry.delta !== 0)
  return {
    pattern: {
      ...request.pattern,
      palette: request.palette.colors.filter((color) => usedIds.has(color.id)),
      cells,
      metadata: {
        ...request.pattern.metadata,
        generatedAt,
        algorithmVersion,
      },
    },
    changes,
    fixedCellsPreserved: [...fixed.keys()].filter((cellKey) => target.has(cellKey)).length,
    visualDeviation: changes.length / Math.max(1, request.pattern.cells.length - fixed.size),
    materialDelta,
  }
}
