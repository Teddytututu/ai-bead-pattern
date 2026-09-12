import {
  gridCellForSourcePoint,
  sourcePointForGridCell,
  type CanvasFit,
} from './image.js'
import {
  landmarkEffectiveConfidence,
  landmarkGridRadiusCells,
  landmarkMayEditOccupancy,
  landmarkObservationState,
} from './landmarks.js'
import {
  bridgeOrthogonalLinks,
  fragileOrthogonalCells,
  type OrthogonalConnectivityLink,
} from './craft-connectivity.js'
import { petOccupancyPathEdges } from './pet-structure.js'
import {
  evaluateTopologyAgreement,
  projectTopologyReference,
  scoreTopologyAgreement,
} from './topology-metrics.js'
import type {
  BinaryMask,
  CropRect,
  ImageLandmark,
  LandmarkKind,
  StructuralRole,
} from './types.js'

export interface ShapePoint {
  x: number
  y: number
}

export interface ShapeBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ShapeContour {
  componentId: number
  points: readonly ShapePoint[]
  hole: boolean
}

export interface ShapeComponent {
  id: number
  area: number
  bounds: ShapeBounds
  touchesBorder: boolean
}

export interface ShapeAnchor {
  landmarkId: string
  kind: LandmarkKind
  source: readonly [number, number]
  minimumCells: number
  hard: boolean
  confidence: number
}

export interface SourceShapeModel {
  width: number
  height: number
  mask: BinaryMask
  binaryMask: Uint8Array
  signedDistance: Float32Array
  contours: readonly ShapeContour[]
  components: readonly ShapeComponent[]
  holes: number
  anchors: readonly ShapeAnchor[]
  foregroundArea: number
  confidence: number
}

export interface LandmarkAllocation {
  landmarkId: string
  targetCenter: readonly [number, number]
  allocatedCells: readonly number[]
  confidence: number
}

export interface ShapeDiagnostics {
  referenceComponents: number
  targetComponents: number
  referenceHoles: number
  targetHoles: number
  boundaryIoU: number
  coverageIoU: number
  topologyCenterlinePrecision: number
  topologyCenterlineRecall: number
  topologyClDice: number
  topologyWeightedCenterlinePrecision: number
  topologyWeightedCenterlineRecall: number
  topologyWeightedClDice: number
  topologyEndpointPrecision: number
  topologyEndpointRecall: number
  topologyEndpointF1: number
  topologyJunctionPrecision: number
  topologyJunctionRecall: number
  topologyJunctionF1: number
  topologyBranchCountAgreement: number
  topologyCycleCountAgreement: number
  topologyComponentCountAgreement: number
  topologyScore: number
  meanBoundaryDistance: number
  occupancyRatio: number
  orthogonalBridgeCells: number
  fragileOrthogonalBridgeCells: number
  craftComponentsBeforeBridging: number
  craftComponentsAfterBridging: number
  rejectedOrthogonalLinks: number
  orthogonalBridgeReuseCount: number
  orthogonalBridgeSimplePointRejections: number
  orthogonalBridgeTopologyRejections: number
  orthogonalBridgeHoleRejections: number
  orthogonalBridgeOwnerRejections: number
  craftHolesBeforeBridging: number
  craftHolesAfterBridging: number
  shapeEdits: number
  energyBefore: number
  energyAfter: number
}

export interface ShapeRasterization {
  width: number
  height: number
  coverage: Float32Array
  activeMask: Uint8Array
  signedDistance: Float32Array
  boundaryBand: Uint8Array
  boundaryAnchors: ReadonlySet<number>
  protectedCells: ReadonlySet<number>
  landmarkAllocations: readonly LandmarkAllocation[]
  diagnostics: ShapeDiagnostics
}

export interface ShapeRasterizationOptions {
  refinementIterations?: number
  preserveThinStructures?: boolean
}

export const shapeRasterizationThreshold = 0.5

interface LabeledComponents {
  labels: Int32Array
  components: readonly ShapeComponent[]
}

interface DirectedEdge {
  start: number
  end: number
  direction: 0 | 1 | 2 | 3
}

const orthogonalOffsets = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const

const surroundingOffsets = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
] as const

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function labelComponents(
  values: Uint8Array,
  width: number,
  height: number,
  connectivity: readonly (readonly [number, number])[] = orthogonalOffsets,
): LabeledComponents {
  const labels = new Int32Array(values.length)
  labels.fill(-1)
  const queue = new Int32Array(values.length)
  const components: ShapeComponent[] = []
  for (let start = 0; start < values.length; start += 1) {
    if (values[start] !== 1 || labels[start] !== -1) continue
    const id = components.length
    let head = 0
    let tail = 0
    let area = 0
    let minimumX = width
    let minimumY = height
    let maximumX = 0
    let maximumY = 0
    let touchesBorder = false
    labels[start] = id
    queue[tail++] = start
    while (head < tail) {
      const index = queue[head++]!
      const x = index % width
      const y = Math.floor(index / width)
      area += 1
      minimumX = Math.min(minimumX, x)
      minimumY = Math.min(minimumY, y)
      maximumX = Math.max(maximumX, x)
      maximumY = Math.max(maximumY, y)
      touchesBorder ||= x === 0 || y === 0 || x === width - 1 || y === height - 1
      for (const [offsetX, offsetY] of connectivity) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
        const next = nextY * width + nextX
        if (values[next] === 1 && labels[next] === -1) {
          labels[next] = id
          queue[tail++] = next
        }
      }
    }
    components.push({
      id,
      area,
      bounds: {
        x: minimumX,
        y: minimumY,
        width: maximumX - minimumX + 1,
        height: maximumY - minimumY + 1,
      },
      touchesBorder,
    })
  }
  return { labels, components }
}

function countHoles(values: Uint8Array, width: number, height: number): number {
  return countHolesWithConnectivity(values, width, height, surroundingOffsets)
}

function countHolesWithConnectivity(
  values: Uint8Array,
  width: number,
  height: number,
  connectivity: readonly (readonly [number, number])[],
): number {
  const visited = new Uint8Array(values.length)
  const queue = new Int32Array(values.length)
  let holes = 0
  for (let start = 0; start < values.length; start += 1) {
    if (values[start] === 1 || visited[start] === 1) continue
    let head = 0
    let tail = 0
    let touchesBorder = false
    visited[start] = 1
    queue[tail++] = start
    while (head < tail) {
      const index = queue[head++]!
      const x = index % width
      const y = Math.floor(index / width)
      touchesBorder ||= x === 0 || y === 0 || x === width - 1 || y === height - 1
      for (const [offsetX, offsetY] of connectivity) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
        const next = nextY * width + nextX
        if (values[next] === 0 && visited[next] === 0) {
          visited[next] = 1
          queue[tail++] = next
        }
      }
    }
    if (touchesBorder === false) holes += 1
  }
  return holes
}

