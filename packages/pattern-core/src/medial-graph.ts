import { signedDistanceField, type SourceShapeModel } from './shape.js'
import { landmarkObservationState } from './landmarks.js'
import type { CropRect, ImageLandmark, StructuralRole } from './types.js'

export type MedialGraphNodeKind = 'endpoint' | 'junction' | 'cycle'

export interface MedialEndpointRoleHit {
  landmarkId: string
  role: StructuralRole
  nodeId: string
  nodeKind: MedialGraphNodeKind
  distance: number
  confidence: number
  hard: boolean
}

export interface MedialGraphNode {
  id: string
  kind: MedialGraphNodeKind
  pixelIndex: number
  pixelIndices: readonly number[]
  x: number
  y: number
  degree: number
  localRadius: number
}

export interface MedialGraphBranch {
  id: string
  fromNodeId: string
  toNodeId: string
  fromNodeKind: MedialGraphNodeKind
  toNodeKind: MedialGraphNodeKind
  pixelIndices: readonly number[]
  geodesicLength: number
  straightLength: number
  minimumLocalRadius: number
  medianLocalRadius: number
  robustMinimumDiameter: number
  endpointRoleHits: readonly MedialEndpointRoleHit[]
}

export interface MedialGraph {
  width: number
  height: number
  candidateMask: Uint8Array
  skeletonMask: Uint8Array
  nodes: readonly MedialGraphNode[]
  branches: readonly MedialGraphBranch[]
  endpointRoleHits: readonly MedialEndpointRoleHit[]
  prunedSpurCount: number
}

export interface MedialGraphOptions {
  crop?: CropRect
  landmarks?: readonly ImageLandmark[]
  minimumSpurGeodesicLength?: number
  endpointSnapDistancePixels?: number
}

export const medialGraphSchema = Object.freeze({
  id: 'sdf-medial-branch-v3-robust-diameter',
  sources: Object.freeze([
    'scikit-image/medial_axis@v0.26.0',
    'jni/skan@v0.13.1',
  ]),
})

interface MutableNode {
  id: string
  kind: MedialGraphNodeKind
  pixelIndex: number
  pixelIndices: number[]
  x: number
  y: number
  degree: number
  localRadius: number
}

interface RawBranch {
  fromNode: number
  toNode: number
  pixelIndices: number[]
  geodesicLength: number
  straightLength: number
  minimumLocalRadius: number
  medianLocalRadius: number
}

const eightNeighborOffsets = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
] as const

const opposingDirections = [
  [[-1, 0], [1, 0]],
  [[0, -1], [0, 1]],
  [[-1, -1], [1, 1]],
  [[1, -1], [-1, 1]],
] as const

