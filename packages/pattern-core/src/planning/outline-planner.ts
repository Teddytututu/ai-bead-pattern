import type { Lab, OutlineMode } from '../types.js'

export const outlinePlannerSchema = Object.freeze({
  id: 'contrast-aware-outline-v2',
  sources: [
    {
      repository: 'KohakuBlueleaf/PixelOE',
      revision: '341aa85048338d4d26c62fba23176e2b70d9f61b',
      license: 'Apache-2.0',
    },
    {
      repository: 'Orama-Interactive/Pixelorama',
      revision: '8ce32186e65ecb9cba6e3b26c5b837a1c66a4ad1',
      license: 'MIT',
    },
  ],
})

export interface OutlinePlanningInput {
  width: number
  height: number
  activeMask: Uint8Array
  boundaryStrength: Float32Array
  regionIds: Int32Array
  pixelLabs: readonly Lab[]
  mode: OutlineMode
  importance?: Float32Array
  lightDirection?: readonly [x: number, y: number]
}

export interface OutlinePlanningDiagnostics {
  mode: OutlineMode
  candidateBoundaryCells: number
  selectedOutlineCells: number
  silhouetteBoundaryCells: number
  internalBoundaryCells: number
  openLightFacingCells: number
  contrastRetainedCells: number
  importanceRetainedCells: number
  shortRunIrregularitiesBefore: number
  shortRunIrregularitiesAfter: number
  singleCellSpursBefore: number
  singleCellSpursAfter: number
  protectedRhythmCells: number
  regularizedOutlineCells: number
  topologyRejectedEdits: number
  outlineComponentsBefore: number
  outlineComponentsAfter: number
  outlineHolesBefore: number
  outlineHolesAfter: number
}

export interface OutlinePlanningResult {
  mask: Uint8Array
  diagnostics: OutlinePlanningDiagnostics
}

const modes = new Set<OutlineMode>(['off', 'selective', 'full'])
const localContrastThreshold = 0.16
const darkDetailThreshold = 0.08
const importantCellThreshold = 0.85
const structureBoundaryThreshold = 0.65
const strongStructureBoundaryThreshold = 0.75
const lightFacingThreshold = 0.1
const rhythmProtectionThreshold = 0.85
const orthogonalOffsets = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const
const surroundingOffsets = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
] as const
const diagonalOffsets = [
  [-1, -1], [1, -1],
  [-1, 1], [1, 1],
] as const

interface OutlineTopology {
  components: number
  holes: number
}

interface OutlineRhythmCandidates {
  shortRuns: ReadonlySet<number>
  spurs: ReadonlySet<number>
}

interface OutlineRhythmResult {
  regularizedCells: number
  topologyRejectedEdits: number
  protectedRhythmCells: number
  before: OutlineRhythmCandidates
  after: OutlineRhythmCandidates
  topologyBefore: OutlineTopology
  topologyAfter: OutlineTopology
}

function validateInput(input: OutlinePlanningInput): void {
  if (Number.isInteger(input.width) === false || Number.isInteger(input.height) === false
    || input.width <= 0 || input.height <= 0) {
    throw new RangeError('Outline planning dimensions must be positive integers')
  }
  const length = input.width * input.height
  if (input.activeMask.length !== length
    || input.boundaryStrength.length !== length
    || input.regionIds.length !== length
    || input.pixelLabs.length !== length
    || (input.importance !== undefined && input.importance.length !== length)) {
    throw new RangeError('Outline planning arrays must align with the grid')
  }
  if (modes.has(input.mode) === false) throw new RangeError('Outline planning mode is invalid')
  for (const lab of input.pixelLabs) {
    if (lab.length !== 3 || lab.some((value) => Number.isFinite(value) === false)) {
      throw new RangeError('Outline planning Lab values must be finite triples')
    }
  }
}

function normalizedDirection(value: readonly [number, number] | undefined): readonly [number, number] {
  const x = value?.[0] ?? -1
  const y = value?.[1] ?? -1
  const length = Math.hypot(x, y)
  return length <= 1e-9 ? [-Math.SQRT1_2, -Math.SQRT1_2] : [x / length, y / length]
}