function boundaryEdgesByComponent(
  labels: Int32Array,
  width: number,
  height: number,
  componentCount: number,
): readonly (readonly DirectedEdge[])[] {
  const stride = width + 1
  const edges = Array.from({ length: componentCount }, () => [] as DirectedEdge[])
  const vertex = (x: number, y: number): number => y * stride + x
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const componentId = labels[y * width + x]!
      if (componentId < 0) continue
      const componentEdges = edges[componentId]!
      if (y === 0 || labels[(y - 1) * width + x] !== componentId) {
        componentEdges.push({ start: vertex(x, y), end: vertex(x + 1, y), direction: 0 })
      }
      if (x === width - 1 || labels[y * width + x + 1] !== componentId) {
        componentEdges.push({ start: vertex(x + 1, y), end: vertex(x + 1, y + 1), direction: 1 })
      }
      if (y === height - 1 || labels[(y + 1) * width + x] !== componentId) {
        componentEdges.push({ start: vertex(x + 1, y + 1), end: vertex(x, y + 1), direction: 2 })
      }
      if (x === 0 || labels[y * width + x - 1] !== componentId) {
        componentEdges.push({ start: vertex(x, y + 1), end: vertex(x, y), direction: 3 })
      }
    }
  }
  return edges
}

function signedArea(points: readonly ShapePoint[]): number {
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!
    const next = points[(index + 1) % points.length]!
    area += current.x * next.y - next.x * current.y
  }
  return area / 2
}

function traceContours(components: LabeledComponents, width: number, height: number): readonly ShapeContour[] {
  const contours: ShapeContour[] = []
  const stride = width + 1
  const edgeGroups = boundaryEdgesByComponent(
    components.labels,
    width,
    height,
    components.components.length,
  )
  const point = (vertex: number): ShapePoint => ({
    x: vertex % stride,
    y: Math.floor(vertex / stride),
  })
  const turnPriority = [1, 0, 3, 2] as const
  for (const component of components.components) {
    const edges = edgeGroups[component.id] ?? []
    const visited = new Uint8Array(edges.length)
    const byStart = new Map<number, number[]>()
    for (let edgeId = 0; edgeId < edges.length; edgeId += 1) {
      const edge = edges[edgeId]!
      const entries = byStart.get(edge.start) ?? []
      entries.push(edgeId)
      byStart.set(edge.start, entries)
    }
    for (let firstId = 0; firstId < edges.length; firstId += 1) {
      if (visited[firstId] === 1) continue
      const first = edges[firstId]!
      const points: ShapePoint[] = [point(first.start)]
      let currentId = firstId
      let closed = false
      for (let traversed = 0; traversed <= edges.length; traversed += 1) {
        const current = edges[currentId]!
        visited[currentId] = 1
        if (current.end === first.start) {
          closed = true
          break
        }
        points.push(point(current.end))
        const candidates = (byStart.get(current.end) ?? []).filter((edgeId) => visited[edgeId] === 0)
        if (candidates.length === 0) break
        currentId = candidates.reduce((bestId, candidateId) => {
          const bestTurn = (edges[bestId]!.direction - current.direction + 4) % 4
          const candidateTurn = (edges[candidateId]!.direction - current.direction + 4) % 4
          return turnPriority.indexOf(candidateTurn as typeof turnPriority[number])
            < turnPriority.indexOf(bestTurn as typeof turnPriority[number])
            ? candidateId
            : bestId
        })
      }
      if (points.length >= 4 && closed) {
        contours.push({
          componentId: component.id,
          points,
          hole: signedArea(points) < 0,
        })
      }
    }
  }
  return contours
}

function distanceTransform1d(input: Float64Array): Float64Array {
  const length = input.length
  const output = new Float64Array(length)
  const locations = new Int32Array(length)
  const boundaries = new Float64Array(length + 1)
  let count = 0
  locations[0] = 0
  boundaries[0] = Number.NEGATIVE_INFINITY
  boundaries[1] = Number.POSITIVE_INFINITY
  for (let position = 1; position < length; position += 1) {
    let intersection = ((input[position]! + position * position)
      - (input[locations[count]!]! + locations[count]! * locations[count]!))
      / (2 * position - 2 * locations[count]!)
    while (intersection <= boundaries[count]!) {
      count -= 1
      intersection = ((input[position]! + position * position)
        - (input[locations[count]!]! + locations[count]! * locations[count]!))
        / (2 * position - 2 * locations[count]!)
    }
    count += 1
    locations[count] = position
    boundaries[count] = intersection
    boundaries[count + 1] = Number.POSITIVE_INFINITY
  }
  count = 0
  for (let position = 0; position < length; position += 1) {
    while (boundaries[count + 1]! < position) count += 1
    const delta = position - locations[count]!
    output[position] = delta * delta + input[locations[count]!]!
  }
  return output
}

function squaredDistanceTransform(
  values: Uint8Array,
  width: number,
  height: number,
  target: 0 | 1,
): Float64Array {
  const maximumDistance = width * width + height * height + 1
  const vertical = new Float64Array(values.length)
  for (let x = 0; x < width; x += 1) {
    const column = new Float64Array(height)
    for (let y = 0; y < height; y += 1) {
      column[y] = values[y * width + x] === target ? 0 : maximumDistance
    }
    const transformed = distanceTransform1d(column)
    for (let y = 0; y < height; y += 1) vertical[y * width + x] = transformed[y]!
  }
  const output = new Float64Array(values.length)
  for (let y = 0; y < height; y += 1) {
    const row = vertical.slice(y * width, (y + 1) * width)
    const transformed = distanceTransform1d(row)
    output.set(transformed, y * width)
  }
  return output
}

export function signedDistanceField(values: Uint8Array, width: number, height: number): Float32Array {
  const distanceToInside = squaredDistanceTransform(values, width, height, 1)
  const distanceToOutside = squaredDistanceTransform(values, width, height, 0)
  return Float32Array.from(values, (value, index) => value === 1
    ? Math.sqrt(distanceToOutside[index]!)
    : -Math.sqrt(distanceToInside[index]!))
}

function anchorMinimumCells(landmark: ImageLandmark): number {
  if (landmark.priority === 'soft') return 0
  const radius = Math.max(0, Math.floor(landmark.gridRadiusCells ?? landmark.radius ?? 0))
  return Math.max(1, radius * 2 + 1)
}

