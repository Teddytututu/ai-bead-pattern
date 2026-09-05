import {
  buildMedialGraph,
  type MedialGraph,
  type MedialGraphBranch,
  type MedialGraphNode,
  type MedialGraphNodeKind,
} from './medial-graph.js'
import {
  gridCellForSourcePoint,
  sourcePointForGridCell,
  type CanvasFit,
} from './image.js'
import { buildSourceShapeModel, type SourceShapeModel } from './shape.js'
import type { CropRect } from './types.js'

export interface TopologyMask {
  width: number
  height: number
  values: ArrayLike<number>
}

export interface TopologyAgreementOptions {
  threshold?: number
  endpointWeight?: number
  junctionWeight?: number
  nodeMatchRadiusCells?: number
  coverageRadiusCells?: number
}

export interface TopologyShapeSummary {
  foregroundCells: number
  skeletonCells: number
  components: number
  endpoints: number
  junctions: number
  cycles: number
  branches: number
}

export interface TopologyNodeMatch {
  referenceCount: number
  candidateCount: number
  matchedCount: number
  precision: number
  recall: number
  f1: number
}

export interface TopologyAgreementDiagnostics {
  reference: TopologyShapeSummary
  candidate: TopologyShapeSummary
  centerlinePrecision: number
  centerlineRecall: number
  clDice: number
  backgroundCenterlinePrecision: number
  backgroundCenterlineRecall: number
  backgroundClDice: number
  weightedCenterlinePrecision: number
  weightedCenterlineRecall: number
  weightedClDice: number
  endpointPrecision: number
  endpointRecall: number
  endpointF1: number
  junctionPrecision: number
  junctionRecall: number
  junctionF1: number
  branchCountAgreement: number
  cycleCountAgreement: number
  componentCountAgreement: number
  endpointMatch: TopologyNodeMatch
  junctionMatch: TopologyNodeMatch
}

export interface TopologyAgreementInput {
  referenceMask: TopologyMask
  candidateMask: TopologyMask
  options?: TopologyAgreementOptions
}

export interface TopologyReferenceProjectionInput {
  model: SourceShapeModel
  crop: CropRect
  fit: CanvasFit
  width: number
  height: number
  areaMask: ArrayLike<number>
}

export interface TopologyHoleWitness {
  sourceCell: number
  sourcePoint: readonly [number, number]
  targetCells: readonly number[]
  preservedTargetCells: readonly number[]
  collapsed: boolean
}

export interface TopologyReferenceProjection {
  mask: Uint8Array
  addedCells: readonly number[]
  projectedSkeletonCells: number
  sourceHoleWitnesses: readonly TopologyHoleWitness[]
  collapsedHoleCount: number
  pathConflictCount: number
}

export const topologyAgreementSchema = Object.freeze({
  id: 'node-weighted-dual-cldice-v3',
  sources: Object.freeze([
    'jocpae/clDice@47d31a6cc4a8101b1ffe8052994821961e57af9f',
    'scikit-image/scikit-image@ee0a7a3ebd9ac8c2602f40e55bc015a3c8a81ae8',
    'jni/skan@94ec591f4a2763795b84141d6a85cb6fd0ab6b2a',
    'e-koch/FilFinder@bbb06edc167d177f61fccf600fb812fdf904ddb6',
  ]),
  licenses: Object.freeze(['MIT', 'BSD-3-Clause', 'BSD-3-Clause', 'MIT']),
})

const minimumThinBranchAspectRatio = 1.6
const maximumProjectedDiameterInCells = 1.25

interface PreparedTopology {
  binaryMask: Uint8Array
  graph: MedialGraph
  summary: TopologyShapeSummary
}

interface MatchCandidate {
  referenceIndex: number
  candidateIndex: number
  distance: number
}

function finite(value: number, label: string): number {
  if (Number.isFinite(value) === false) throw new TypeError(`${label} must be finite`)
  return value
}

