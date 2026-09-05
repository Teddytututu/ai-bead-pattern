import { colorDistance, prepareColors, type PreparedColor } from './color.js'
import type {
  ColorDistanceMethod,
  GridEditRecord,
  GridBudgetViolations,
  GridClusterDiagnostics,
  GridRefinementBudgets,
  GridRefinementMode,
  GridRefinementSummary,
  Lab,
  MaterialColor,
} from './types.js'
import type { ResolvedFeaturePlacement } from './planning/feature-placement.js'

export const gridRefinementSchema = Object.freeze({
  id: 'semantic-rag-branch-refinement-v2',
  sources: Object.freeze([
    'scikit-image/scikit-image@ee0a7a3ebd9ac8c2602f40e55bc015a3c8a81ae8',
    'jni/skan@94ec591f4a2763795b84141d6a85cb6fd0ab6b2a',
    'e-koch/FilFinder@bbb06edc167d177f61fccf600fb812fdf904ddb6',
  ]),
  licenses: Object.freeze(['BSD-3-Clause', 'BSD-3-Clause', 'MIT']),
})

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
  budgets?: GridRefinementBudgets
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
const strongSemanticBoundary = 0.85
const weakMergeBoundary = 0.65
const weakBranchImportance = 0.45

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

function expandedProtectedCells(input: GridRefinementInput): ReadonlySet<number> {
  const cells = new Set(input.protectedCells)
  for (const placement of input.featurePlacements) {
    for (const cell of placement.occupiedCells) cells.add(cell)
  }
  for (let cell = 0; cell < input.activeMask.length; cell += 1) {
    if (input.activeMask[cell] === 1
      && input.boundaryStrength[cell]! >= strongSemanticBoundary
      && input.importance[cell]! >= 0.3) {
      cells.add(cell)
    }
  }
  return cells
}

function sameColorNeighbors(
  input: GridRefinementInput,
  colorIds: readonly string[],
  cell: number,
): number[] {
  const x = cell % input.width
  const y = Math.floor(cell / input.width)
  const colorId = colorIds[cell]
  const neighbors: number[] = []
  for (const [offsetX, offsetY] of orthogonal) {
    const nextX = x + offsetX
    const nextY = y + offsetY
    if (isActive(input, nextX, nextY) === false) continue
    const next = cellIndex(nextX, nextY, input.width)
    if (colorIds[next] === colorId) neighbors.push(next)
  }
  return neighbors.sort((first, second) => first - second)
}

function colorComponents(
  input: GridRefinementInput,
  colorIds: readonly string[],
): number[][] {
  const visited = new Uint8Array(colorIds.length)
  const components: number[][] = []
  for (let start = 0; start < colorIds.length; start += 1) {
    if (input.activeMask[start] !== 1 || visited[start] === 1) continue
    const queue = [start]
    visited[start] = 1
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const cell = queue[cursor]!
      for (const next of sameColorNeighbors(input, colorIds, cell)) {
        if (visited[next] === 1) continue
        visited[next] = 1
        queue.push(next)
      }
    }
    components.push(queue.sort((first, second) => first - second))
  }
  return components
}

function shortestPaths(
  start: number,
  component: ReadonlySet<number>,
  adjacency: ReadonlyMap<number, readonly number[]>,
): { distances: Map<number, number>; previous: Map<number, number> } {
  const distances = new Map<number, number>([[start, 0]])
  const previous = new Map<number, number>()
  const queue = [start]
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const cell = queue[cursor]!
    for (const next of adjacency.get(cell) ?? []) {
      if (component.has(next) === false || distances.has(next)) continue
      distances.set(next, distances.get(cell)! + 1)
      previous.set(next, cell)
      queue.push(next)
    }
  }
  return { distances, previous }
}