export function buildSourceShapeModel(
  mask: BinaryMask,
  confidence: number,
  landmarks: readonly ImageLandmark[] = [],
): SourceShapeModel {
  const binaryMask = Uint8Array.from(
    mask.values,
    (value) => value >= shapeRasterizationThreshold ? 1 : 0,
  )
  const labeled = labelComponents(binaryMask, mask.width, mask.height)
  const foregroundArea = binaryMask.reduce((sum, value) => sum + value, 0)
  const modelConfidence = clamp(confidence, 0, 1)
  const signedDistance = signedDistanceField(binaryMask, mask.width, mask.height)
  return {
    width: mask.width,
    height: mask.height,
    mask,
    binaryMask,
    signedDistance,
    contours: traceContours(labeled, mask.width, mask.height),
    components: labeled.components,
    holes: countHoles(binaryMask, mask.width, mask.height),
    anchors: landmarks.filter(landmarkMayEditOccupancy).map((landmark) => ({
      landmarkId: landmark.id,
      kind: landmark.kind,
      source: [landmark.x, landmark.y],
      minimumCells: anchorMinimumCells(landmark),
      hard: landmark.priority === 'hard' && landmarkObservationState(landmark) === 'observed',
      confidence: landmarkEffectiveConfidence(landmark),
    })),
    foregroundArea,
    confidence: modelConfidence,
  }
}

// The model owns a source snapshot throughout generation. Cache only the summed
// area table; every resolution still receives its exact fractional coverage.
const maskIntegrals = new WeakMap<SourceShapeModel, Float64Array>()

function sourceMaskIntegral(model: SourceShapeModel): Float64Array {
  const cached = maskIntegrals.get(model)
  if (cached !== undefined) return cached
  const stride = model.width + 1
  const integral = new Float64Array(stride * (model.height + 1))
  for (let y = 0; y < model.height; y += 1) {
    let rowSum = 0
    for (let x = 0; x < model.width; x += 1) {
      rowSum += model.mask.values[y * model.width + x] ?? 0
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1]! + rowSum
    }
  }
  maskIntegrals.set(model, integral)
  return integral
}

function integralAt(
  integral: Float64Array, width: number, height: number, x: number, y: number,
): number {
  const left = Math.floor(x)
  const top = Math.floor(y)
  const right = Math.min(width, left + 1)
  const bottom = Math.min(height, top + 1)
  const tx = x - left
  const ty = y - top
  const stride = width + 1
  const upper = integral[top * stride + left]! * (1 - tx) + integral[top * stride + right]! * tx
  const lower = integral[bottom * stride + left]! * (1 - tx) + integral[bottom * stride + right]! * tx
  return upper * (1 - ty) + lower * ty
}

function integralAreaSample(
  mask: BinaryMask,
  integral: Float64Array,
  left: number,
  top: number,
  right: number,
  bottom: number,
): number {
  // Preserve the public sampler's edge-extension behavior for external crops.
  if (left < 0 || top < 0 || right > mask.width || bottom > mask.height) {
    return maskAreaSample(mask, left, top, right, bottom)
  }
  const area = (right - left) * (bottom - top)
  if (area <= 0) return 0
  const sum = integralAt(integral, mask.width, mask.height, right, bottom)
    - integralAt(integral, mask.width, mask.height, left, bottom)
    - integralAt(integral, mask.width, mask.height, right, top)
    + integralAt(integral, mask.width, mask.height, left, top)
  return clamp(sum / area, 0, 1)
}

function maskAreaSample(
  mask: BinaryMask,
  sourceLeft: number,
  sourceTop: number,
  sourceRight: number,
  sourceBottom: number,
): number {
  let weightedTotal = 0
  let totalArea = 0
  for (let sourceY = Math.floor(sourceTop); sourceY < Math.ceil(sourceBottom); sourceY += 1) {
    const overlapY = Math.max(0, Math.min(sourceBottom, sourceY + 1) - Math.max(sourceTop, sourceY))
    for (let sourceX = Math.floor(sourceLeft); sourceX < Math.ceil(sourceRight); sourceX += 1) {
      const overlapX = Math.max(0, Math.min(sourceRight, sourceX + 1) - Math.max(sourceLeft, sourceX))
      const overlap = overlapX * overlapY
      if (overlap <= 0) continue
      const x = clamp(sourceX, 0, mask.width - 1)
      const y = clamp(sourceY, 0, mask.height - 1)
      weightedTotal += (mask.values[y * mask.width + x] ?? 0) * overlap
      totalArea += overlap
    }
  }
  return totalArea > 0 ? clamp(weightedTotal / totalArea, 0, 1) : 0
}

function maskPeakSample(
  mask: BinaryMask,
  sourceLeft: number,
  sourceTop: number,
  sourceRight: number,
  sourceBottom: number,
): number {
  let peak = 0
  for (let sourceY = Math.floor(sourceTop); sourceY < Math.ceil(sourceBottom); sourceY += 1) {
    const overlapY = Math.max(0, Math.min(sourceBottom, sourceY + 1) - Math.max(sourceTop, sourceY))
    for (let sourceX = Math.floor(sourceLeft); sourceX < Math.ceil(sourceRight); sourceX += 1) {
      const overlapX = Math.max(0, Math.min(sourceRight, sourceX + 1) - Math.max(sourceLeft, sourceX))
      if (overlapX * overlapY <= 0) continue
      const x = clamp(sourceX, 0, mask.width - 1)
      const y = clamp(sourceY, 0, mask.height - 1)
      peak = Math.max(peak, clamp(mask.values[y * mask.width + x] ?? 0, 0, 1))
    }
  }
  return peak
}

interface ThinStructureProjection {
  protectedCells: ReadonlySet<number>
  bridgeCells: ReadonlySet<number>
  bridgeEndpointCells: ReadonlySet<number>
  fragileBridgeCells: ReadonlySet<number>
  craftComponentsBeforeBridging: number
  craftComponentsAfterBridging: number
  rejectedOrthogonalLinks: number
  orthogonalBridgeReuseCount: number
  orthogonalBridgeSimplePointRejections: number
  orthogonalBridgeTopologyRejections: number
  orthogonalBridgeHoleRejections: number
  orthogonalBridgeOwnerRejections: number
  craftHolesBeforeBridging: number
  craftHolesAfterBridging: number
  edits: number
}