function unit(value: number, label: string): number {
  const parsed = finite(value, label)
  if (parsed < 0 || parsed > 1) throw new RangeError(`${label} must stay within 0..1`)
  return parsed
}

function nonNegative(value: number, label: string): number {
  const parsed = finite(value, label)
  if (parsed < 0) throw new RangeError(`${label} must be non-negative`)
  return parsed
}

function positiveWeight(value: number, label: string): number {
  const parsed = finite(value, label)
  if (parsed < 1) throw new RangeError(`${label} must be at least 1`)
  return parsed
}

function validateMask(mask: TopologyMask, label: string): void {
  if (Number.isInteger(mask.width) === false || mask.width <= 0
    || Number.isInteger(mask.height) === false || mask.height <= 0) {
    throw new RangeError(`${label} dimensions must be positive integers`)
  }
  if (mask.values.length !== mask.width * mask.height) {
    throw new RangeError(`${label} values must match its dimensions`)
  }
  for (let index = 0; index < mask.values.length; index += 1) {
    finite(mask.values[index]!, `${label} value ${index}`)
  }
}

const fourNeighborOffsets = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
] as const

const eightNeighborOffsets = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
] as const

interface BackgroundHoleComponent {
  cells: readonly number[]
}

interface BackgroundHoleAnalysis {
  enclosedMask: Uint8Array
  holes: readonly BackgroundHoleComponent[]
}

type DdaRounding = 'lower-half' | 'upper-half'

interface TopologySafeLineResult {
  cells: readonly number[]
  reachedEnd: boolean
}

function labelConnectedComponents(
  values: Uint8Array,
  width: number,
  height: number,
  offsets: readonly (readonly [number, number])[],
): Int32Array {
  const labels = new Int32Array(values.length)
  labels.fill(-1)
  let componentId = 0
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === 0 || labels[index] !== -1) continue
    labels[index] = componentId
    const queue = [index]
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const cell = queue[cursor]!
      const x = cell % width
      const y = Math.floor(cell / width)
      for (const [offsetX, offsetY] of offsets) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
        const next = nextY * width + nextX
        if (values[next] === 0 || labels[next] !== -1) continue
        labels[next] = componentId
        queue.push(next)
      }
    }
    componentId += 1
  }
  return labels
}

function labelEightConnectedComponents(
  values: Uint8Array,
  width: number,
  height: number,
): Int32Array {
  return labelConnectedComponents(values, width, height, eightNeighborOffsets)
}

function componentCount(labels: Int32Array): number {
  let maximum = -1
  for (const label of labels) maximum = Math.max(maximum, label)
  return maximum + 1
}

function analyzeFourConnectedHoles(
  values: Uint8Array,
  width: number,
  height: number,
): BackgroundHoleAnalysis {
  const visited = new Uint8Array(values.length)
  const enclosedMask = new Uint8Array(values.length)
  const holes: BackgroundHoleComponent[] = []
  for (let start = 0; start < values.length; start += 1) {
    if (values[start] === 1 || visited[start] === 1) continue
    const cells: number[] = []
    const queue = [start]
    visited[start] = 1
    let touchesBorder = false
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]!
      cells.push(index)
      const x = index % width
      const y = Math.floor(index / width)
      touchesBorder ||= x === 0 || y === 0 || x === width - 1 || y === height - 1
      for (const [offsetX, offsetY] of fourNeighborOffsets) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
        const next = nextY * width + nextX
        if (values[next] === 1 || visited[next] === 1) continue
        visited[next] = 1
        queue.push(next)
      }
    }
    if (touchesBorder) continue
    for (const cell of cells) enclosedMask[cell] = 1
    holes.push({ cells })
  }
  return { enclosedMask, holes }
}

function safeRound(value: number, rounding: DdaRounding): number {
  return rounding === 'upper-half'
    ? Math.floor(value + 0.5)
    : Math.ceil(value - 0.5)
}

