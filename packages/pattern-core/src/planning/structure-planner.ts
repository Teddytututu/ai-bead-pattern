import { deltaE76 } from '../color.js'
import { sourcePointForGridCell, type CanvasFit } from '../image.js'
import type { SourceGuidance } from '../structure.js'
import type { StructurePlan, StructureRegion, FeatureConstraint } from '../contracts.js'
import type { CropRect, Lab } from '../types.js'
import type { ResolvedFeaturePlacement } from './feature-placement.js'

export interface StructurePlanningInput {
  width: number
  height: number
  crop: CropRect
  fit: CanvasFit
  activeMask: Uint8Array
  pixelLabs: readonly Lab[]
  semanticRegionIds: readonly (string | undefined)[]
  importance: readonly number[]
  sourceGuidance: SourceGuidance
  featurePlacements: readonly ResolvedFeaturePlacement[]
  featureConstraints: readonly FeatureConstraint[]
  minimumRegionCells?: number
  maximumSourceShiftCells?: number
}

interface WorkingRegion {
  id: number
  sourceRegionId: string
  cellIndices: number[]
  adjacentRegionIds: number[]
  importance: number
  meanLab: Lab
  protected: boolean
}

const orthogonal = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const
const surrounding = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
] as const

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function validateInput(input: StructurePlanningInput): void {
  if (Number.isInteger(input.width) === false || input.width <= 0
    || Number.isInteger(input.height) === false || input.height <= 0) {
    throw new RangeError('Structure planning dimensions must be positive integers')
  }
  const cells = input.width * input.height
  if (input.activeMask.length !== cells || input.pixelLabs.length !== cells
    || input.semanticRegionIds.length !== cells || input.importance.length !== cells) {
    throw new RangeError('Structure planning arrays must align with the target grid')
  }
  if (input.sourceGuidance.importance.length !== input.sourceGuidance.width * input.sourceGuidance.height
    || input.sourceGuidance.edge.length !== input.sourceGuidance.width * input.sourceGuidance.height) {
    throw new RangeError('Structure source guidance arrays must align with the source image')
  }
  for (const value of input.activeMask) {
    if (value !== 0 && value !== 1) throw new RangeError('Structure active mask must contain binary values')
  }
  for (const lab of input.pixelLabs) {
    if (lab.some((value) => Number.isFinite(value) === false)) {
      throw new RangeError('Structure Lab values must be finite')
    }
  }
  for (const value of input.importance) {
    if (Number.isFinite(value) === false || value < 0) {
      throw new RangeError('Structure importance values must be finite and non-negative')
    }
  }
  const shift = input.maximumSourceShiftCells ?? 0.35
  if (Number.isFinite(shift) === false || shift < 0 || shift > 0.5) {
    throw new RangeError('Structure source shift must stay within 0..0.5 cells')
  }
}

function toneKey(lab: Lab): string {
  return `${Math.floor(lab[0] / 8)}:${Math.floor((lab[1] + 128) / 16)}:${Math.floor((lab[2] + 128) / 16)}`
}

function componentKeys(input: StructurePlanningInput): readonly string[] {
  return input.pixelLabs.map((lab, index) => {
    const semantic = input.semanticRegionIds[index] ?? 'unassigned'
    return `${semantic}|${toneKey(lab)}`
  })
}

function initialRegionIds(input: StructurePlanningInput): Int32Array {
  const keys = componentKeys(input)
  const ids = new Int32Array(input.width * input.height).fill(-1)
  let nextId = 0
  for (let start = 0; start < ids.length; start += 1) {
    if (input.activeMask[start] !== 1 || ids[start] !== -1) continue
    const key = keys[start]
    const queue = [start]
    ids[start] = nextId
    while (queue.length > 0) {
      const current = queue.pop()!
      const x = current % input.width
      const y = Math.floor(current / input.width)
      for (const [offsetX, offsetY] of orthogonal) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX < 0 || nextY < 0 || nextX >= input.width || nextY >= input.height) continue
        const next = nextY * input.width + nextX
        if (input.activeMask[next] !== 1 || ids[next] !== -1 || keys[next] !== key) continue
        ids[next] = nextId
        queue.push(next)
      }
    }
    nextId += 1
  }
  return ids
}