function longestShortestPath(
  componentCells: readonly number[],
  adjacency: ReadonlyMap<number, readonly number[]>,
): readonly number[] {
  const endpoints = componentCells.filter((cell) => (adjacency.get(cell)?.length ?? 0) <= 1)
    .sort((first, second) => first - second)
  if (endpoints.length < 2) return []
  const component = new Set(componentCells)
  if (endpoints.length > 64) {
    const firstDistances = shortestPaths(endpoints[0]!, component, adjacency).distances
    const firstEnd = [...endpoints].sort((first, second) =>
      (firstDistances.get(second) ?? -1) - (firstDistances.get(first) ?? -1)
      || first - second)[0]!
    const secondSearch = shortestPaths(firstEnd, component, adjacency)
    const secondEnd = [...endpoints].sort((first, second) =>
      (secondSearch.distances.get(second) ?? -1) - (secondSearch.distances.get(first) ?? -1)
      || first - second)[0]!
    const reversed = [secondEnd]
    while (reversed.at(-1) !== firstEnd) {
      const next = secondSearch.previous.get(reversed.at(-1)!)
      if (next === undefined) return []
      reversed.push(next)
    }
    return reversed.reverse()
  }
  let bestStart = endpoints[0]!
  let bestEnd = endpoints[1]!
  let bestDistance = -1
  for (let startIndex = 0; startIndex < endpoints.length; startIndex += 1) {
    const start = endpoints[startIndex]!
    const { distances } = shortestPaths(start, component, adjacency)
    for (let endIndex = startIndex + 1; endIndex < endpoints.length; endIndex += 1) {
      const end = endpoints[endIndex]!
      const distance = distances.get(end) ?? -1
      if (distance > bestDistance
        || (distance === bestDistance && (start < bestStart || (start === bestStart && end < bestEnd)))) {
        bestDistance = distance
        bestStart = start
        bestEnd = end
      }
    }
  }
  const { previous } = shortestPaths(bestStart, component, adjacency)
  const reversed = [bestEnd]
  while (reversed.at(-1) !== bestStart) {
    const next = previous.get(reversed.at(-1)!)
    if (next === undefined) return []
    reversed.push(next)
  }
  return reversed.reverse()
}

function semanticAnchorPath(
  componentCells: readonly number[],
  adjacency: ReadonlyMap<number, readonly number[]>,
  semanticEndpointCells: ReadonlySet<number>,
): readonly number[] {
  const component = new Set(componentCells)
  const anchors = componentCells.filter((cell) => semanticEndpointCells.has(cell))
  if (anchors.length < 2) return []
  let bestStart = anchors[0]!
  let bestEnd = anchors[1]!
  let bestDistance = -1
  for (let startIndex = 0; startIndex < anchors.length; startIndex += 1) {
    const start = anchors[startIndex]!
    const { distances } = shortestPaths(start, component, adjacency)
    for (let endIndex = startIndex + 1; endIndex < anchors.length; endIndex += 1) {
      const end = anchors[endIndex]!
      const distance = distances.get(end) ?? -1
      if (distance > bestDistance
        || (distance === bestDistance && (start < bestStart || (start === bestStart && end < bestEnd)))) {
        bestDistance = distance
        bestStart = start
        bestEnd = end
      }
    }
  }
  if (bestDistance < 0) return []
  const { previous } = shortestPaths(bestStart, component, adjacency)
  const reversed = [bestEnd]
  while (reversed.at(-1) !== bestStart) {
    const next = previous.get(reversed.at(-1)!)
    if (next === undefined) return []
    reversed.push(next)
  }
  return reversed.reverse()
}

interface ColorTopologyGuidance {
  protectedMainPathCells: ReadonlySet<number>
  weakBranches: readonly (readonly number[])[]
}