function topologySafeLine(
  start: number,
  end: number,
  width: number,
  reservedHoles: Uint8Array,
  rounding: DdaRounding,
): TopologySafeLineResult {
  const startX = start % width
  const startY = Math.floor(start / width)
  const endX = end % width
  const endY = Math.floor(end / width)
  const deltaX = endX - startX
  const deltaY = endY - startY
  const steps = Math.max(Math.abs(deltaX), Math.abs(deltaY))
  const cells: number[] = []
  for (let step = 0; step <= steps; step += 1) {
    const fraction = steps === 0 ? 0 : step / steps
    const x = safeRound(startX + deltaX * fraction, rounding)
    const y = safeRound(startY + deltaY * fraction, rounding)
    const cell = y * width + x
    if (reservedHoles[cell] === 1) return { cells, reachedEnd: false }
    if (cells.at(-1) !== cell) cells.push(cell)
  }
  return { cells, reachedEnd: cells.at(-1) === end }
}

function sourceMaskWithinCrop(model: SourceShapeModel, crop: CropRect): Uint8Array {
  return Uint8Array.from(model.binaryMask, (value, index) => {
    if (value === 0) return 0
    const centerX = index % model.width + 0.5
    const centerY = Math.floor(index / model.width) + 0.5
    return Number(centerX >= crop.x && centerY >= crop.y
      && centerX < crop.x + crop.width && centerY < crop.y + crop.height)
  })
}

function projectSourceCell(
  sourceIndex: number,
  model: SourceShapeModel,
  crop: CropRect,
  fit: CanvasFit,
  width: number,
  height: number,
): number | undefined {
  const centerX = sourceIndex % model.width + 0.5
  const centerY = Math.floor(sourceIndex / model.width) + 0.5
  if (centerX < crop.x || centerY < crop.y
    || centerX >= crop.x + crop.width || centerY >= crop.y + crop.height) return undefined
  const [targetX, targetY] = gridCellForSourcePoint(crop, fit, centerX, centerY)
  if (targetX < 0 || targetY < 0 || targetX >= width || targetY >= height) return undefined
  return targetY * width + targetX
}

function projectedBranchCells(
  branch: MedialGraphBranch,
  model: SourceShapeModel,
  crop: CropRect,
  fit: CanvasFit,
  width: number,
  height: number,
): number[] {
  const cells: number[] = []
  for (const sourceIndex of branch.pixelIndices) {
    const cell = projectSourceCell(sourceIndex, model, crop, fit, width, height)
    if (cell !== undefined && cells.at(-1) !== cell) cells.push(cell)
  }
  if (branch.fromNodeId === branch.toNodeId && cells.length > 1 && cells.at(-1) !== cells[0]) {
    cells.push(cells[0]!)
  }
  return cells
}

function hardAnchorSupportsBranch(
  branch: MedialGraphBranch,
  graph: MedialGraph,
  model: SourceShapeModel,
): boolean {
  const hardAnchors = model.anchors.filter((anchor) => anchor.hard && anchor.confidence >= 0.45)
  if (hardAnchors.length === 0) return false
  const endpoints = graph.nodes.filter((node) =>
    node.kind === 'endpoint'
    && (node.id === branch.fromNodeId || node.id === branch.toNodeId))
  return endpoints.some((node) => hardAnchors.some((anchor) =>
    Math.min(...node.pixelIndices.map((index) => Math.hypot(
      index % model.width + 0.5 - anchor.source[0],
      Math.floor(index / model.width) + 0.5 - anchor.source[1],
    ))) <= 1.5))
}