function protectedCells(placements: readonly ResolvedFeaturePlacement[]): ReadonlySet<number> {
  return new Set(placements.flatMap((placement) => placement.occupiedCells))
}

function collectRegions(
  input: StructurePlanningInput,
  regionIds: Int32Array,
  protectedSet: ReadonlySet<number>,
): WorkingRegion[] {
  const cellsById = new Map<number, number[]>()
  for (let cell = 0; cell < regionIds.length; cell += 1) {
    const id = regionIds[cell]!
    if (id < 0) continue
    const cells = cellsById.get(id) ?? []
    cells.push(cell)
    cellsById.set(id, cells)
  }
  const adjacency = new Map<number, Set<number>>()
  for (let cell = 0; cell < regionIds.length; cell += 1) {
    const id = regionIds[cell]!
    if (id < 0) continue
    const x = cell % input.width
    const y = Math.floor(cell / input.width)
    for (const [offsetX, offsetY] of orthogonal) {
      const nextX = x + offsetX
      const nextY = y + offsetY
      if (nextX < 0 || nextY < 0 || nextX >= input.width || nextY >= input.height) continue
      const nextId = regionIds[nextY * input.width + nextX]!
      if (nextId < 0 || nextId === id) continue
      const adjacent = adjacency.get(id) ?? new Set<number>()
      adjacent.add(nextId)
      adjacency.set(id, adjacent)
    }
  }
  return [...cellsById.entries()].map(([id, cellIndices]) => {
    const mean = cellIndices.reduce((sum, cell) => [
      sum[0] + input.pixelLabs[cell]![0],
      sum[1] + input.pixelLabs[cell]![1],
      sum[2] + input.pixelLabs[cell]![2],
    ] as Lab, [0, 0, 0] as Lab)
    const divisor = cellIndices.length
    const semanticCounts = new Map<string, number>()
    for (const cell of cellIndices) {
      const semantic = input.semanticRegionIds[cell] ?? 'unassigned'
      semanticCounts.set(semantic, (semanticCounts.get(semantic) ?? 0) + 1)
    }
    const sourceRegionId = [...semanticCounts].sort((first, second) =>
      second[1] - first[1] || first[0].localeCompare(second[0]))[0]![0]
    const meanLab: Lab = [mean[0] / divisor, mean[1] / divisor, mean[2] / divisor]
    return {
      id,
      sourceRegionId,
      cellIndices,
      adjacentRegionIds: [...(adjacency.get(id) ?? [])].sort((first, second) => first - second),
      importance: clamp(cellIndices.reduce((sum, cell) => sum + Math.min(1, input.importance[cell] ?? 0), 0) / divisor, 0, 1),
      meanLab,
      protected: cellIndices.some((cell) => protectedSet.has(cell)),
    }
  }).sort((first, second) => first.id - second.id)
}

function mergeSmallRegions(
  input: StructurePlanningInput,
  initialIds: Int32Array,
  protectedSet: ReadonlySet<number>,
): Int32Array {
  const ids = Int32Array.from(initialIds)
  const activeCells = input.activeMask.reduce((sum, value) => sum + value, 0)
  const minimum = input.minimumRegionCells
    ?? Math.max(2, Math.min(8, Math.round(activeCells * 0.003)))
  for (let iteration = 0; iteration < 256; iteration += 1) {
    const regions = collectRegions(input, ids, protectedSet)
    const byId = new Map(regions.map((region) => [region.id, region]))
    const sources = regions.filter((region) =>
      region.cellIndices.length < minimum && region.protected === false)
      .sort((first, second) => first.cellIndices.length - second.cellIndices.length || first.id - second.id)
    const merge = sources.map((source) => {
      const target = source.adjacentRegionIds.map((id) => byId.get(id)!)
        .filter((region) => region !== undefined
          && region.protected === false
          && region.sourceRegionId === source.sourceRegionId)
        .map((region) => ({
          region,
          cost: deltaE76(source.meanLab, region.meanLab) / 100
            + source.importance * 0.15
            + 1 / Math.max(1, region.cellIndices.length) * 0.05,
        }))
        .filter((entry) => entry.cost <= 0.55)
        .sort((first, second) => first.cost - second.cost || first.region.id - second.region.id)[0]?.region
      return target === undefined ? undefined : { source, target }
    }).find((entry) => entry !== undefined)
    if (merge === undefined) break
    for (const cell of merge.source.cellIndices) ids[cell] = merge.target.id
  }
  return ids
}