function projectThinStructures(
  model: SourceShapeModel,
  crop: CropRect,
  fit: CanvasFit,
  width: number,
  height: number,
  activeMask: Uint8Array,
  topologyReferenceMask: Uint8Array,
): ThinStructureProjection {
  const sourceBoundary = boundaryMask(model.binaryMask, model.width, model.height)
  const sourceTopology = labelComponents(
    sourceBoundary,
    model.width,
    model.height,
    surroundingOffsets,
  )
  const projectedCells = new Int32Array(sourceBoundary.length)
  projectedCells.fill(-1)
  const owners = new Int32Array(activeMask.length)
  owners.fill(-1)
  const protectedCells = new Set<number>()
  const links: OrthogonalConnectivityLink[] = []
  let edits = 0

  for (let sourceIndex = 0; sourceIndex < sourceBoundary.length; sourceIndex += 1) {
    if (sourceBoundary[sourceIndex] !== 1) continue
    const sourceX = sourceIndex % model.width
    const sourceY = Math.floor(sourceIndex / model.width)
    const centerX = sourceX + 0.5
    const centerY = sourceY + 0.5
    if (centerX < crop.x || centerY < crop.y
      || centerX >= crop.x + crop.width || centerY >= crop.y + crop.height) continue
    const [targetX, targetY] = gridCellForSourcePoint(crop, fit, centerX, centerY)
    if (targetX < 0 || targetY < 0 || targetX >= width || targetY >= height) continue
    const targetCell = targetY * width + targetX
    const componentId = sourceTopology.labels[sourceIndex] ?? -1
    if (componentId < 0) continue
    const owner = owners[targetCell] ?? -1
    if (owner >= 0 && owner !== componentId) continue
    owners[targetCell] = componentId
    projectedCells[sourceIndex] = targetCell
    if (activeMask[targetCell] === 0) {
      activeMask[targetCell] = 1
      edits += 1
    }
    protectedCells.add(targetCell)
  }

  const forwardNeighbors = [
    [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ] as const
  for (let sourceIndex = 0; sourceIndex < sourceBoundary.length; sourceIndex += 1) {
    const start = projectedCells[sourceIndex] ?? -1
    if (start < 0) continue
    const sourceX = sourceIndex % model.width
    const sourceY = Math.floor(sourceIndex / model.width)
    const componentId = sourceTopology.labels[sourceIndex] ?? -1
    for (const [offsetX, offsetY] of forwardNeighbors) {
      const nextX = sourceX + offsetX
      const nextY = sourceY + offsetY
      if (nextX < 0 || nextY < 0 || nextX >= model.width || nextY >= model.height) continue
      const nextSource = nextY * model.width + nextX
      const end = projectedCells[nextSource] ?? -1
      if (end < 0 || sourceTopology.labels[nextSource] !== componentId) continue
      links.push({ start, end, componentId })
    }
  }

  const bridge = bridgeOrthogonalLinks({
    width,
    height,
    values: activeMask,
    links,
    holeReference: topologyReferenceMask,
    componentOwners: owners,
  })
  activeMask.set(bridge.mask)
  for (const cell of bridge.addedCells) protectedCells.add(cell)
  edits += bridge.addedCells.length
  return {
    protectedCells,
    bridgeCells: new Set(bridge.addedCells),
    bridgeEndpointCells: new Set(bridge.bridgeEndpointCells),
    fragileBridgeCells: new Set(bridge.fragileBridgeCells),
    craftComponentsBeforeBridging: bridge.fourConnectedComponentsBefore,
    craftComponentsAfterBridging: bridge.fourConnectedComponentsAfter,
    rejectedOrthogonalLinks: bridge.rejectedLinks,
    orthogonalBridgeReuseCount: bridge.bridgeReuseCount,
    orthogonalBridgeSimplePointRejections: bridge.simplePointRejections,
    orthogonalBridgeTopologyRejections: bridge.topologyRejections,
    orthogonalBridgeHoleRejections: bridge.holeRejections,
    orthogonalBridgeOwnerRejections: bridge.ownerRejections,
    craftHolesBeforeBridging: bridge.holesBefore,
    craftHolesAfterBridging: bridge.holesAfter,
    edits,
  }
}

function boundaryMask(values: Uint8Array, width: number, height: number): Uint8Array {
  const boundary = new Uint8Array(values.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      if (values[index] !== 1) continue
      for (const [offsetX, offsetY] of orthogonalOffsets) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height
          || values[nextY * width + nextX] !== 1) {
          boundary[index] = 1
          break
        }
      }
    }
  }
  return boundary
}

function dilate(values: Uint8Array, width: number, height: number): Uint8Array {
  const output = new Uint8Array(values.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let active = 0
      for (let offsetY = -1; offsetY <= 1 && active === 0; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const nextX = x + offsetX
          const nextY = y + offsetY
          if (nextX >= 0 && nextY >= 0 && nextX < width && nextY < height
            && values[nextY * width + nextX] === 1) {
            active = 1
            break
          }
        }
      }
      output[y * width + x] = active
    }
  }
  return output
}

function sampleSdf(model: SourceShapeModel, sourceX: number, sourceY: number): number {
  const x = clamp(sourceX, 0, model.width - 1)
  const y = clamp(sourceY, 0, model.height - 1)
  const left = Math.floor(x)
  const top = Math.floor(y)
  const right = Math.min(model.width - 1, left + 1)
  const bottom = Math.min(model.height - 1, top + 1)
  const tx = x - left
  const ty = y - top
  const topValue = model.signedDistance[top * model.width + left]! * (1 - tx)
    + model.signedDistance[top * model.width + right]! * tx
  const bottomValue = model.signedDistance[bottom * model.width + left]! * (1 - tx)
    + model.signedDistance[bottom * model.width + right]! * tx
  return topValue * (1 - ty) + bottomValue * ty
}

function projectSignedDistance(
  model: SourceShapeModel,
  crop: CropRect,
  fit: CanvasFit,
  width: number,
  height: number,
): Float32Array {
  const projected = new Float32Array(width * height)
  const sourceCellScale = Math.max(1e-6, (crop.width / fit.width + crop.height / fit.height) / 2)
  projected.fill(-Math.hypot(width, height))
  for (let y = fit.y; y < fit.y + fit.height; y += 1) {
    for (let x = fit.x; x < fit.x + fit.width; x += 1) {
      const source = sourcePointForGridCell(crop, fit, x, y)
      if (source === undefined) continue
      projected[y * width + x] = sampleSdf(model, source[0], source[1]) / sourceCellScale
    }
  }
  return projected
}