function colorTopologyGuidance(
  input: GridRefinementInput,
  colorIds: readonly string[],
  baseProtectedCells: ReadonlySet<number>,
): ColorTopologyGuidance {
  const protectedMainPathCells = new Set<number>()
  const weakBranches: number[][] = []
  const semanticEndpointCells = new Set(input.featurePlacements.flatMap((placement) =>
    placement.roles
      .filter(({ role }) => role === 'endpoint-dark')
      .map(({ cell }) => cell)))
  const maximumWeakBranchLength = Math.max(
    1,
    Math.min(4, Math.round(Math.min(input.width, input.height) / 16)),
  )
  for (const componentCells of colorComponents(input, colorIds)) {
    if (componentCells.length < 3) continue
    const adjacency = new Map(componentCells.map((cell) => [
      cell,
      sameColorNeighbors(input, colorIds, cell),
    ]))
    const anchoredPath = semanticAnchorPath(componentCells, adjacency, semanticEndpointCells)
    const mainPath = anchoredPath.length >= 2
      ? anchoredPath
      : longestShortestPath(componentCells, adjacency)
    if (mainPath.length < 2) continue
    const mainPathSet = new Set(mainPath)
    if (anchoredPath.length >= 2) {
      for (const cell of anchoredPath) protectedMainPathCells.add(cell)
    }
    const endpoints = componentCells.filter((cell) => (adjacency.get(cell)?.length ?? 0) <= 1)
      .sort((first, second) => first - second)
    for (const endpoint of endpoints) {
      if (mainPathSet.has(endpoint)) continue
      const branch = [endpoint]
      let previous = -1
      let current = endpoint
      let joinsMainPath = false
      while (branch.length <= maximumWeakBranchLength) {
        const nextCells = (adjacency.get(current) ?? []).filter((cell) => cell !== previous)
        if (nextCells.length !== 1) break
        const next = nextCells[0]!
        if (mainPathSet.has(next)) {
          joinsMainPath = true
          break
        }
        branch.push(next)
        previous = current
        current = next
      }
      if (joinsMainPath === false || branch.length > maximumWeakBranchLength) continue
      const weakEvidence = branch.every((cell) => baseProtectedCells.has(cell) === false
        && input.importance[cell]! < weakBranchImportance
        && input.boundaryStrength[cell]! < strongSemanticBoundary)
      if (weakEvidence) weakBranches.push(branch)
    }
  }
  return { protectedMainPathCells, weakBranches }
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
  if (input.budgets !== undefined) {
    for (const [label, value] of Object.entries(input.budgets)) {
      if (Number.isInteger(value) === false || value < 0) {
        throw new RangeError(`Grid refinement ${label} budget must be a non-negative integer`)
      }
    }
  }
  if (previousMatch !== firstMatch) transitions += 1
  return Math.max(0, transitions - 2)
}

function isProtectedDiagonalTransition(
  input: GridRefinementInput,
  cells: readonly number[],
  values: readonly string[],
): boolean {
  if (values[0] !== values[3] || values[1] !== values[2] || values[0] === values[1]) return false
  const firstDiagonalProtected = input.protectedCells.has(cells[0]!)
    && input.protectedCells.has(cells[3]!)
  const secondDiagonalProtected = input.protectedCells.has(cells[1]!)
    && input.protectedCells.has(cells[2]!)
  return firstDiagonalProtected || secondDiagonalProtected
}

function belongsToProtectedDiagonalTransition(
  input: GridRefinementInput,
  colorIds: readonly string[],
  cell: number,
): boolean {
  const x = cell % input.width
  const y = Math.floor(cell / input.width)
  for (let top = Math.max(0, y - 1); top <= Math.min(y, input.height - 2); top += 1) {
    for (let left = Math.max(0, x - 1); left <= Math.min(x, input.width - 2); left += 1) {
      const cells = [
        cellIndex(left, top, input.width),
        cellIndex(left + 1, top, input.width),
        cellIndex(left, top + 1, input.width),
        cellIndex(left + 1, top + 1, input.width),
      ]
      if (cells.some((entry) => input.activeMask[entry] !== 1)) continue
      const values = cells.map((entry) => colorIds[entry]!)
      if (isProtectedDiagonalTransition(input, cells, values)) return true
    }
  }
  return false
}