function simplifyBoundaries(
  input: StructurePlanningInput,
  regionIds: Int32Array,
  protectedSet: ReadonlySet<number>,
): Int32Array {
  const output = Int32Array.from(regionIds)
  const regions = collectRegions(input, regionIds, protectedSet)
  const byId = new Map(regions.map((region) => [region.id, region]))
  for (let cell = 0; cell < regionIds.length; cell += 1) {
    const currentId = regionIds[cell]!
    if (currentId < 0 || protectedSet.has(cell)) continue
    const x = cell % input.width
    const y = Math.floor(cell / input.width)
    const counts = new Map<number, number>()
    for (const [offsetX, offsetY] of surrounding) {
      const nextX = x + offsetX
      const nextY = y + offsetY
      if (nextX < 0 || nextY < 0 || nextX >= input.width || nextY >= input.height) continue
      const nextId = regionIds[nextY * input.width + nextX]!
      if (nextId >= 0 && nextId !== currentId) counts.set(nextId, (counts.get(nextId) ?? 0) + 1)
    }
    const dominant = [...counts].sort((first, second) => second[1] - first[1] || first[0] - second[0])[0]
    if (dominant === undefined || dominant[1] < 5) continue
    const current = byId.get(currentId)
    const target = byId.get(dominant[0])
    if (current?.sourceRegionId === target?.sourceRegionId && target?.protected === false) {
      output[cell] = dominant[0]
    }
  }
  return output
}

function normalizeRegions(
  input: StructurePlanningInput,
  regionIds: Int32Array,
  protectedSet: ReadonlySet<number>,
): { regionIds: Int32Array; regions: readonly StructureRegion[] } {
  const regions = collectRegions(input, regionIds, protectedSet)
    .sort((first, second) => first.cellIndices[0]! - second.cellIndices[0]!)
  const normalizedByOld = new Map(regions.map((region, index) => [region.id, index]))
  const normalizedIds = Int32Array.from(regionIds, (id) => id < 0 ? -1 : normalizedByOld.get(id)!)
  const normalizedRegions = regions.map((region, id) => ({
    id,
    sourceRegionId: region.sourceRegionId,
    label: region.sourceRegionId,
    importance: region.importance,
    cellIndices: [...region.cellIndices].sort((first, second) => first - second),
    adjacentRegionIds: region.adjacentRegionIds.map((adjacent) => normalizedByOld.get(adjacent)!)
      .filter((adjacent) => adjacent !== undefined)
      .sort((first, second) => first - second),
  }))
  return { regionIds: normalizedIds, regions: normalizedRegions }
}

function guidanceValue(source: SourceGuidance, values: Float32Array, x: number, y: number): number {
  const safeX = clamp(Math.floor(x), 0, source.width - 1)
  const safeY = clamp(Math.floor(y), 0, source.height - 1)
  return values[safeY * source.width + safeX] ?? 0
}