function tracedContourAnchors(
  model: SourceShapeModel,
  crop: CropRect,
  fit: CanvasFit,
  width: number,
  height: number,
  activeMask: Uint8Array,
): ReadonlySet<number> {
  const anchors = new Set<number>()
  for (const contour of model.contours) {
    if (contour.points.length === 0) continue
    const sampleCount = Math.max(4, Math.min(16, Math.ceil(contour.points.length / 24)))
    const step = Math.max(1, Math.floor(contour.points.length / sampleCount))
    for (let pointIndex = 0; pointIndex < contour.points.length; pointIndex += step) {
      const point = contour.points[pointIndex]!
      const sourceX = clamp(point.x, 0, model.width - 1)
      const sourceY = clamp(point.y, 0, model.height - 1)
      if (sourceX < crop.x || sourceY < crop.y
        || sourceX >= crop.x + crop.width || sourceY >= crop.y + crop.height) continue
      const [centerX, centerY] = gridCellForSourcePoint(crop, fit, sourceX, sourceY)
      let nearestCell = -1
      let nearestDistance = Number.POSITIVE_INFINITY
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const x = centerX + offsetX
          const y = centerY + offsetY
          if (x < 0 || y < 0 || x >= width || y >= height) continue
          const cell = y * width + x
          if (activeMask[cell] !== 1) continue
          const distance = offsetX * offsetX + offsetY * offsetY
          if (distance < nearestDistance) {
            nearestCell = cell
            nearestDistance = distance
          }
        }
      }
      if (nearestCell >= 0) anchors.add(nearestCell)
    }
  }
  return anchors
}

function sdfBoundaryIoU(
  values: Uint8Array,
  projectedSdf: Float32Array,
  width: number,
  height: number,
): number {
  const targetBand = dilate(boundaryMask(values, width, height), width, height)
  let intersection = 0
  let union = 0
  for (let index = 0; index < values.length; index += 1) {
    const sourceBoundary = Math.abs(projectedSdf[index] ?? 0) <= 1.25
    const targetBoundary = targetBand[index] === 1
    if (sourceBoundary && targetBoundary) intersection += 1
    if (sourceBoundary || targetBoundary) union += 1
  }
  return union === 0 ? 1 : intersection / union
}

function sdfMeanBoundaryDistance(
  values: Uint8Array,
  projectedSdf: Float32Array,
  width: number,
  height: number,
): number {
  const boundary = boundaryMask(values, width, height)
  let total = 0
  let count = 0
  for (let index = 0; index < boundary.length; index += 1) {
    if (boundary[index] === 0) continue
    total += Math.abs(projectedSdf[index] ?? 0)
    count += 1
  }
  return count === 0 ? 0 : clamp(total / count / Math.max(1, Math.hypot(width, height)), 0, 1)
}

function coverageIoU(coverage: Float32Array, activeMask: Uint8Array): number {
  let intersection = 0
  let union = 0
  for (let index = 0; index < coverage.length; index += 1) {
    intersection += Math.min(coverage[index] ?? 0, activeMask[index] ?? 0)
    union += Math.max(coverage[index] ?? 0, activeMask[index] ?? 0)
  }
  return union === 0 ? 1 : intersection / union
}

function shapeEnergy(
  values: Uint8Array,
  coverage: Float32Array,
  projectedSdf: Float32Array,
  width: number,
  height: number,
  referenceComponents: number,
  referenceHoles: number,
  contourAnchors: ReadonlySet<number>,
): number {
  const boundary = boundaryMask(values, width, height)
  let energy = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      const active = values[index] ?? 0
      const cellCoverage = coverage[index] ?? 0
      const sdf = projectedSdf[index] ?? 0
      energy += Math.abs(active - cellCoverage)
      if (contourAnchors.has(index) && active === 0) energy += 0.05
      if (active === 1 && sdf < 0) energy += Math.min(2, -sdf) * 0.35
      if (active === 0 && sdf > 0) energy += Math.min(2, sdf) * 0.35
      if (boundary[index] === 1) energy += Math.min(2, Math.abs(sdf)) * 0.25
      if (active === 0) continue
      let neighbors = 0
      for (const [offsetX, offsetY] of orthogonalOffsets) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX >= 0 && nextY >= 0 && nextX < width && nextY < height
          && values[nextY * width + nextX] === 1) neighbors += 1
      }
      if (neighbors === 0) energy += 0.8
      else if (neighbors === 1) energy += 0.12
    }
  }
  const topology = labelComponents(values, width, height)
  energy += Math.abs(topology.components.length - referenceComponents) * 1.5
  energy += Math.abs(
    countHolesWithConnectivity(values, width, height, orthogonalOffsets) - referenceHoles,
  ) * 1.5
  return energy
}

function optimizeBoundaryEnergy(
  activeMask: Uint8Array,
  coverage: Float32Array,
  projectedSdf: Float32Array,
  width: number,
  height: number,
  referenceComponents: number,
  referenceHoles: number,
  protectedCells: ReadonlySet<number>,
  contourAnchors: ReadonlySet<number>,
  iterations: number,
): { edits: number; before: number; after: number } {
  const referenceBand = dilate(boundaryMask(activeMask, width, height), width, height)
  const candidates: number[] = []
  for (let index = 0; index < activeMask.length; index += 1) {
    const cellCoverage = coverage[index] ?? 0
    if (referenceBand[index] === 1 || (cellCoverage > 0.05 && cellCoverage < 0.95)
      || Math.abs(projectedSdf[index] ?? 0) <= 1.5) candidates.push(index)
  }
  let current = shapeEnergy(
    activeMask,
    coverage,
    projectedSdf,
    width,
    height,
    referenceComponents,
    referenceHoles,
    contourAnchors,
  )
  const before = current
  let edits = 0
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let accepted = 0
    for (const index of candidates) {
      if (protectedCells.has(index)) continue
      activeMask[index] = activeMask[index] === 1 ? 0 : 1
      const next = shapeEnergy(
        activeMask,
        coverage,
        projectedSdf,
        width,
        height,
        referenceComponents,
        referenceHoles,
        contourAnchors,
      )
      if (next + 1e-9 < current) {
        current = next
        accepted += 1
        edits += 1
      } else {
        activeMask[index] = activeMask[index] === 1 ? 0 : 1
      }
    }
    if (accepted === 0) break
  }
  return { edits, before, after: current }
}