function gridClusterDiagnostics(
  input: GridRefinementInput,
  colorIds: readonly string[],
): GridClusterDiagnostics {
  let fragmentedArcSegments = 0
  let singleCellBands = 0
  let transitionCells = 0
  let colorSwitches = 0
  let localNoiseCells = 0
  let ditherPatterns = 0
  let protectedDiagonalTransitions = 0
  for (let cell = 0; cell < colorIds.length; cell += 1) {
    if (input.activeMask[cell] !== 1) continue
    fragmentedArcSegments += neighborArcPenalty(input, colorIds, cell, cell, colorIds[cell]!)
    const x = cell % input.width
    const y = Math.floor(cell / input.width)
    let support = 0
    let activeNeighbors = 0
    for (const [offsetX, offsetY] of orthogonal) {
      const nextX = x + offsetX
      const nextY = y + offsetY
      if (isActive(input, nextX, nextY) === false) continue
      activeNeighbors += 1
      if (colorIds[cellIndex(nextX, nextY, input.width)] === colorIds[cell]) support += 1
    }
    if (activeNeighbors > 0 && support <= 1) localNoiseCells += 1
    if (support > 0 && support < activeNeighbors) transitionCells += 1
    if (x + 1 < input.width && isActive(input, x + 1, y)
      && colorIds[cell + 1] !== colorIds[cell]) colorSwitches += 1
    if (y + 1 < input.height && isActive(input, x, y + 1)
      && colorIds[cell + input.width] !== colorIds[cell]) colorSwitches += 1
    const horizontalBand = x > 0 && x + 1 < input.width
      && isActive(input, x - 1, y) && isActive(input, x + 1, y)
      && colorIds[cell - 1] === colorIds[cell + 1]
      && colorIds[cell - 1] !== colorIds[cell]
    const verticalBand = y > 0 && y + 1 < input.height
      && isActive(input, x, y - 1) && isActive(input, x, y + 1)
      && colorIds[cell - input.width] === colorIds[cell + input.width]
      && colorIds[cell - input.width] !== colorIds[cell]
    if (horizontalBand || verticalBand) singleCellBands += 1
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
        if (isProtectedDiagonalTransition(input, cells, values)) protectedDiagonalTransitions += 1
        else ditherPatterns += 1
      }
    }
  }
  const visited = new Uint8Array(colorIds.length)
  let smallComponents = 0
  for (let start = 0; start < colorIds.length; start += 1) {
    if (input.activeMask[start] !== 1 || visited[start] === 1) continue
    const colorId = colorIds[start]
    const queue = [start]
    visited[start] = 1
    let size = 0
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const cell = queue[cursor]!
      size += 1
      const x = cell % input.width
      const y = Math.floor(cell / input.width)
      for (const [offsetX, offsetY] of orthogonal) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (isActive(input, nextX, nextY) === false) continue
        const next = cellIndex(nextX, nextY, input.width)
        if (visited[next] === 1 || colorIds[next] !== colorId) continue
        visited[next] = 1
        queue.push(next)
      }
    }
    if (size <= 2) smallComponents += 1
  }
  return {
    fragmentedArcSegments,
    smallComponents,
    singleCellBands,
    transitionCells,
    colorSwitches,
    localNoiseCells,
    ditherPatterns,
    protectedDiagonalTransitions,
  }
}

function budgetViolations(
  diagnostics: GridClusterDiagnostics,
  budgets: GridRefinementBudgets | undefined,
): GridBudgetViolations {
  if (budgets === undefined) {
    return { transitionCells: 0, ditherPatterns: 0, colorSwitches: 0, localNoiseCells: 0, total: 0 }
  }
  const transitionCells = Math.max(0, diagnostics.transitionCells - budgets.transitionCells)
  const ditherPatterns = Math.max(0, diagnostics.ditherPatterns - budgets.ditherPatterns)
  const colorSwitches = Math.max(0, diagnostics.colorSwitches - budgets.maximumColorSwitches)
  const localNoiseCells = Math.max(0, diagnostics.localNoiseCells - budgets.localNoiseCells)
  return {
    transitionCells,
    ditherPatterns,
    colorSwitches,
    localNoiseCells,
    total: transitionCells + ditherPatterns + colorSwitches + localNoiseCells,
  }
}

function visibleClusterDefectCost(diagnostics: GridClusterDiagnostics): number {
  return diagnostics.fragmentedArcSegments
    + diagnostics.smallComponents * 4
    + diagnostics.singleCellBands * 2
}

function budgetPressure(
  input: GridRefinementInput,
  key: keyof GridRefinementBudgets,
): number {
  if (input.mode !== 'quality' || input.budgets === undefined) return 0
  const capacity = key === 'maximumColorSwitches'
    ? Math.max(1, input.width * (input.height - 1) + input.height * (input.width - 1))
    : Math.max(1, input.width * input.height)
  return clamp(1 - input.budgets[key] / capacity, 0, 1)
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
  const transitionPressure = budgetPressure(input, 'transitionCells')
  const ditherPressure = budgetPressure(input, 'ditherPatterns')
  const switchPressure = budgetPressure(input, 'maximumColorSwitches')
  const noisePressure = budgetPressure(input, 'localNoiseCells')
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
      energy += (coherence + switchPressure * 0.8) * 7 * (1 - clamp(boundary, 0, 1))
    }
  }
  if (support === 0) energy += input.mode === 'quality' ? 11 + noisePressure * 12 : 8
  else if (support === 1) energy += input.mode === 'quality' ? 3 + noisePressure * 7 : 1.5
  if (x > 0 && x + 1 < input.width && isActive(input, x - 1, y) && isActive(input, x + 1, y)) {
    const left = colorIds[cell - 1]
    const right = colorIds[cell + 1]
    if (left === right && left !== candidateId) energy += 6 + transitionPressure * 8
  }
  if (y > 0 && y + 1 < input.height && isActive(input, x, y - 1) && isActive(input, x, y + 1)) {
    const top = colorIds[cell - input.width]
    const bottom = colorIds[cell + input.width]
    if (top === bottom && top !== candidateId) energy += 6 + transitionPressure * 8
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
        if (isProtectedDiagonalTransition(input, cells, values) === false) {
          energy += input.mode === 'quality' ? 7 + ditherPressure * 12 : 3
        }
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
        if (isProtectedDiagonalTransition(input, cells, values) === false) {
          energy += input.mode === 'quality' ? 7 : 3
        }
      }
    }
  }
  const diagnostics = gridClusterDiagnostics(input, colorIds)
  energy += diagnostics.smallComponents * 10 + diagnostics.singleCellBands * 4
  const violations = budgetViolations(diagnostics, input.budgets)
  energy += violations.transitionCells * 3
    + violations.ditherPatterns * 8
    + violations.colorSwitches * 1.5
    + violations.localNoiseCells * 5
  return energy
}