function transactionalBranchPath(
  controls: readonly number[],
  width: number,
  reservedHoles: Uint8Array,
  targetOwners: Int32Array,
  componentId: number,
): readonly number[] | undefined {
  for (const rounding of ['lower-half', 'upper-half'] as const) {
    const path: number[] = []
    let reachedEnd = true
    for (let index = 1; index < controls.length; index += 1) {
      const segment = topologySafeLine(
        controls[index - 1]!,
        controls[index]!,
        width,
        reservedHoles,
        rounding,
      )
      if (segment.reachedEnd === false) {
        reachedEnd = false
        break
      }
      for (let cellIndex = 0; cellIndex + 1 < segment.cells.length; cellIndex += 1) {
        const cell = segment.cells[cellIndex]!
        if (path.at(-1) !== cell) path.push(cell)
      }
    }
    const finalCell = controls.at(-1)
    if (finalCell !== undefined && reservedHoles[finalCell] === 0 && path.at(-1) !== finalCell) {
      path.push(finalCell)
    }
    if (reachedEnd === false || path.length === 0) continue
    const conflict = path.some((cell) => {
      const owner = targetOwners[cell] ?? -1
      return owner >= 0 && owner !== componentId
    })
    if (conflict === false) return path
  }
  return undefined
}

function seedTargetOwners(
  mask: Uint8Array,
  width: number,
  height: number,
  sourceLabels: Int32Array,
  sourceWidth: number,
  sourceHeight: number,
  crop: CropRect,
  fit: CanvasFit,
): Int32Array {
  const owners = new Int32Array(mask.length)
  owners.fill(-1)
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 0) continue
    const point = sourcePointForGridCell(crop, fit, index % width, Math.floor(index / width))
    if (point === undefined) continue
    const sourceX = Math.floor(point[0] + 0.5)
    const sourceY = Math.floor(point[1] + 0.5)
    if (sourceX < 0 || sourceY < 0 || sourceX >= sourceWidth || sourceY >= sourceHeight) continue
    owners[index] = sourceLabels[sourceY * sourceWidth + sourceX] ?? -1
  }
  return owners
}

function sourceHoleWitnesses(
  sourceMask: Uint8Array,
  model: SourceShapeModel,
  crop: CropRect,
  fit: CanvasFit,
  width: number,
  height: number,
  targetMask: Uint8Array,
): readonly TopologyHoleWitness[] {
  const sourceHoles = analyzeFourConnectedHoles(sourceMask, model.width, model.height).holes
  const targetEnclosed = analyzeFourConnectedHoles(targetMask, width, height).enclosedMask
  return sourceHoles.map((hole) => {
    const centerX = hole.cells.reduce((sum, cell) => sum + cell % model.width + 0.5, 0)
      / hole.cells.length
    const centerY = hole.cells.reduce((sum, cell) => sum + Math.floor(cell / model.width) + 0.5, 0)
      / hole.cells.length
    const sourceCell = [...hole.cells].sort((first, second) => {
      const firstDistance = Math.hypot(
        first % model.width + 0.5 - centerX,
        Math.floor(first / model.width) + 0.5 - centerY,
      )
      const secondDistance = Math.hypot(
        second % model.width + 0.5 - centerX,
        Math.floor(second / model.width) + 0.5 - centerY,
      )
      return firstDistance - secondDistance || first - second
    })[0]!
    const targetCells = [...new Set(hole.cells.map((cell) =>
      projectSourceCell(cell, model, crop, fit, width, height))
      .filter((cell): cell is number => cell !== undefined))]
      .sort((first, second) => first - second)
    const preservedTargetCells = targetCells.filter((cell) => targetEnclosed[cell] === 1)
    return {
      sourceCell,
      sourcePoint: [sourceCell % model.width + 0.5, Math.floor(sourceCell / model.width) + 0.5],
      targetCells,
      preservedTargetCells,
      collapsed: preservedTargetCells.length === 0,
    }
  })
}

/**
 * Projects source centerlines independently from area sampling. The area result
 * retains broad mass while medial paths restore branches that vanish on their
 * first target cell. Existing enclosed background cells remain reserved so a
 * diagonal centerline cannot fill a deliberate hole.
 */