function buildSourceMapping(
  input: StructurePlanningInput,
  protectedSet: ReadonlySet<number>,
): Float32Array {
  const mapping = new Float32Array(input.width * input.height * 2)
  const maximumShift = input.maximumSourceShiftCells ?? 0.35
  const stepX = input.crop.width / input.fit.width * maximumShift
  const stepY = input.crop.height / input.fit.height * maximumShift
  const fallbackX = input.crop.x + (input.crop.width - 1) / 2
  const fallbackY = input.crop.y + (input.crop.height - 1) / 2
  for (let cell = 0; cell < input.width * input.height; cell += 1) {
    const x = cell % input.width
    const y = Math.floor(cell / input.width)
    const sourcePoint = sourcePointForGridCell(input.crop, input.fit, x, y)
    if (sourcePoint === undefined || input.activeMask[cell] !== 1) {
      mapping[cell * 2] = fallbackX
      mapping[cell * 2 + 1] = fallbackY
      continue
    }
    let bestX = sourcePoint[0]
    let bestY = sourcePoint[1]
    const baseImportance = guidanceValue(
      input.sourceGuidance,
      input.sourceGuidance.importance,
      sourcePoint[0],
      sourcePoint[1],
    )
    const baseEdge = guidanceValue(
      input.sourceGuidance,
      input.sourceGuidance.edge,
      sourcePoint[0],
      sourcePoint[1],
    )
    let bestScore = baseImportance * 0.75 + baseEdge * 0.25
    const diagonal = Math.SQRT1_2
    const offsets = protectedSet.has(cell)
      ? [[0, 0]] as const
      : [
        [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
        [diagonal, diagonal], [-diagonal, diagonal],
        [diagonal, -diagonal], [-diagonal, -diagonal],
      ] as const
    for (const [offsetX, offsetY] of offsets) {
      const candidateX = clamp(sourcePoint[0] + offsetX * stepX, input.crop.x, input.crop.x + input.crop.width - 1)
      const candidateY = clamp(sourcePoint[1] + offsetY * stepY, input.crop.y, input.crop.y + input.crop.height - 1)
      const importance = guidanceValue(input.sourceGuidance, input.sourceGuidance.importance, candidateX, candidateY)
      const edge = guidanceValue(input.sourceGuidance, input.sourceGuidance.edge, candidateX, candidateY)
      const distance = Math.hypot(offsetX, offsetY)
      const score = importance * 0.75 + edge * 0.25 - distance * 0.01
      if (score > bestScore + 0.05) {
        bestScore = score
        bestX = candidateX
        bestY = candidateY
      }
    }
    mapping[cell * 2] = bestX
    mapping[cell * 2 + 1] = bestY
  }
  return mapping
}

function boundaryStrength(
  input: StructurePlanningInput,
  regionIds: Int32Array,
  sourceMapping: Float32Array,
): Float32Array {
  const output = new Float32Array(input.width * input.height)
  for (let cell = 0; cell < output.length; cell += 1) {
    if (input.activeMask[cell] !== 1) continue
    const x = cell % input.width
    const y = Math.floor(cell / input.width)
    let neighbors = 0
    let differences = 0
    for (const [offsetX, offsetY] of orthogonal) {
      const nextX = x + offsetX
      const nextY = y + offsetY
      if (nextX < 0 || nextY < 0 || nextX >= input.width || nextY >= input.height) continue
      const next = nextY * input.width + nextX
      if (input.activeMask[next] !== 1) continue
      neighbors += 1
      if (regionIds[next] !== regionIds[cell]) differences += 1
    }
    const edge = guidanceValue(
      input.sourceGuidance,
      input.sourceGuidance.edge,
      sourceMapping[cell * 2]!,
      sourceMapping[cell * 2 + 1]!,
    )
    output[cell] = clamp(Math.max(edge, neighbors === 0 ? 0 : differences / neighbors), 0, 1)
  }
  return output
}

export function buildStructurePlan(input: StructurePlanningInput): StructurePlan {
  validateInput(input)
  const featureProtected = protectedCells(input.featurePlacements)
  const initial = initialRegionIds(input)
  const merged = mergeSmallRegions(input, initial, featureProtected)
  const simplified = simplifyBoundaries(input, merged, featureProtected)
  const normalized = normalizeRegions(input, simplified, featureProtected)
  const sourceMapping = buildSourceMapping(input, featureProtected)
  const semanticCells = input.semanticRegionIds.filter((id, cell) =>
    input.activeMask[cell] === 1 && id !== undefined).length
  const activeCells = input.activeMask.reduce((sum, value) => sum + value, 0)
  const featureConfidence = input.featurePlacements.length === 0
    ? 0.5
    : input.featurePlacements.reduce((sum, placement) => sum + placement.score, 0) / input.featurePlacements.length
  return {
    width: input.width,
    height: input.height,
    occupancy: {
      width: input.width,
      height: input.height,
      values: Float32Array.from(input.activeMask),
    },
    sourceMapping,
    regionIds: normalized.regionIds,
    boundaryStrength: boundaryStrength(input, normalized.regionIds, sourceMapping),
    regions: normalized.regions,
    featureConstraints: [...input.featureConstraints],
    confidence: clamp(0.55 + (semanticCells / Math.max(1, activeCells)) * 0.35 + featureConfidence * 0.1, 0, 1),
  }
}