function allocateLandmarks(
  landmarks: readonly ImageLandmark[],
  crop: CropRect,
  fit: CanvasFit,
  width: number,
  height: number,
  activeMask: Uint8Array,
): { allocations: readonly LandmarkAllocation[]; protectedCells: ReadonlySet<number>; edits: number } {
  const allocations: LandmarkAllocation[] = []
  const protectedCells = new Set<number>()
  let edits = 0
  for (const landmark of landmarks) {
    const confidence = landmarkEffectiveConfidence(landmark)
    if (landmarkMayEditOccupancy(landmark) === false
      || landmark.priority !== 'hard' || confidence < 0.5) continue
    if (landmark.x < crop.x || landmark.y < crop.y
      || landmark.x >= crop.x + crop.width || landmark.y >= crop.y + crop.height) continue
    const [centerX, centerY] = gridCellForSourcePoint(crop, fit, landmark.x, landmark.y)
    const radius = landmarkGridRadiusCells(landmark, crop, fit)
    const allocatedCells: number[] = []
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        if (Math.hypot(offsetX, offsetY) > radius + 0.25) continue
        const x = centerX + offsetX
        const y = centerY + offsetY
        if (x < 0 || y < 0 || x >= width || y >= height) continue
        const index = y * width + x
        if (activeMask[index] === 0) {
          activeMask[index] = 1
          edits += 1
        }
        protectedCells.add(index)
        allocatedCells.push(index)
      }
    }
    if (allocatedCells.length === 0) {
      const index = centerY * width + centerX
      activeMask[index] = 1
      protectedCells.add(index)
      allocatedCells.push(index)
      edits += 1
    }
    allocations.push({
      landmarkId: landmark.id,
      targetCenter: [centerX, centerY],
      allocatedCells,
      confidence,
    })
  }
  return { allocations, protectedCells, edits }
}

function structuralLandmarksByRole(
  landmarks: readonly ImageLandmark[],
): ReadonlyMap<StructuralRole, ImageLandmark> {
  const result = new Map<StructuralRole, ImageLandmark>()
  for (const landmark of landmarks) {
    if (landmark.structuralRole === undefined || landmarkObservationState(landmark) === 'missing') continue
    const current = result.get(landmark.structuralRole)
    if (current === undefined
      || landmarkEffectiveConfidence(landmark) > landmarkEffectiveConfidence(current)) {
      result.set(landmark.structuralRole, landmark)
    }
  }
  return result
}

function landmarkInstanceKey(landmark: ImageLandmark): string {
  const separator = landmark.id.indexOf(':')
  return separator > 0 ? landmark.id.slice(0, separator) : 'primary'
}

function structuralLandmarkGroupsByRole(
  landmarks: readonly ImageLandmark[],
): readonly ReadonlyMap<StructuralRole, ImageLandmark>[] {
  const groups = new Map<string, ImageLandmark[]>()
  for (const landmark of landmarks) {
    const key = landmarkInstanceKey(landmark)
    const group = groups.get(key) ?? []
    group.push(landmark)
    groups.set(key, group)
  }
  return [...groups.values()].map(structuralLandmarksByRole)
}

const inferredOccupancyPathRoles = new Set<StructuralRole>([
  'neck-base',
  'shoulder',
  'chest-center',
  'back-middle',
  'tail-root',
  'hip',
  'front-knee',
  'front-paw',
  'rear-knee',
  'rear-paw',
  'tail-tip',
])

function maskSupportsCell(
  activeMask: Uint8Array,
  width: number,
  height: number,
  cell: number,
  radius: number,
): boolean {
  const centerX = cell % width
  const centerY = Math.floor(cell / width)
  for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      const x = centerX + offsetX
      const y = centerY + offsetY
      if (x < 0 || y < 0 || x >= width || y >= height) continue
      if (activeMask[y * width + x] === 1) return true
    }
  }
  return false
}

function structuralPathEndpointEligible(landmark: ImageLandmark): boolean {
  const state = landmarkObservationState(landmark)
  const confidence = landmarkEffectiveConfidence(landmark)
  if (state === 'observed') {
    return landmark.priority === 'hard'
      && landmark.affectsOccupancy === true
      && confidence >= 0.5
  }
  return state === 'inferred'
    && landmark.structuralRole !== undefined
    && inferredOccupancyPathRoles.has(landmark.structuralRole)
    && landmark.affectsOccupancy === true
    && confidence >= 0.6
}

function distanceToGridSegment(
  x: number,
  y: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): number {
  const deltaX = endX - startX
  const deltaY = endY - startY
  const squaredLength = deltaX * deltaX + deltaY * deltaY
  if (squaredLength <= 1e-9) return Math.hypot(x - startX, y - startY)
  const amount = clamp(
    ((x - startX) * deltaX + (y - startY) * deltaY) / squaredLength,
    0,
    1,
  )
  return Math.hypot(x - (startX + deltaX * amount), y - (startY + deltaY * amount))
}

function supportedStructuralPath(
  width: number,
  height: number,
  activeMask: Uint8Array,
  start: number,
  end: number,
  maximumBridgeCells = 2,
  corridorScale = 0.4,
  maximumDetourRatio = Number.POSITIVE_INFINITY,
): readonly number[] | undefined {
  if (start < 0 || end < 0 || start >= activeMask.length || end >= activeMask.length) return undefined
  const startX = start % width
  const startY = Math.floor(start / width)
  const endX = end % width
  const endY = Math.floor(end / width)
  const span = Math.hypot(endX - startX, endY - startY)
  const corridorRadius = Math.max(1, Math.ceil(span * corridorScale))
  const offsets = [
    [0, -1], [-1, 0], [1, 0], [0, 1],
    [-1, -1], [1, -1], [-1, 1], [1, 1],
  ] as const

  for (let bridgeLimit = 0; bridgeLimit <= maximumBridgeCells; bridgeLimit += 1) {
    const stateCount = activeMask.length * (bridgeLimit + 1)
    const parent = new Int32Array(stateCount)
    parent.fill(-2)
    const queue = new Int32Array(stateCount)
    let head = 0
    let tail = 0
    const startState = start * (bridgeLimit + 1)
    parent[startState] = -1
    queue[tail++] = startState
    let endState = -1
    while (head < tail && endState < 0) {
      const state = queue[head++]!
      const cell = Math.floor(state / (bridgeLimit + 1))
      const bridges = state % (bridgeLimit + 1)
      if (cell === end) {
        endState = state
        break
      }
      const x = cell % width
      const y = Math.floor(cell / width)
      for (const [offsetX, offsetY] of offsets) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
        if (distanceToGridSegment(nextX, nextY, startX, startY, endX, endY) > corridorRadius) continue
        const next = nextY * width + nextX
        const occupied = activeMask[next] === 1
        const nextBridges = bridges + Number(occupied === false)
        if (nextBridges > bridgeLimit) continue
        const nextState = next * (bridgeLimit + 1) + nextBridges
        if (parent[nextState] !== -2) continue
        parent[nextState] = state
        queue[tail++] = nextState
      }
    }
    if (endState < 0) continue
    const path: number[] = []
    for (let state = endState; state >= 0; state = parent[state] ?? -1) {
      path.push(Math.floor(state / (bridgeLimit + 1)))
    }
    path.reverse()
    if (path.length > Math.max(3, Math.ceil(span * maximumDetourRatio) + 1)) continue
    return path
  }
  return undefined
}