export function projectTopologyReference(
  input: TopologyReferenceProjectionInput,
): TopologyReferenceProjection {
  const { model, crop, fit, width, height, areaMask } = input
  validateMask({ width, height, values: areaMask }, 'Topology area mask')
  if (model.width <= 0 || model.height <= 0
    || model.binaryMask.length !== model.width * model.height) {
    throw new RangeError('Topology source model dimensions must align')
  }
  // A very large source projected onto a small bead grid has no resolvable
  // centerline detail. The area mask already carries the observable shape;
  // retaining that projection avoids materializing million-cell medial graphs
  // while keeping topology analysis active for normal and high-resolution grids.
  if (model.width * model.height > 512 * 512 && width * height <= 64 * 64) {
    return {
      mask: Uint8Array.from(areaMask, (value) => Number(value >= 0.5)),
      addedCells: [],
      projectedSkeletonCells: 0,
      sourceHoleWitnesses: [],
      collapsedHoleCount: 0,
      pathConflictCount: 0,
    }
  }
  const mask = Uint8Array.from(areaMask, (value) => Number(value >= 0.5))
  const reservedHoles = analyzeFourConnectedHoles(mask, width, height).enclosedMask
  const graph = buildMedialGraph(model, {
    crop,
    minimumSpurGeodesicLength: 0,
  })
  const sourcePixelsPerCell = Math.max(crop.width / fit.width, crop.height / fit.height)
  const croppedSourceMask = sourceMaskWithinCrop(model, crop)
  const sourceLabels = labelEightConnectedComponents(croppedSourceMask, model.width, model.height)
  const targetOwners = seedTargetOwners(
    mask,
    width,
    height,
    sourceLabels,
    model.width,
    model.height,
    crop,
    fit,
  )
  const projectedSkeleton = new Set<number>()
  const addedCells = new Set<number>()
  let pathConflictCount = 0
  const branches = graph.branches.map((branch) => {
    const aspectRatio = branch.geodesicLength / Math.max(1, branch.robustMinimumDiameter)
    const targetDiameter = branch.robustMinimumDiameter / Math.max(Number.EPSILON, sourcePixelsPerCell)
    const closed = branch.fromNodeId === branch.toNodeId
      || branch.fromNodeKind === 'cycle'
      || branch.toNodeKind === 'cycle'
    const hardEndpoint = branch.endpointRoleHits.some((hit) => hit.hard)
      || hardAnchorSupportsBranch(branch, graph, model)
    return {
      branch,
      aspectRatio,
      targetDiameter,
      closed,
      hardEndpoint,
      controls: projectedBranchCells(branch, model, crop, fit, width, height),
    }
  }).filter((entry) => entry.controls.length > 0
    && entry.targetDiameter <= maximumProjectedDiameterInCells
    && (entry.aspectRatio >= minimumThinBranchAspectRatio || entry.hardEndpoint || entry.closed))
    .sort((first, second) => Number(second.closed) - Number(first.closed)
      || Number(second.hardEndpoint) - Number(first.hardEndpoint)
      || second.controls.length - first.controls.length
      || first.branch.id.localeCompare(second.branch.id))

  for (const entry of branches) {
    const sourceIndex = entry.branch.pixelIndices.find((index) => (sourceLabels[index] ?? -1) >= 0)
    if (sourceIndex === undefined) continue
    const componentId = sourceLabels[sourceIndex]!
    const path = transactionalBranchPath(
      entry.controls,
      width,
      reservedHoles,
      targetOwners,
      componentId,
    )
    if (path === undefined) {
      pathConflictCount += 1
      continue
    }
    for (const cell of path) {
      targetOwners[cell] = componentId
      projectedSkeleton.add(cell)
      if (mask[cell] === 0) {
        mask[cell] = 1
        addedCells.add(cell)
      }
    }
  }

  const holeWitnesses = sourceHoleWitnesses(
    croppedSourceMask,
    model,
    crop,
    fit,
    width,
    height,
    mask,
  )
  return {
    mask,
    addedCells: [...addedCells].sort((first, second) => first - second),
    projectedSkeletonCells: projectedSkeleton.size,
    sourceHoleWitnesses: holeWitnesses,
    collapsedHoleCount: holeWitnesses.filter((witness) => witness.collapsed).length,
    pathConflictCount,
  }
}