interface GroupMergeEdit {
  cells: readonly number[]
  colorId: string
  energy: number
  defectCost: number
}

function weakBoundaryBetween(input: GridRefinementInput, first: number, second: number): boolean {
  return Math.max(input.boundaryStrength[first]!, input.boundaryStrength[second]!) < weakMergeBoundary
}

function mergeTargetColors(
  input: GridRefinementInput,
  colorIds: readonly string[],
  group: readonly number[],
): readonly string[] {
  const groupSet = new Set(group)
  const currentId = colorIds[group[0]!]
  const sharedBoundary = new Map<string, number>()
  for (const cell of group) {
    const x = cell % input.width
    const y = Math.floor(cell / input.width)
    for (const [offsetX, offsetY] of orthogonal) {
      const nextX = x + offsetX
      const nextY = y + offsetY
      if (isActive(input, nextX, nextY) === false) continue
      const next = cellIndex(nextX, nextY, input.width)
      const nextId = colorIds[next]!
      if (groupSet.has(next) || nextId === currentId || weakBoundaryBetween(input, cell, next) === false) continue
      sharedBoundary.set(nextId, (sharedBoundary.get(nextId) ?? 0) + 1)
    }
  }
  return [...sharedBoundary].sort((first, second) => second[1] - first[1]
    || first[0].localeCompare(second[0])).map(([colorId]) => colorId)
}

function ragMergeGroups(
  input: GridRefinementInput,
  colorIds: readonly string[],
  weakBranches: readonly (readonly number[])[],
): readonly (readonly number[])[] {
  const groups = colorComponents(input, colorIds)
    .filter((component) => component.length <= 2)
    .filter((component) => component.every((cell) => input.protectedCells.has(cell) === false
      && input.importance[cell]! < 0.75
      && input.boundaryStrength[cell]! < strongSemanticBoundary))
  for (const branch of weakBranches) {
    const currentId = colorIds[branch[0]!]
    if (currentId === undefined || branch.some((cell) => colorIds[cell] !== currentId
      || input.protectedCells.has(cell))) continue
    groups.push([...branch])
  }
  const unique = new Map(groups.map((group) => [
    [...group].sort((first, second) => first - second).join(':'),
    [...group].sort((first, second) => first - second),
  ]))
  return [...unique.values()].sort((first, second) => first.length - second.length
    || first[0]! - second[0]!)
}