function finiteNonNegative(value: number, label: string): number {
  if (Number.isFinite(value) === false || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative`)
  }
  return value
}

function activeCrop(model: SourceShapeModel, crop: CropRect | undefined): Uint8Array {
  if (crop === undefined) return model.binaryMask.slice()
  if ([crop.x, crop.y, crop.width, crop.height].some((value) => Number.isFinite(value) === false)
    || crop.width <= 0 || crop.height <= 0) {
    throw new RangeError('Medial graph crop must contain finite positive dimensions')
  }
  const left = Math.max(0, Math.floor(crop.x))
  const top = Math.max(0, Math.floor(crop.y))
  const right = Math.min(model.width, Math.ceil(crop.x + crop.width))
  const bottom = Math.min(model.height, Math.ceil(crop.y + crop.height))
  const active = new Uint8Array(model.binaryMask.length)
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = y * model.width + x
      active[index] = model.binaryMask[index] ?? 0
    }
  }
  return active
}

function sample(
  values: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
  outside: number,
): number {
  if (x < 0 || y < 0 || x >= width || y >= height) return outside
  return values[y * width + x] ?? outside
}

function ridgeCandidates(
  active: Uint8Array,
  signedDistance: Float32Array,
  width: number,
  height: number,
): Uint8Array {
  const candidates = new Uint8Array(active.length)
  const epsilon = 1e-6
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      if (active[index] === 0) continue
      const radius = signedDistance[index] ?? 0
      for (const [first, second] of opposingDirections) {
        const firstRadius = sample(signedDistance, width, height, x + first[0], y + first[1], -Infinity)
        const secondRadius = sample(signedDistance, width, height, x + second[0], y + second[1], -Infinity)
        if (radius + epsilon >= firstRadius && radius + epsilon >= secondRadius
          && (radius > firstRadius + epsilon || radius > secondRadius + epsilon)) {
          candidates[index] = 1
          break
        }
      }
    }
  }
  return candidates
}

function activeNeighbors(
  values: Uint8Array,
  width: number,
  height: number,
  index: number,
): number[] {
  const x = index % width
  const y = Math.floor(index / width)
  const neighbors: number[] = []
  for (const [offsetX, offsetY] of eightNeighborOffsets) {
    const nextX = x + offsetX
    const nextY = y + offsetY
    if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
    const next = nextY * width + nextX
    if (values[next] === 1) neighbors.push(next)
  }
  return neighbors
}

function neighborPattern(
  values: Uint8Array,
  width: number,
  height: number,
  center: number,
): number {
  const centerX = center % width
  const centerY = Math.floor(center / width)
  let pattern = 0
  for (let offsetIndex = 0; offsetIndex < eightNeighborOffsets.length; offsetIndex += 1) {
    const [offsetX, offsetY] = eightNeighborOffsets[offsetIndex]!
    const x = centerX + offsetX
    const y = centerY + offsetY
    if (x >= 0 && y >= 0 && x < width && y < height && values[y * width + x] === 1) {
      pattern |= 1 << offsetIndex
    }
  }
  return pattern
}

function localComponentCount(pattern: number, foreground: boolean): number {
  const available = new Set<number>()
  for (let index = 0; index < eightNeighborOffsets.length; index += 1) {
    if (Boolean(pattern & (1 << index)) === foreground) available.add(index)
  }
  let components = 0
  while (available.size > 0) {
    components += 1
    const seed = available.values().next().value as number
    available.delete(seed)
    const queue = [seed]
    while (queue.length > 0) {
      const current = queue.pop()!
      const [currentX, currentY] = eightNeighborOffsets[current]!
      for (const next of [...available]) {
        const [nextX, nextY] = eightNeighborOffsets[next]!
        if (Math.max(Math.abs(currentX - nextX), Math.abs(currentY - nextY)) > 1) continue
        available.delete(next)
        queue.push(next)
      }
    }
  }
  return components
}

function bitCount(value: number): number {
  let remaining = value
  let count = 0
  while (remaining > 0) {
    count += remaining & 1
    remaining >>>= 1
  }
  return count
}

const foregroundPreservingDeletionLut = Uint8Array.from({ length: 256 }, (_, pattern) => {
  const foregroundCount = bitCount(pattern)
  if (foregroundCount <= 1) return 0
  return Number(localComponentCount(pattern, true) === 1)
})

// Follow lookup-table thinning: classify every 3x3 neighborhood before the ordered pass.
const closedHolePreservingDeletionLut = Uint8Array.from(
  foregroundPreservingDeletionLut,
  (deletable, pattern) => Number(deletable === 1 && localComponentCount(pattern, false) === 1),
)

function closedHoleCount(values: Uint8Array, width: number, height: number): number {
  const exterior = new Uint8Array(values.length)
  const queue: number[] = []
  const addExterior = (index: number): void => {
    if (values[index] === 1 || exterior[index] === 1) return
    exterior[index] = 1
    queue.push(index)
  }
  for (let x = 0; x < width; x += 1) {
    addExterior(x)
    addExterior((height - 1) * width + x)
  }
  for (let y = 1; y < height - 1; y += 1) {
    addExterior(y * width)
    addExterior(y * width + width - 1)
  }
  while (queue.length > 0) {
    const index = queue.pop()!
    const x = index % width
    const y = Math.floor(index / width)
    for (const [offsetX, offsetY] of eightNeighborOffsets) {
      const nextX = x + offsetX
      const nextY = y + offsetY
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
      addExterior(nextY * width + nextX)
    }
  }
  const enclosed = new Uint8Array(values.length)
  let holes = 0
  for (let start = 0; start < values.length; start += 1) {
    if (values[start] === 1 || exterior[start] === 1 || enclosed[start] === 1) continue
    holes += 1
    enclosed[start] = 1
    const enclosedQueue = [start]
    while (enclosedQueue.length > 0) {
      const index = enclosedQueue.pop()!
      const x = index % width
      const y = Math.floor(index / width)
      for (const [offsetX, offsetY] of eightNeighborOffsets) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
        const next = nextY * width + nextX
        if (values[next] === 1 || exterior[next] === 1 || enclosed[next] === 1) continue
        enclosed[next] = 1
        enclosedQueue.push(next)
      }
    }
  }
  return holes
}

function nearestForegroundIndex(
  active: Uint8Array,
  width: number,
  landmark: ImageLandmark,
): number | undefined {
  const anchorX = Math.floor(landmark.x + 1e-6)
  const anchorY = Math.floor(landmark.y + 1e-6)
  let bestIndex: number | undefined
  let bestDistance = Infinity
  for (let index = 0; index < active.length; index += 1) {
    if (active[index] === 0) continue
    const distance = Math.hypot(index % width - anchorX, Math.floor(index / width) - anchorY)
    if (distance < bestDistance - 1e-9
      || (Math.abs(distance - bestDistance) <= 1e-9 && index < (bestIndex ?? Infinity))) {
      bestIndex = index
      bestDistance = distance
    }
  }
  return bestIndex
}

function protectedEndpointPixels(
  active: Uint8Array,
  width: number,
  landmarks: readonly ImageLandmark[],
): ReadonlySet<number> {
  const protectedPixels = new Set<number>()
  for (const landmark of landmarks) {
    if (landmark.structuralRole === undefined
      || landmarkObservationState(landmark) !== 'observed'
      || landmark.priority !== 'hard'
      || landmark.confidence < 0.45) continue
    const index = nearestForegroundIndex(active, width, landmark)
    if (index !== undefined) protectedPixels.add(index)
  }
  return protectedPixels
}

function backgroundNeighborCount(
  values: Uint8Array,
  width: number,
  height: number,
  index: number,
): number {
  return 8 - activeNeighbors(values, width, height, index).length
}

function thinByDistanceOrder(
  source: Uint8Array,
  candidates: Uint8Array,
  signedDistance: Float32Array,
  width: number,
  height: number,
  protectedPixels: ReadonlySet<number>,
): Uint8Array {
  const skeleton = source.slice()
  const deletionLut = closedHoleCount(source, width, height) > 0
    ? closedHolePreservingDeletionLut
    : foregroundPreservingDeletionLut
  const order = Array.from(source, (value, index) => value === 1 ? index : -1)
    .filter((index) => index >= 0)
    .sort((first, second) =>
      (signedDistance[first] ?? 0) - (signedDistance[second] ?? 0)
      || candidates[first]! - candidates[second]!
      || backgroundNeighborCount(source, width, height, first)
        - backgroundNeighborCount(source, width, height, second)
      || first - second)
  let changed = true
  while (changed) {
    changed = false
    for (const index of order) {
      if (skeleton[index] === 0 || protectedPixels.has(index)) continue
      const pattern = neighborPattern(skeleton, width, height, index)
      if (deletionLut[pattern] !== 1) continue
      skeleton[index] = 0
      changed = true
    }
  }
  return skeleton
}

function adjacencyFor(skeleton: Uint8Array, width: number, height: number): readonly number[][] {
  return Array.from({ length: skeleton.length }, (_, index) =>
    skeleton[index] === 1 ? activeNeighbors(skeleton, width, height, index) : [])
}

function connectedGroups(indices: readonly number[], adjacency: readonly number[][]): number[][] {
  const remaining = new Set(indices)
  const groups: number[][] = []
  while (remaining.size > 0) {
    const seed = remaining.values().next().value as number
    remaining.delete(seed)
    const group = [seed]
    const queue = [seed]
    while (queue.length > 0) {
      const current = queue.pop()!
      for (const next of adjacency[current] ?? []) {
        if (remaining.has(next) === false) continue
        remaining.delete(next)
        group.push(next)
        queue.push(next)
      }
    }
    groups.push(group.sort((first, second) => first - second))
  }
  return groups
}

function representativePixel(pixels: readonly number[], signedDistance: Float32Array): number {
  return [...pixels].sort((first, second) =>
    (signedDistance[second] ?? 0) - (signedDistance[first] ?? 0) || first - second)[0]!
}

function edgeKey(first: number, second: number): string {
  return first < second ? `${first}:${second}` : `${second}:${first}`
}

function stepDistance(first: number, second: number, width: number): number {
  const deltaX = first % width - second % width
  const deltaY = Math.floor(first / width) - Math.floor(second / width)
  return Math.hypot(deltaX, deltaY)
}

function branchRadii(path: readonly number[], signedDistance: Float32Array): {
  minimum: number
  median: number
} {
  const radii = path.map((index) => Math.max(0, signedDistance[index] ?? 0))
    .sort((first, second) => first - second)
  if (radii.length === 0) return { minimum: 0, median: 0 }
  const middle = Math.floor(radii.length / 2)
  const median = radii.length % 2 === 1
    ? radii[middle]!
    : (radii[middle - 1]! + radii[middle]!) / 2
  return { minimum: radii[0]!, median }
}

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, fraction))
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]!
  const weight = position - lower
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight
}

function robustMinimumDiameter(
  branch: RawBranch,
  from: MutableNode,
  to: MutableNode,
  endpointRoleHits: readonly MedialEndpointRoleHit[],
  signedDistance: Float32Array,
): number {
  const hardEndpointNodeIds = new Set(endpointRoleHits
    .filter((hit) => hit.hard && hit.nodeKind === 'endpoint')
    .map((hit) => hit.nodeId))
  const preservesEndpointSamples = hardEndpointNodeIds.size > 0
  const maximumCapSamples = Math.max(0, Math.floor((branch.pixelIndices.length - 3) / 2))
  const capSamples = preservesEndpointSamples
    ? 0
    : Math.min(Math.ceil(branch.medianLocalRadius), maximumCapSamples)
  const sampledPath = branch.pixelIndices.slice(
    capSamples,
    branch.pixelIndices.length - capSamples,
  )
  const radii = sampledPath.map((index) => Math.max(0, signedDistance[index] ?? 0))
    .sort((first, second) => first - second)
  let robustRadius = quantile(radii, 0.2)
  if (hardEndpointNodeIds.has(from.id)) {
    robustRadius = Math.min(
      robustRadius,
      Math.max(0, signedDistance[branch.pixelIndices[0]!] ?? 0),
    )
  }
  if (hardEndpointNodeIds.has(to.id)) {
    robustRadius = Math.min(
      robustRadius,
      Math.max(0, signedDistance[branch.pixelIndices.at(-1)!] ?? 0),
    )
  }
  return robustRadius * 2
}

function compressSkeleton(
  skeleton: Uint8Array,
  signedDistance: Float32Array,
  width: number,
  height: number,
): { nodes: MutableNode[]; branches: RawBranch[] } {
  const adjacency = adjacencyFor(skeleton, width, height)
  const active = Array.from(skeleton, (value, index) => value === 1 ? index : -1)
    .filter((index) => index >= 0)
  const junctionPixels = active.filter((index) => (adjacency[index]?.length ?? 0) >= 3)
  const nodes: MutableNode[] = []
  const pixelToNode = new Int32Array(skeleton.length)
  pixelToNode.fill(-1)

  const addNode = (kind: MedialGraphNodeKind, pixels: number[]): void => {
    const pixelIndex = representativePixel(pixels, signedDistance)
    const nodeIndex = nodes.length
    const node: MutableNode = {
      id: `medial-node-${nodeIndex}`,
      kind,
      pixelIndex,
      pixelIndices: pixels,
      x: pixelIndex % width,
      y: Math.floor(pixelIndex / width),
      degree: 0,
      localRadius: Math.max(0, signedDistance[pixelIndex] ?? 0),
    }
    nodes.push(node)
    for (const pixel of pixels) pixelToNode[pixel] = nodeIndex
  }

  for (const group of connectedGroups(junctionPixels, adjacency)) addNode('junction', group)
  for (const index of active) {
    if ((adjacency[index]?.length ?? 0) <= 1 && (pixelToNode[index] ?? -1) < 0) addNode('endpoint', [index])
  }
  for (const group of connectedGroups(active, adjacency)) {
    if (group.every((index) => (pixelToNode[index] ?? -1) < 0)) addNode('cycle', [group[0]!])
  }

  const visited = new Set<string>()
  const branches: RawBranch[] = []
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const node = nodes[nodeIndex]!
    for (const sourcePixel of node.pixelIndices) {
      for (const neighbor of adjacency[sourcePixel] ?? []) {
        if (pixelToNode[neighbor] === nodeIndex) continue
        const firstEdge = edgeKey(sourcePixel, neighbor)
        if (visited.has(firstEdge)) continue
        visited.add(firstEdge)
        const path = [sourcePixel, neighbor]
        let previous = sourcePixel
        let current = neighbor
        let destination = pixelToNode[current] ?? -1
        while (destination < 0) {
          const next = (adjacency[current] ?? [])
            .filter((candidate) => candidate !== previous)
            .sort((first, second) => first - second)[0]
          if (next === undefined) break
          const key = edgeKey(current, next)
          if (visited.has(key)) {
            destination = pixelToNode[next] ?? -1
            if (destination >= 0 && path[path.length - 1] !== next) path.push(next)
            break
          }
          visited.add(key)
          previous = current
          current = next
          path.push(current)
          destination = pixelToNode[current] ?? -1
        }
        if (destination < 0) continue
        let geodesicLength = 0
        for (let pathIndex = 1; pathIndex < path.length; pathIndex += 1) {
          geodesicLength += stepDistance(path[pathIndex - 1]!, path[pathIndex]!, width)
        }
        const start = path[0]!
        const end = path[path.length - 1]!
        const radii = branchRadii(path, signedDistance)
        branches.push({
          fromNode: nodeIndex,
          toNode: destination,
          pixelIndices: path,
          geodesicLength,
          straightLength: stepDistance(start, end, width),
          minimumLocalRadius: radii.minimum,
          medianLocalRadius: radii.median,
        })
      }
    }
  }
  for (let index = 0; index < nodes.length; index += 1) {
    nodes[index]!.degree = branches.reduce((degree, branch) => degree
      + Number(branch.fromNode === index)
      + Number(branch.toNode === index), 0)
  }
  return { nodes, branches }
}

function nodeDistance(
  node: MutableNode,
  landmark: ImageLandmark,
  width: number,
  quantized: boolean,
): number {
  const landmarkX = quantized ? Math.floor(landmark.x + 1e-6) : landmark.x
  const landmarkY = quantized ? Math.floor(landmark.y + 1e-6) : landmark.y
  return Math.min(...node.pixelIndices.map((index) =>
    Math.hypot(index % width - landmarkX, Math.floor(index / width) - landmarkY)))
}

function matchEndpointRoles(
  nodes: readonly MutableNode[],
  landmarks: readonly ImageLandmark[],
  width: number,
  maximumDistance: number,
): MedialEndpointRoleHit[] {
  const hits: MedialEndpointRoleHit[] = []
  for (const landmark of landmarks) {
    if (landmark.structuralRole === undefined
      || landmarkObservationState(landmark) === 'missing'
      || landmark.confidence < 0.2
      || nodes.length === 0) continue
    const ranked = nodes.map((node, nodeIndex) => ({
      node,
      nodeIndex,
      selectionDistance: nodeDistance(node, landmark, width, true),
      distance: nodeDistance(node, landmark, width, false),
    })).sort((first, second) => first.selectionDistance - second.selectionDistance
      || first.node.pixelIndex - second.node.pixelIndex)
    const best = ranked[0]!
    const allowedDistance = Math.max(maximumDistance, landmark.sourceRadiusPx ?? 0)
    if (best.distance > allowedDistance) continue
    hits.push({
      landmarkId: landmark.id,
      role: landmark.structuralRole,
      nodeId: best.node.id,
      nodeKind: best.node.kind,
      distance: best.distance,
      confidence: landmark.confidence,
      hard: landmark.priority === 'hard' && landmarkObservationState(landmark) === 'observed',
    })
  }
  return hits
}

function removableSpurPixels(
  nodes: readonly MutableNode[],
  branch: RawBranch,
  hits: readonly MedialEndpointRoleHit[],
): readonly number[] {
  const from = nodes[branch.fromNode]!
  const to = nodes[branch.toNode]!
  if (branch.fromNode === branch.toNode) return []
  const endpoint = from.kind === 'endpoint'
    ? from
    : to.kind === 'endpoint'
      ? to
      : undefined
  if (endpoint === undefined) return []
  if (hits.some((hit) => hit.nodeId === endpoint.id && hit.hard)) return []
  const retainedNode = endpoint === from ? to : from
  const retainedPixels = new Set(retainedNode.pixelIndices)
  return branch.pixelIndices.filter((index) => retainedPixels.has(index) === false)
}

function pruneShortSpurs(
  source: Uint8Array,
  signedDistance: Float32Array,
  width: number,
  height: number,
  landmarks: readonly ImageLandmark[],
  minimumLength: number,
  snapDistance: number,
): { skeleton: Uint8Array; prunedSpurCount: number } {
  const skeleton = source.slice()
  const preservedClosedHoleCount = closedHoleCount(source, width, height)
  let prunedSpurCount = 0
  let changed = true
  while (changed) {
    changed = false
    const compressed = compressSkeleton(skeleton, signedDistance, width, height)
    const hits = matchEndpointRoles(compressed.nodes, landmarks, width, snapDistance)
    const removals = new Set<number>()
    let prunedThisPass = 0
    for (const branch of compressed.branches) {
      const branchLimit = branch.fromNode === branch.toNode ? minimumLength * 1.5 : minimumLength
      if (branch.geodesicLength >= branchLimit) continue
      const branchRemovals = removableSpurPixels(compressed.nodes, branch, hits)
      if (branchRemovals.length === 0) continue
      if (preservedClosedHoleCount > 0) {
        const trial = skeleton.slice()
        for (const index of removals) trial[index] = 0
        for (const index of branchRemovals) trial[index] = 0
        if (closedHoleCount(trial, width, height) !== preservedClosedHoleCount) continue
      }
      prunedThisPass += 1
      for (const index of branchRemovals) removals.add(index)
    }
    if (removals.size === 0) continue
    for (const index of removals) skeleton[index] = 0
    prunedSpurCount += prunedThisPass
    changed = true
  }
  return { skeleton, prunedSpurCount }
}

function publicGraph(
  model: SourceShapeModel,
  candidateMask: Uint8Array,
  skeletonMask: Uint8Array,
  signedDistance: Float32Array,
  landmarks: readonly ImageLandmark[],
  snapDistance: number,
  prunedSpurCount: number,
): MedialGraph {
  const compressed = compressSkeleton(skeletonMask, signedDistance, model.width, model.height)
  const endpointRoleHits = matchEndpointRoles(compressed.nodes, landmarks, model.width, snapDistance)
  const nodes: MedialGraphNode[] = compressed.nodes.map((node) => ({ ...node }))
  const branches: MedialGraphBranch[] = compressed.branches.map((branch, index) => {
    const from = compressed.nodes[branch.fromNode]!
    const to = compressed.nodes[branch.toNode]!
    const branchEndpointRoleHits = endpointRoleHits
      .filter((hit) => hit.nodeId === from.id || hit.nodeId === to.id)
    return {
      id: `medial-branch-${index}`,
      fromNodeId: from.id,
      toNodeId: to.id,
      fromNodeKind: from.kind,
      toNodeKind: to.kind,
      pixelIndices: branch.pixelIndices,
      geodesicLength: branch.geodesicLength,
      straightLength: branch.straightLength,
      minimumLocalRadius: branch.minimumLocalRadius,
      medianLocalRadius: branch.medianLocalRadius,
      robustMinimumDiameter: robustMinimumDiameter(
        branch,
        from,
        to,
        branchEndpointRoleHits,
        signedDistance,
      ),
      endpointRoleHits: branchEndpointRoleHits,
    }
  })
  return {
    width: model.width,
    height: model.height,
    candidateMask,
    skeletonMask,
    nodes,
    branches,
    endpointRoleHits,
    prunedSpurCount,
  }
}

/**
 * Builds a deterministic medial branch graph from the source signed-distance field.
 * Distance-ordered thinning follows scikit-image's medial-axis ordering, while
 * branch compression follows Skan's endpoint/junction path representation.
 */
export function buildMedialGraph(
  model: SourceShapeModel,
  options: MedialGraphOptions = {},
): MedialGraph {
  if (model.width <= 0 || model.height <= 0
    || model.binaryMask.length !== model.width * model.height
    || model.signedDistance.length !== model.binaryMask.length) {
    throw new RangeError('Medial graph source model dimensions must align')
  }
  const minimumSpurGeodesicLength = finiteNonNegative(
    options.minimumSpurGeodesicLength ?? 2.5,
    'Medial graph spur length',
  )
  const endpointSnapDistancePixels = finiteNonNegative(
    options.endpointSnapDistancePixels ?? 2.5,
    'Medial graph endpoint snap distance',
  )
  const landmarks = options.landmarks ?? []
  const source = activeCrop(model, options.crop)
  const activeSignedDistance = options.crop === undefined
    ? model.signedDistance
    : signedDistanceField(source, model.width, model.height)
  const candidateMask = ridgeCandidates(source, activeSignedDistance, model.width, model.height)
  const protectedPixels = protectedEndpointPixels(source, model.width, landmarks)
  const initialSkeleton = thinByDistanceOrder(
    source,
    candidateMask,
    activeSignedDistance,
    model.width,
    model.height,
    protectedPixels,
  )
  const pruned = pruneShortSpurs(
    initialSkeleton,
    activeSignedDistance,
    model.width,
    model.height,
    landmarks,
    minimumSpurGeodesicLength,
    endpointSnapDistancePixels,
  )
  return publicGraph(
    model,
    candidateMask,
    pruned.skeleton,
    activeSignedDistance,
    landmarks,
    endpointSnapDistancePixels,
    pruned.prunedSpurCount,
  )
}