function foregroundCount(values: Uint8Array): number {
  let count = 0
  for (const value of values) count += value
  return count
}

function summary(
  binaryMask: Uint8Array,
  graph: MedialGraph,
  componentCount: number,
  closedHoleCount: number,
): TopologyShapeSummary {
  return {
    foregroundCells: foregroundCount(binaryMask),
    skeletonCells: foregroundCount(graph.skeletonMask),
    components: componentCount,
    endpoints: graph.nodes.filter((node) => node.kind === 'endpoint').length,
    junctions: graph.nodes.filter((node) => node.kind === 'junction').length,
    cycles: closedHoleCount,
    branches: graph.branches.length,
  }
}

function prepare(mask: TopologyMask, threshold: number): PreparedTopology {
  const binaryMask = Uint8Array.from(
    { length: mask.values.length },
    (_, index) => Number(mask.values[index]! >= threshold),
  )
  const model = buildSourceShapeModel({
    width: mask.width,
    height: mask.height,
    values: Float32Array.from(binaryMask),
  }, 1)
  const graph = buildMedialGraph(model, {
    minimumSpurGeodesicLength: 0,
  })
  const foregroundComponents = componentCount(
    labelEightConnectedComponents(binaryMask, mask.width, mask.height),
  )
  const backgroundHoles = analyzeFourConnectedHoles(binaryMask, mask.width, mask.height).holes.length
  return {
    binaryMask,
    graph,
    summary: summary(binaryMask, graph, foregroundComponents, backgroundHoles),
  }
}

function harmonicMean(first: number, second: number): number {
  const denominator = first + second
  return denominator <= 0 ? 0 : 2 * first * second / denominator
}

function countAgreement(reference: number, candidate: number): number {
  const maximum = Math.max(reference, candidate)
  return maximum === 0 ? 1 : Math.min(reference, candidate) / maximum
}

export function scoreTopologyAgreement(
  diagnostics: Pick<
    TopologyAgreementDiagnostics,
    | 'weightedClDice'
    | 'backgroundClDice'
    | 'endpointF1'
    | 'junctionF1'
    | 'branchCountAgreement'
    | 'cycleCountAgreement'
    | 'componentCountAgreement'
  >,
): number {
  const weightedClDice = unit(diagnostics.weightedClDice, 'Topology weighted clDice')
  const backgroundClDice = unit(diagnostics.backgroundClDice, 'Topology background clDice')
  const endpointF1 = unit(diagnostics.endpointF1, 'Topology endpoint F1')
  const junctionF1 = unit(diagnostics.junctionF1, 'Topology junction F1')
  const branchCountAgreement = unit(diagnostics.branchCountAgreement, 'Topology branch-count agreement')
  const cycleCountAgreement = unit(diagnostics.cycleCountAgreement, 'Topology cycle-count agreement')
  const componentCountAgreement = unit(
    diagnostics.componentCountAgreement,
    'Topology component-count agreement',
  )
  return weightedClDice * 0.45
    + backgroundClDice * 0.1
    + endpointF1 * 0.15
    + junctionF1 * 0.1
    + branchCountAgreement * 0.1
    + cycleCountAgreement * 0.05
    + componentCountAgreement * 0.05
}

function covered(
  volume: Uint8Array,
  width: number,
  height: number,
  index: number,
  radius: number,
): boolean {
  if (radius === 0) return volume[index] === 1
  const centerX = index % width
  const centerY = Math.floor(index / width)
  const limit = Math.ceil(radius)
  const radiusSquared = radius * radius
  for (let offsetY = -limit; offsetY <= limit; offsetY += 1) {
    for (let offsetX = -limit; offsetX <= limit; offsetX += 1) {
      if (offsetX * offsetX + offsetY * offsetY > radiusSquared) continue
      const x = centerX + offsetX
      const y = centerY + offsetY
      if (x < 0 || y < 0 || x >= width || y >= height) continue
      if (volume[y * width + x] === 1) return true
    }
  }
  return false
}