function connectStructuralLandmarkPaths(
  model: SourceShapeModel,
  landmarks: readonly ImageLandmark[],
  crop: CropRect,
  fit: CanvasFit,
  width: number,
  height: number,
  activeMask: Uint8Array,
): { protectedCells: ReadonlySet<number>; edits: number } {
  const protectedCells = new Set<number>()
  let edits = 0
  for (const byRole of structuralLandmarkGroupsByRole(landmarks)) {
    for (const [fromRole, toRole] of petOccupancyPathEdges) {
      const from = byRole.get(fromRole)
      const to = byRole.get(toRole)
      if (from === undefined || to === undefined) continue
      if (structuralPathEndpointEligible(from) === false
        || structuralPathEndpointEligible(to) === false) continue
      const [fromX, fromY] = gridCellForSourcePoint(crop, fit, from.x, from.y)
      const [toX, toY] = gridCellForSourcePoint(crop, fit, to.x, to.y)
      const fromCell = fromY * width + fromX
      const toCell = toY * width + toX
      const inferred = landmarkObservationState(from) === 'inferred'
        || landmarkObservationState(to) === 'inferred'
      if (inferred && (maskSupportsCell(activeMask, width, height, fromCell, 1) === false
        || maskSupportsCell(activeMask, width, height, toCell, 1) === false)) continue
      const path = supportedStructuralPath(
        width,
        height,
        activeMask,
        fromCell,
        toCell,
        inferred ? 1 : 2,
        inferred ? 0.25 : 0.4,
        inferred ? 1.7 : Number.POSITIVE_INFINITY,
      )
      if (path === undefined) continue
      const connectedPath: number[] = []
      for (let index = 0; index < path.length; index += 1) {
        const cell = path[index]!
        const previous = path[index - 1]
        if (previous !== undefined) {
          const previousX = previous % width
          const previousY = Math.floor(previous / width)
          const x = cell % width
          const y = Math.floor(cell / width)
          if (previousX !== x && previousY !== y) connectedPath.push(previousY * width + x)
        }
        connectedPath.push(cell)
      }
      for (const cell of connectedPath) {
        if (activeMask[cell] === 0) {
          activeMask[cell] = 1
          edits += 1
        }
        protectedCells.add(cell)
      }
    }
  }
  return { protectedCells, edits }
}

function trimProfileAccessory(
  landmarks: readonly ImageLandmark[],
  crop: CropRect,
  fit: CanvasFit,
  width: number,
  height: number,
  activeMask: Uint8Array,
  protectedCells: Set<number>,
  semanticProtectedCells: ReadonlySet<number>,
): { edits: number; removedCells: readonly number[] } {
  let edits = 0
  const removedCells: number[] = []
  for (const byRole of structuralLandmarkGroupsByRole(landmarks)) {
    const eye = byRole.get('eye-center')
    const nose = byRole.get('nose-tip')
    const upperJaw = byRole.get('upper-jaw')
    const lowerJaw = byRole.get('lower-jaw')
    if (eye === undefined || nose === undefined || upperJaw === undefined || lowerJaw === undefined) continue
    const [eyeX] = gridCellForSourcePoint(crop, fit, eye.x, eye.y)
    const [noseX] = gridCellForSourcePoint(crop, fit, nose.x, nose.y)
    const [, upperY] = gridCellForSourcePoint(crop, fit, upperJaw.x, upperJaw.y)
    const [, lowerY] = gridCellForSourcePoint(crop, fit, lowerJaw.x, lowerJaw.y)
    const direction = noseX >= eyeX ? 1 : -1
    const minimumY = Math.max(0, Math.min(upperY, lowerY) - 1)
    const maximumY = Math.min(height - 1, Math.max(upperY, lowerY) + 1)
    const maximumRun = Math.max(2, Math.abs(noseX - eyeX) + 1)
    for (let y = minimumY; y <= maximumY; y += 1) {
      for (let step = 1; step <= maximumRun; step += 1) {
        const x = noseX + direction * step
        if (x < 0 || x >= width) break
        const cell = y * width + x
        if (activeMask[cell] !== 1 || semanticProtectedCells.has(cell)) continue
        activeMask[cell] = 0
        protectedCells.delete(cell)
        removedCells.push(cell)
        edits += 1
      }
    }
  }
  return { edits, removedCells }
}