function activeCentroid(input: OutlinePlanningInput): readonly [number, number] {
  let sumX = 0
  let sumY = 0
  let count = 0
  for (let index = 0; index < input.activeMask.length; index += 1) {
    if (input.activeMask[index] !== 1) continue
    sumX += index % input.width
    sumY += Math.floor(index / input.width)
    count += 1
  }
  return count === 0
    ? [(input.width - 1) / 2, (input.height - 1) / 2]
    : [sumX / count, sumY / count]
}

function fourNeighbors(index: number, width: number, height: number): readonly number[] {
  const x = index % width
  const y = Math.floor(index / width)
  const result: number[] = []
  if (x > 0) result.push(index - 1)
  if (x + 1 < width) result.push(index + 1)
  if (y > 0) result.push(index - width)
  if (y + 1 < height) result.push(index + width)
  return result
}

function neighbors(
  index: number,
  width: number,
  height: number,
  offsets: readonly (readonly [number, number])[],
): readonly number[] {
  const x = index % width
  const y = Math.floor(index / width)
  const result: number[] = []
  for (const [offsetX, offsetY] of offsets) {
    const nextX = x + offsetX
    const nextY = y + offsetY
    if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
    result.push(nextY * width + nextX)
  }
  return result
}

function selectedNeighbors(
  mask: Uint8Array,
  index: number,
  width: number,
  height: number,
  offsets: readonly (readonly [number, number])[],
): readonly number[] {
  return neighbors(index, width, height, offsets).filter((neighbor) => mask[neighbor] === 1)
}

function isCanvasEdge(index: number, width: number, height: number): boolean {
  const x = index % width
  const y = Math.floor(index / width)
  return x === 0 || y === 0 || x === width - 1 || y === height - 1
}

function componentCount(
  mask: Uint8Array,
  width: number,
  height: number,
  value: 0 | 1,
  offsets: readonly (readonly [number, number])[],
  holesOnly = false,
): number {
  const visited = new Uint8Array(mask.length)
  let count = 0
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== value || visited[start] === 1) continue
    const queue = [start]
    visited[start] = 1
    let touchesBorder = false
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const cell = queue[cursor]!
      const x = cell % width
      const y = Math.floor(cell / width)
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true
      for (const neighbor of neighbors(cell, width, height, offsets)) {
        if (mask[neighbor] !== value || visited[neighbor] === 1) continue
        visited[neighbor] = 1
        queue.push(neighbor)
      }
    }
    if (holesOnly === false || touchesBorder === false) count += 1
  }
  return count
}

function outlineTopology(mask: Uint8Array, width: number, height: number): OutlineTopology {
  return {
    components: componentCount(mask, width, height, 1, surroundingOffsets),
    holes: componentCount(mask, width, height, 0, surroundingOffsets, true),
  }
}

function rhythmCandidates(mask: Uint8Array, width: number, height: number): OutlineRhythmCandidates {
  const shortRuns = new Set<number>()
  for (let y = 0; y + 1 < height; y += 1) {
    for (let x = 0; x + 1 < width; x += 1) {
      const cells = [
        y * width + x,
        y * width + x + 1,
        (y + 1) * width + x,
        (y + 1) * width + x + 1,
      ]
      const selected = cells.filter((cell) => mask[cell] === 1)
      if (selected.length !== 3) continue
      for (const cell of selected) {
        if (isCanvasEdge(cell, width, height)) continue
        const selectedInBlock = selected.filter((neighbor) => neighbor !== cell)
        const cellX = cell % width
        const cellY = Math.floor(cell / width)
        const orthogonalInBlock = selectedInBlock.filter((neighbor) => {
          const neighborX = neighbor % width
          const neighborY = Math.floor(neighbor / width)
          return Math.abs(neighborX - cellX) + Math.abs(neighborY - cellY) === 1
        })
        if (orthogonalInBlock.length !== 2) continue
        if (selectedNeighbors(mask, cell, width, height, orthogonalOffsets).length !== 2) continue
        shortRuns.add(cell)
      }
    }
  }

  const spurs = new Set<number>()
  for (let cell = 0; cell < mask.length; cell += 1) {
    if (mask[cell] !== 1 || isCanvasEdge(cell, width, height)) continue
    const orthogonal = selectedNeighbors(mask, cell, width, height, orthogonalOffsets)
    if (orthogonal.length !== 1) continue
    if (selectedNeighbors(mask, cell, width, height, diagonalOffsets).length < 2) continue
    const attachment = orthogonal[0]!
    if (selectedNeighbors(mask, attachment, width, height, orthogonalOffsets).length >= 3) {
      spurs.add(cell)
    }
  }
  return { shortRuns, spurs }
}