function centerlineCoverage(
  skeleton: Uint8Array,
  volume: Uint8Array,
  width: number,
  height: number,
  radius: number,
  weights?: Float64Array,
): number {
  let total = 0
  let overlap = 0
  for (let index = 0; index < skeleton.length; index += 1) {
    if (skeleton[index] !== 1) continue
    const weight = weights?.[index] ?? 1
    total += weight
    if (covered(volume, width, height, index, radius)) overlap += weight
  }
  return total === 0 ? 1 : overlap / total
}

function complement(mask: PreparedTopology, width: number, height: number): TopologyMask {
  return {
    width,
    height,
    values: Float32Array.from(mask.binaryMask, (value) => 1 - value),
  }
}

function skeletonWeights(
  graph: MedialGraph,
  endpointWeight: number,
  junctionWeight: number,
): Float64Array {
  const weights = Float64Array.from(graph.skeletonMask, (value) => value === 1 ? 1 : 0)
  for (const node of graph.nodes) {
    const weight = node.kind === 'endpoint'
      ? endpointWeight
      : node.kind === 'junction'
        ? junctionWeight
        : 1
    for (const index of node.pixelIndices) weights[index] = Math.max(weights[index] ?? 0, weight)
  }
  return weights
}

function nodesOfKind(graph: MedialGraph, kind: MedialGraphNodeKind): readonly MedialGraphNode[] {
  return graph.nodes.filter((node) => node.kind === kind)
}

function nodeMatch(
  referenceNodes: readonly MedialGraphNode[],
  candidateNodes: readonly MedialGraphNode[],
  radius: number,
): TopologyNodeMatch {
  const possible: MatchCandidate[] = []
  for (let referenceIndex = 0; referenceIndex < referenceNodes.length; referenceIndex += 1) {
    const reference = referenceNodes[referenceIndex]!
    for (let candidateIndex = 0; candidateIndex < candidateNodes.length; candidateIndex += 1) {
      const candidate = candidateNodes[candidateIndex]!
      const distance = Math.hypot(reference.x - candidate.x, reference.y - candidate.y)
      if (distance <= radius) possible.push({ referenceIndex, candidateIndex, distance })
    }
  }
  possible.sort((first, second) => first.distance - second.distance
    || first.referenceIndex - second.referenceIndex
    || first.candidateIndex - second.candidateIndex)
  const matchedReference = new Set<number>()
  const matchedCandidate = new Set<number>()
  for (const match of possible) {
    if (matchedReference.has(match.referenceIndex) || matchedCandidate.has(match.candidateIndex)) continue
    matchedReference.add(match.referenceIndex)
    matchedCandidate.add(match.candidateIndex)
  }
  const matchedCount = matchedReference.size
  const precision = candidateNodes.length === 0 ? Number(referenceNodes.length === 0) : matchedCount / candidateNodes.length
  const recall = referenceNodes.length === 0 ? 1 : matchedCount / referenceNodes.length
  return {
    referenceCount: referenceNodes.length,
    candidateCount: candidateNodes.length,
    matchedCount,
    precision,
    recall,
    f1: harmonicMean(precision, recall),
  }
}

/**
 * Measures foreground and background topology with the two directional
 * centerline-volume overlaps from clDice. Endpoint and junction skeleton pixels
 * carry extra weight, while explicit node matching exposes branch truncation,
 * invented junctions, holes, and damaged negative space.
 */