function bestRagGroupMerge(
  input: GridRefinementInput,
  colorIds: string[],
  colorsById: ReadonlyMap<string, PreparedColor>,
  axis: number | undefined,
  weakBranches: readonly (readonly number[])[],
  acceptedEnergy: number,
  acceptedDefectCost: number,
): GroupMergeEdit | undefined {
  let best: GroupMergeEdit | undefined
  for (const group of ragMergeGroups(input, colorIds, weakBranches)) {
    const originalIds = group.map((cell) => colorIds[cell]!)
    if (new Set(originalIds).size !== 1) continue
    for (const candidateId of mergeTargetColors(input, colorIds, group)) {
      for (const cell of group) colorIds[cell] = candidateId
      const diagnostics = gridClusterDiagnostics(input, colorIds)
      const defectCost = visibleClusterDefectCost(diagnostics)
      if (defectCost < acceptedDefectCost) {
        const energy = totalEnergy(input, colorIds, colorsById, axis)
        if (energy <= acceptedEnergy + 1e-6
          && (best === undefined
            || defectCost < best.defectCost
            || (defectCost === best.defectCost && energy < best.energy - 1e-6)
            || (defectCost === best.defectCost && Math.abs(energy - best.energy) <= 1e-6
              && (group[0]! < best.cells[0]!
                || (group[0] === best.cells[0] && candidateId.localeCompare(best.colorId) < 0))))) {
          best = { cells: [...group], colorId: candidateId, energy, defectCost }
        }
      }
      for (let index = 0; index < group.length; index += 1) {
        colorIds[group[index]!] = originalIds[index]!
      }
    }
  }
  return best
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

function smallComponentCells(
  input: GridRefinementInput,
  colorIds: readonly string[],
): ReadonlySet<number> {
  const visited = new Uint8Array(colorIds.length)
  const cells = new Set<number>()
  for (let start = 0; start < colorIds.length; start += 1) {
    if (input.activeMask[start] !== 1 || visited[start] === 1) continue
    const colorId = colorIds[start]
    const queue = [start]
    visited[start] = 1
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const cell = queue[cursor]!
      const x = cell % input.width
      const y = Math.floor(cell / input.width)
      for (const [offsetX, offsetY] of orthogonal) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (isActive(input, nextX, nextY) === false) continue
        const next = cellIndex(nextX, nextY, input.width)
        if (visited[next] === 1 || colorIds[next] !== colorId) continue
        visited[next] = 1
        queue.push(next)
      }
    }
    if (queue.length <= 2) for (const cell of queue) cells.add(cell)
  }
  return cells
}

function defectCellSeverity(
  input: GridRefinementInput,
  colorIds: readonly string[],
  cell: number,
  smallCells: ReadonlySet<number>,
): number {
  if (input.activeMask[cell] !== 1
    || input.protectedCells.has(cell)
    || belongsToProtectedDiagonalTransition(input, colorIds, cell)) return 0
  const x = cell % input.width
  const y = Math.floor(cell / input.width)
  let support = 0
  let activeNeighbors = 0
  for (const [offsetX, offsetY] of orthogonal) {
    const nextX = x + offsetX
    const nextY = y + offsetY
    if (isActive(input, nextX, nextY) === false) continue
    activeNeighbors += 1
    if (colorIds[cellIndex(nextX, nextY, input.width)] === colorIds[cell]) support += 1
  }
  const horizontalBand = x > 0 && x + 1 < input.width
    && isActive(input, x - 1, y) && isActive(input, x + 1, y)
    && colorIds[cell - 1] === colorIds[cell + 1]
    && colorIds[cell - 1] !== colorIds[cell]
  const verticalBand = y > 0 && y + 1 < input.height
    && isActive(input, x, y - 1) && isActive(input, x, y + 1)
    && colorIds[cell - input.width] === colorIds[cell + input.width]
    && colorIds[cell - input.width] !== colorIds[cell]
  return neighborArcPenalty(input, colorIds, cell, cell, colorIds[cell]!) * 2
    + Number(smallCells.has(cell)) * 6
    + Number(horizontalBand || verticalBand) * 4
    + (activeNeighbors > 0 && support === 0 ? 4 : support === 1 ? 2 : 0)
}

interface SingleDefectEdit {
  cell: number
  colorId: string
  energy: number
  defectCost: number
}

function bestSingleDefectEdit(
  input: GridRefinementInput,
  colorIds: string[],
  colorsById: ReadonlyMap<string, PreparedColor>,
  axis: number | undefined,
  acceptedEnergy: number,
  acceptedDefectCost: number,
): SingleDefectEdit | undefined {
  const smallCells = smallComponentCells(input, colorIds)
  const cells = Array.from({ length: colorIds.length }, (_, cell) => ({
    cell,
    severity: defectCellSeverity(input, colorIds, cell, smallCells),
  }))
    .filter((entry) => entry.severity > 0)
    .sort((first, second) => second.severity - first.severity
      || input.importance[first.cell]! - input.importance[second.cell]!
      || first.cell - second.cell)
    .slice(0, 64)
  let best: SingleDefectEdit | undefined
  for (const { cell } of cells) {
    const currentId = colorIds[cell]!
    for (const candidateId of candidateColors(input, colorIds, cell, axis)) {
      if (candidateId === currentId) continue
      colorIds[cell] = candidateId
      const diagnostics = gridClusterDiagnostics(input, colorIds)
      const defectCost = visibleClusterDefectCost(diagnostics)
      if (defectCost < acceptedDefectCost) {
        const energy = totalEnergy(input, colorIds, colorsById, axis)
        if (energy <= acceptedEnergy + 1e-6
          && (best === undefined
            || defectCost < best.defectCost
            || (defectCost === best.defectCost && energy < best.energy - 1e-6)
            || (defectCost === best.defectCost && Math.abs(energy - best.energy) <= 1e-6
              && (cell < best.cell || (cell === best.cell && candidateId.localeCompare(best.colorId) < 0))))) {
          best = { cell, colorId: candidateId, energy, defectCost }
        }
      }
      colorIds[cell] = currentId
    }
  }
  return best
}