function sameTopology(first: OutlineTopology, second: OutlineTopology): boolean {
  return first.components === second.components && first.holes === second.holes
}

function regularizeOutlineRhythm(
  input: OutlinePlanningInput,
  mask: Uint8Array,
): OutlineRhythmResult {
  const topologyBefore = outlineTopology(mask, input.width, input.height)
  const before = rhythmCandidates(mask, input.width, input.height)
  const initialCandidates = new Set([...before.shortRuns, ...before.spurs])
  const protectedRhythmCells = [...initialCandidates].filter((cell) =>
    (input.importance?.[cell] ?? 0) >= rhythmProtectionThreshold).length
  let regularizedCells = 0
  let topologyRejectedEdits = 0

  for (let pass = 0; pass < 2; pass += 1) {
    const current = rhythmCandidates(mask, input.width, input.height)
    const candidates = [
      ...[...current.shortRuns].sort((first, second) => first - second),
      ...[...current.spurs].sort((first, second) => first - second),
    ]
    let changes = 0
    for (const cell of candidates) {
      if (mask[cell] !== 1 || (input.importance?.[cell] ?? 0) >= rhythmProtectionThreshold) continue
      const refreshed = rhythmCandidates(mask, input.width, input.height)
      if (refreshed.shortRuns.has(cell) === false && refreshed.spurs.has(cell) === false) continue
      mask[cell] = 0
      const candidateTopology = outlineTopology(mask, input.width, input.height)
      if (sameTopology(topologyBefore, candidateTopology) === false) {
        mask[cell] = 1
        topologyRejectedEdits += 1
        continue
      }
      regularizedCells += 1
      changes += 1
    }
    if (changes === 0) break
  }

  return {
    regularizedCells,
    topologyRejectedEdits,
    protectedRhythmCells,
    before,
    after: rhythmCandidates(mask, input.width, input.height),
    topologyBefore,
    topologyAfter: outlineTopology(mask, input.width, input.height),
  }
}

function isSilhouetteBoundary(input: OutlinePlanningInput, index: number): boolean {
  const x = index % input.width
  const y = Math.floor(index / input.width)
  if (x === 0 || y === 0 || x === input.width - 1 || y === input.height - 1) return true
  return fourNeighbors(index, input.width, input.height)
    .some((neighbor) => input.activeMask[neighbor] !== 1)
}

function isInternalBoundary(input: OutlinePlanningInput, index: number): boolean {
  if ((input.boundaryStrength[index] ?? 0) < structureBoundaryThreshold) return false
  const regionId = input.regionIds[index]
  return fourNeighbors(index, input.width, input.height).some((neighbor) =>
    input.activeMask[neighbor] === 1 && input.regionIds[neighbor] !== regionId)
}

function localLightnessStats(
  input: OutlinePlanningInput,
  index: number,
): { contrast: number; darkDetail: number } {
  const centerX = index % input.width
  const centerY = Math.floor(index / input.width)
  const lightness: number[] = []
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      const x = centerX + offsetX
      const y = centerY + offsetY
      if (x < 0 || y < 0 || x >= input.width || y >= input.height) continue
      const neighbor = y * input.width + x
      if (input.activeMask[neighbor] !== 1) continue
      lightness.push(input.pixelLabs[neighbor]![0])
    }
  }
  lightness.sort((first, second) => first - second)
  const minimum = lightness[0] ?? input.pixelLabs[index]![0]
  const maximum = lightness.at(-1) ?? input.pixelLabs[index]![0]
  const median = lightness[Math.floor(lightness.length / 2)] ?? input.pixelLabs[index]![0]
  return {
    contrast: Math.min(1, Math.max(0, (maximum - minimum) / 100)),
    darkDetail: Math.min(1, Math.max(0, (median - input.pixelLabs[index]![0]) / 100)),
  }
}