export function evaluateTopologyAgreement(
  input: TopologyAgreementInput,
): TopologyAgreementDiagnostics {
  validateMask(input.referenceMask, 'Topology reference mask')
  validateMask(input.candidateMask, 'Topology candidate mask')
  if (input.referenceMask.width !== input.candidateMask.width
    || input.referenceMask.height !== input.candidateMask.height) {
    throw new RangeError('Topology masks must share dimensions')
  }
  const threshold = unit(input.options?.threshold ?? 0.5, 'Topology threshold')
  const endpointWeight = positiveWeight(input.options?.endpointWeight ?? 3, 'Topology endpoint weight')
  const junctionWeight = positiveWeight(input.options?.junctionWeight ?? 2, 'Topology junction weight')
  const nodeMatchRadius = nonNegative(
    input.options?.nodeMatchRadiusCells ?? 1.5,
    'Topology node match radius',
  )
  const coverageRadius = nonNegative(
    input.options?.coverageRadiusCells ?? 0,
    'Topology coverage radius',
  )
  const reference = prepare(input.referenceMask, threshold)
  const candidate = prepare(input.candidateMask, threshold)
  const width = input.referenceMask.width
  const height = input.referenceMask.height
  const referenceBackground = prepare(complement(reference, width, height), 0.5)
  const candidateBackground = prepare(complement(candidate, width, height), 0.5)
  const centerlineRecall = centerlineCoverage(
    reference.graph.skeletonMask,
    candidate.binaryMask,
    width,
    height,
    coverageRadius,
  )
  const centerlinePrecision = centerlineCoverage(
    candidate.graph.skeletonMask,
    reference.binaryMask,
    width,
    height,
    coverageRadius,
  )
  const weightedCenterlineRecall = centerlineCoverage(
    reference.graph.skeletonMask,
    candidate.binaryMask,
    width,
    height,
    coverageRadius,
    skeletonWeights(reference.graph, endpointWeight, junctionWeight),
  )
  const weightedCenterlinePrecision = centerlineCoverage(
    candidate.graph.skeletonMask,
    reference.binaryMask,
    width,
    height,
    coverageRadius,
    skeletonWeights(candidate.graph, endpointWeight, junctionWeight),
  )
  const backgroundCenterlineRecall = centerlineCoverage(
    referenceBackground.graph.skeletonMask,
    candidateBackground.binaryMask,
    width,
    height,
    coverageRadius,
  )
  const backgroundCenterlinePrecision = centerlineCoverage(
    candidateBackground.graph.skeletonMask,
    referenceBackground.binaryMask,
    width,
    height,
    coverageRadius,
  )
  const endpointMatch = nodeMatch(
    nodesOfKind(reference.graph, 'endpoint'),
    nodesOfKind(candidate.graph, 'endpoint'),
    nodeMatchRadius,
  )
  const junctionMatch = nodeMatch(
    nodesOfKind(reference.graph, 'junction'),
    nodesOfKind(candidate.graph, 'junction'),
    nodeMatchRadius,
  )
  return {
    reference: reference.summary,
    candidate: candidate.summary,
    centerlinePrecision,
    centerlineRecall,
    clDice: harmonicMean(centerlinePrecision, centerlineRecall),
    backgroundCenterlinePrecision,
    backgroundCenterlineRecall,
    backgroundClDice: harmonicMean(backgroundCenterlinePrecision, backgroundCenterlineRecall),
    weightedCenterlinePrecision,
    weightedCenterlineRecall,
    weightedClDice: harmonicMean(weightedCenterlinePrecision, weightedCenterlineRecall),
    endpointPrecision: endpointMatch.precision,
    endpointRecall: endpointMatch.recall,
    endpointF1: endpointMatch.f1,
    junctionPrecision: junctionMatch.precision,
    junctionRecall: junctionMatch.recall,
    junctionF1: junctionMatch.f1,
    branchCountAgreement: countAgreement(reference.summary.branches, candidate.summary.branches),
    cycleCountAgreement: countAgreement(reference.summary.cycles, candidate.summary.cycles),
    componentCountAgreement: countAgreement(reference.summary.components, candidate.summary.components),
    endpointMatch,
    junctionMatch,
  }
}