export function refineGridClusters(rawInput: GridRefinementInput): GridRefinementResult {
  validateInput(rawInput)
  const baseProtectedCells = expandedProtectedCells(rawInput)
  const topologyInput: GridRefinementInput = {
    ...rawInput,
    protectedCells: baseProtectedCells,
  }
  const topologyGuidance = colorTopologyGuidance(
    topologyInput,
    rawInput.colorIds,
    baseProtectedCells,
  )
  const input: GridRefinementInput = {
    ...rawInput,
    protectedCells: new Set([
      ...baseProtectedCells,
      ...topologyGuidance.protectedMainPathCells,
    ]),
  }
  validateInput(input)
  const preparedColors = prepareColors(input.colors)
  const colorsById = new Map(preparedColors.map((color) => [color.id, color]))
  const axis = symmetryAxis(input)
  const original = [...input.colorIds]
  const colorIds = [...input.colorIds]
  const diagnosticsBefore = gridClusterDiagnostics(input, original)
  const budgetViolationsBefore = budgetViolations(diagnosticsBefore, input.budgets)
  const energyBefore = totalEnergy(input, colorIds, colorsById, axis)
  let acceptedEnergy = energyBefore
  let acceptedDefectCost = visibleClusterDefectCost(diagnosticsBefore)
  let completedIterations = 0
  if (input.mode === 'quality') {
    for (let step = 0; step < 8; step += 1) {
      const edit = bestRagGroupMerge(
        input,
        colorIds,
        colorsById,
        axis,
        topologyGuidance.weakBranches,
        acceptedEnergy,
        acceptedDefectCost,
      )
      if (edit === undefined) break
      for (const cell of edit.cells) colorIds[cell] = edit.colorId
      acceptedEnergy = edit.energy
      acceptedDefectCost = edit.defectCost
      completedIterations += 1
    }
  }
  const maximumIterations = input.mode === 'quality' ? 4 : 1
  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    const snapshot = [...colorIds]
    const order = Array.from({ length: colorIds.length }, (_, index) => index)
    if (iteration % 2 === 1) order.reverse()
    let changes = 0
    for (const cell of order) {
      if (input.activeMask[cell] !== 1
        || input.protectedCells.has(cell)
        || belongsToProtectedDiagonalTransition(input, colorIds, cell)) continue
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
    const candidateDiagnostics = gridClusterDiagnostics(input, colorIds)
    const candidateDefectCost = visibleClusterDefectCost(candidateDiagnostics)
    if (candidateEnergy > acceptedEnergy + 1e-6
      || candidateDefectCost > acceptedDefectCost) {
      colorIds.splice(0, colorIds.length, ...snapshot)
      break
    }
    acceptedEnergy = candidateEnergy
    acceptedDefectCost = candidateDefectCost
    completedIterations += 1
  }
  if (input.mode === 'quality') {
    for (let step = 0; step < 2; step += 1) {
      const edit = bestSingleDefectEdit(
        input,
        colorIds,
        colorsById,
        axis,
        acceptedEnergy,
        acceptedDefectCost,
      )
      if (edit === undefined) break
      colorIds[edit.cell] = edit.colorId
      acceptedEnergy = edit.energy
      acceptedDefectCost = edit.defectCost
      completedIterations += 1
    }
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
    diagnosticsBefore,
    diagnosticsAfter: gridClusterDiagnostics(input, colorIds),
    ...(input.budgets === undefined ? {} : { budgets: input.budgets }),
    budgetViolationsBefore,
    budgetViolationsAfter: budgetViolations(gridClusterDiagnostics(input, colorIds), input.budgets),
  }
}