function isLightFacing(
  input: OutlinePlanningInput,
  index: number,
  centroid: readonly [number, number],
  direction: readonly [number, number],
): boolean {
  const x = index % input.width
  const y = Math.floor(index / input.width)
  const offsetX = x - centroid[0]
  const offsetY = y - centroid[1]
  const length = Math.hypot(offsetX, offsetY)
  if (length <= 1e-9) return false
  return (offsetX / length) * direction[0] + (offsetY / length) * direction[1]
    > lightFacingThreshold
}

/**
 * Converts PixelOE's contrast-aware outline-expansion principle into a deterministic
 * one-cell bead-grid plan. High-contrast and identity-weighted edges survive while
 * quiet edges facing the light remain open in selective mode.
 */
export function planContrastAwareOutline(input: OutlinePlanningInput): OutlinePlanningResult {
  validateInput(input)
  const mask = new Uint8Array(input.activeMask.length)
  const direction = normalizedDirection(input.lightDirection)
  const centroid = activeCentroid(input)
  let candidateBoundaryCells = 0
  let silhouetteBoundaryCells = 0
  let internalBoundaryCells = 0
  let openLightFacingCells = 0
  let contrastRetainedCells = 0
  let importanceRetainedCells = 0

  for (let index = 0; index < input.activeMask.length; index += 1) {
    if (input.activeMask[index] !== 1) continue
    const silhouette = isSilhouetteBoundary(input, index)
    const internal = isInternalBoundary(input, index)
    if (silhouette === false && internal === false) continue
    candidateBoundaryCells += 1
    if (silhouette) silhouetteBoundaryCells += 1
    if (internal) internalBoundaryCells += 1
    if (input.mode === 'off') continue
    if (input.mode === 'full') {
      mask[index] = 1
      continue
    }

    const { contrast, darkDetail } = localLightnessStats(input, index)
    const contrastRetained = contrast >= localContrastThreshold
      || darkDetail >= darkDetailThreshold
      || (internal && (input.boundaryStrength[index] ?? 0) >= strongStructureBoundaryThreshold)
    const importanceRetained = (input.importance?.[index] ?? 0) >= importantCellThreshold
    const lightFacing = isLightFacing(input, index, centroid, direction)
    if (contrastRetained || importanceRetained || lightFacing === false) {
      mask[index] = 1
      if (contrastRetained) contrastRetainedCells += 1
      if (importanceRetained) importanceRetainedCells += 1
    } else {
      openLightFacingCells += 1
    }
  }

  const rhythm = input.mode === 'off'
    ? {
        regularizedCells: 0,
        topologyRejectedEdits: 0,
        protectedRhythmCells: 0,
        before: { shortRuns: new Set<number>(), spurs: new Set<number>() },
        after: { shortRuns: new Set<number>(), spurs: new Set<number>() },
        topologyBefore: { components: 0, holes: 0 },
        topologyAfter: { components: 0, holes: 0 },
      }
    : regularizeOutlineRhythm(input, mask)

  return {
    mask,
    diagnostics: {
      mode: input.mode,
      candidateBoundaryCells,
      selectedOutlineCells: mask.reduce((sum, value) => sum + value, 0),
      silhouetteBoundaryCells,
      internalBoundaryCells,
      openLightFacingCells,
      contrastRetainedCells,
      importanceRetainedCells,
      shortRunIrregularitiesBefore: rhythm.before.shortRuns.size,
      shortRunIrregularitiesAfter: rhythm.after.shortRuns.size,
      singleCellSpursBefore: rhythm.before.spurs.size,
      singleCellSpursAfter: rhythm.after.spurs.size,
      protectedRhythmCells: rhythm.protectedRhythmCells,
      regularizedOutlineCells: rhythm.regularizedCells,
      topologyRejectedEdits: rhythm.topologyRejectedEdits,
      outlineComponentsBefore: rhythm.topologyBefore.components,
      outlineComponentsAfter: rhythm.topologyAfter.components,
      outlineHolesBefore: rhythm.topologyBefore.holes,
      outlineHolesAfter: rhythm.topologyAfter.holes,
    },
  }
}