export function rasterizeSourceShape(
  model: SourceShapeModel,
  crop: CropRect,
  fit: CanvasFit,
  width: number,
  height: number,
  landmarks: readonly ImageLandmark[],
  options: ShapeRasterizationOptions = {},
): ShapeRasterization {
  const threshold = shapeRasterizationThreshold
  const coverage = new Float32Array(width * height)
  const activeMask = new Uint8Array(width * height)
  const scaleX = crop.width / fit.width
  const scaleY = crop.height / fit.height
  const integral = sourceMaskIntegral(model)
  for (let y = fit.y; y < fit.y + fit.height; y += 1) {
    for (let x = fit.x; x < fit.x + fit.width; x += 1) {
      const localX = x - fit.x
      const localY = y - fit.y
      const sourceLeft = crop.x + localX * scaleX
      const sourceTop = crop.y + localY * scaleY
      const sourceRight = crop.x + (localX + 1) * scaleX
      const sourceBottom = crop.y + (localY + 1) * scaleY
      const index = y * width + x
      coverage[index] = integralAreaSample(
        model.mask, integral, sourceLeft, sourceTop, sourceRight, sourceBottom,
      )
      const preservesThinStructure = options.preserveThinStructures === true
        && coverage[index]! > 0
        && maskPeakSample(model.mask, sourceLeft, sourceTop, sourceRight, sourceBottom) >= 0.2
      activeMask[index] = coverage[index]! >= threshold || preservesThinStructure ? 1 : 0
    }
  }

  if (model.foregroundArea > 0 && activeMask.includes(1) === false) {
    let strongest = 0
    for (let index = 1; index < coverage.length; index += 1) {
      if (coverage[index]! > coverage[strongest]!) strongest = index
    }
    if (coverage[strongest]! > 0) activeMask[strongest] = 1
  }

  const topologyReference = projectTopologyReference({
    model,
    crop,
    fit,
    width,
    height,
    areaMask: activeMask,
  })
  const topologyReferenceMask = topologyReference.mask
  const referenceTopology = labelComponents(
    topologyReferenceMask,
    width,
    height,
    surroundingOffsets,
  )
  const referenceHoles = countHolesWithConnectivity(
    topologyReferenceMask,
    width,
    height,
    orthogonalOffsets,
  )
  const thinProjection = options.preserveThinStructures === true
    ? projectThinStructures(
      model,
      crop,
      fit,
      width,
      height,
      activeMask,
      topologyReferenceMask,
    )
    : {
      protectedCells: new Set<number>(),
      bridgeCells: new Set<number>(),
      bridgeEndpointCells: new Set<number>(),
      fragileBridgeCells: new Set<number>(),
      craftComponentsBeforeBridging: labelComponents(activeMask, width, height).components.length,
      craftComponentsAfterBridging: labelComponents(activeMask, width, height).components.length,
      rejectedOrthogonalLinks: 0,
      orthogonalBridgeReuseCount: 0,
      orthogonalBridgeSimplePointRejections: 0,
      orthogonalBridgeTopologyRejections: 0,
      orthogonalBridgeHoleRejections: 0,
      orthogonalBridgeOwnerRejections: 0,
      craftHolesBeforeBridging: 0,
      craftHolesAfterBridging: 0,
      edits: 0,
    }
  const projectedSdf = projectSignedDistance(model, crop, fit, width, height)
  const contourAnchors = new Set(
    tracedContourAnchors(model, crop, fit, width, height, activeMask),
  )
  const allocation = allocateLandmarks(
    landmarks,
    crop,
    fit,
    width,
    height,
    activeMask,
  )
  const structuralPaths = connectStructuralLandmarkPaths(
    model,
    landmarks,
    crop,
    fit,
    width,
    height,
    activeMask,
  )
  const protectedCells = new Set([
    ...thinProjection.protectedCells,
    ...(options.preserveThinStructures === true ? contourAnchors : []),
    ...allocation.protectedCells,
    ...structuralPaths.protectedCells,
  ])
  const trimProtectedCells = new Set([
    ...allocation.protectedCells,
    ...thinProjection.bridgeCells,
    ...thinProjection.bridgeEndpointCells,
  ])
  let shapeEdits = allocation.edits + thinProjection.edits + structuralPaths.edits
  const energy = optimizeBoundaryEnergy(
    activeMask,
    coverage,
    projectedSdf,
    width,
    height,
    referenceTopology.components.length,
    referenceHoles,
    protectedCells,
    contourAnchors,
    Math.max(0, Math.floor(options.refinementIterations ?? 2)),
  )
  shapeEdits += energy.edits
  const accessoryTrim = trimProfileAccessory(
    landmarks,
    crop,
    fit,
    width,
    height,
    activeMask,
    protectedCells,
    trimProtectedCells,
  )
  shapeEdits += accessoryTrim.edits
  for (const cell of accessoryTrim.removedCells) contourAnchors.delete(cell)

  const normalizedTopologyReference = topologyReferenceMask.slice()
  trimProfileAccessory(
    landmarks,
    crop,
    fit,
    width,
    height,
    normalizedTopologyReference,
    new Set<number>(),
    trimProtectedCells,
  )
  const topology = evaluateTopologyAgreement({
    referenceMask: { width, height, values: normalizedTopologyReference },
    candidateMask: { width, height, values: activeMask },
  })

  const target = labelComponents(activeMask, width, height)
  const finalCraftComponents = labelComponents(
    activeMask,
    width,
    height,
    orthogonalOffsets,
  ).components.length
  const retainedBridgeCells = [...thinProjection.bridgeCells]
    .filter((cell) => activeMask[cell] === 1)
  const retainedFragileBridgeCells = fragileOrthogonalCells(
    activeMask,
    width,
    height,
    retainedBridgeCells,
  )
  const boundaryBand = dilate(boundaryMask(activeMask, width, height), width, height)
  const occupied = activeMask.reduce((sum, value) => sum + value, 0)
  return {
    width,
    height,
    coverage,
    activeMask,
    signedDistance: projectedSdf,
    boundaryBand,
    boundaryAnchors: contourAnchors,
    protectedCells,
    landmarkAllocations: allocation.allocations,
    diagnostics: {
      referenceComponents: referenceTopology.components.length,
      targetComponents: target.components.length,
      referenceHoles,
      targetHoles: countHolesWithConnectivity(activeMask, width, height, orthogonalOffsets),
      boundaryIoU: sdfBoundaryIoU(activeMask, projectedSdf, width, height),
      coverageIoU: coverageIoU(coverage, activeMask),
      topologyCenterlinePrecision: topology.centerlinePrecision,
      topologyCenterlineRecall: topology.centerlineRecall,
      topologyClDice: topology.clDice,
      topologyWeightedCenterlinePrecision: topology.weightedCenterlinePrecision,
      topologyWeightedCenterlineRecall: topology.weightedCenterlineRecall,
      topologyWeightedClDice: topology.weightedClDice,
      topologyEndpointPrecision: topology.endpointPrecision,
      topologyEndpointRecall: topology.endpointRecall,
      topologyEndpointF1: topology.endpointF1,
      topologyJunctionPrecision: topology.junctionPrecision,
      topologyJunctionRecall: topology.junctionRecall,
      topologyJunctionF1: topology.junctionF1,
      topologyBranchCountAgreement: topology.branchCountAgreement,
      topologyCycleCountAgreement: topology.cycleCountAgreement,
      topologyComponentCountAgreement: topology.componentCountAgreement,
      topologyScore: scoreTopologyAgreement(topology),
      meanBoundaryDistance: sdfMeanBoundaryDistance(activeMask, projectedSdf, width, height),
      occupancyRatio: occupied / Math.max(1, fit.width * fit.height),
      orthogonalBridgeCells: retainedBridgeCells.length,
      fragileOrthogonalBridgeCells: retainedFragileBridgeCells.length,
      craftComponentsBeforeBridging: thinProjection.craftComponentsBeforeBridging,
      craftComponentsAfterBridging: finalCraftComponents,
      rejectedOrthogonalLinks: thinProjection.rejectedOrthogonalLinks,
      orthogonalBridgeReuseCount: thinProjection.orthogonalBridgeReuseCount,
      orthogonalBridgeSimplePointRejections: thinProjection.orthogonalBridgeSimplePointRejections,
      orthogonalBridgeTopologyRejections: thinProjection.orthogonalBridgeTopologyRejections,
      orthogonalBridgeHoleRejections: thinProjection.orthogonalBridgeHoleRejections,
      orthogonalBridgeOwnerRejections: thinProjection.orthogonalBridgeOwnerRejections,
      craftHolesBeforeBridging: thinProjection.craftHolesBeforeBridging,
      craftHolesAfterBridging: thinProjection.craftHolesAfterBridging,
      shapeEdits,
      energyBefore: energy.before,
      energyAfter: energy.after,
    },
  }
}
