import {
  gridCellForSourcePoint,
  type CanvasFit,
} from './image.js'
import {
  landmarkEffectiveConfidence,
  landmarkGridRadiusCells,
} from './landmarks.js'
import type {
  BinaryMask,
  CropRect,
  ImageLandmark,
  LandmarkKind,
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
  sourceComponents: number
  targetComponents: number
  sourceHoles: number
  targetHoles: number
  boundaryIoU: number
  coverageIoU: number
  meanBoundaryDistance: number
  occupancyRatio: number
  shapeEdits: number
}

export interface ShapeRasterization {
  width: number
  height: number
  coverage: Float32Array
  activeMask: Uint8Array
  signedDistance: Float32Array
  boundaryBand: Uint8Array
  protectedCells: ReadonlySet<number>
  landmarkAllocations: readonly LandmarkAllocation[]
  diagnostics: ShapeDiagnostics
}

export interface ShapeRasterizationOptions {
  threshold?: number
  refinementIterations?: number
}

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
      for (const [offsetX, offsetY] of orthogonalOffsets) {
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
      for (const [offsetX, offsetY] of surroundingOffsets) {
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

function signedDistanceField(values: Uint8Array, width: number, height: number): Float32Array {
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
  const binaryMask = Uint8Array.from(mask.values, (value) => value >= 0.5 ? 1 : 0)
  const labeled = labelComponents(binaryMask, mask.width, mask.height)
  const foregroundArea = binaryMask.reduce((sum, value) => sum + value, 0)
  const modelConfidence = clamp(confidence, 0, 1)
  return {
    width: mask.width,
    height: mask.height,
    mask,
    binaryMask,
    signedDistance: signedDistanceField(binaryMask, mask.width, mask.height),
    contours: traceContours(labeled, mask.width, mask.height),
    components: labeled.components,
    holes: countHoles(binaryMask, mask.width, mask.height),
    anchors: landmarks.map((landmark) => ({
      landmarkId: landmark.id,
      kind: landmark.kind,
      source: [landmark.x, landmark.y],
      minimumCells: anchorMinimumCells(landmark),
      hard: landmark.priority === 'hard',
      confidence: landmarkEffectiveConfidence(landmark, modelConfidence),
    })),
    foregroundArea,
    confidence: modelConfidence,
  }
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

function boundaryIoU(
  first: Uint8Array,
  second: Uint8Array,
  width: number,
  height: number,
): number {
  const firstBand = dilate(boundaryMask(first, width, height), width, height)
  const secondBand = dilate(boundaryMask(second, width, height), width, height)
  let intersection = 0
  let union = 0
  for (let index = 0; index < first.length; index += 1) {
    if (firstBand[index] === 1 && secondBand[index] === 1) intersection += 1
    if (firstBand[index] === 1 || secondBand[index] === 1) union += 1
  }
  return union === 0 ? 1 : intersection / union
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

function boundaryCoordinates(values: Uint8Array, width: number, height: number): readonly ShapePoint[] {
  const boundary = boundaryMask(values, width, height)
  const points: ShapePoint[] = []
  for (let index = 0; index < boundary.length; index += 1) {
    if (boundary[index] === 1) points.push({ x: index % width, y: Math.floor(index / width) })
  }
  return points
}

function directedBoundaryDistance(first: readonly ShapePoint[], second: readonly ShapePoint[]): number {
  if (first.length === 0 || second.length === 0) return first.length === second.length ? 0 : 1
  let total = 0
  for (const point of first) {
    let nearest = Number.POSITIVE_INFINITY
    for (const candidate of second) {
      nearest = Math.min(nearest, Math.hypot(point.x - candidate.x, point.y - candidate.y))
    }
    total += nearest
  }
  return total / first.length
}

function meanBoundaryDistance(
  first: Uint8Array,
  second: Uint8Array,
  width: number,
  height: number,
): number {
  const firstBoundary = boundaryCoordinates(first, width, height)
  const secondBoundary = boundaryCoordinates(second, width, height)
  const distance = (directedBoundaryDistance(firstBoundary, secondBoundary)
    + directedBoundaryDistance(secondBoundary, firstBoundary)) / 2
  return clamp(distance / Math.max(1, Math.hypot(width, height)), 0, 1)
}

function resolveDiagonalConnectivity(
  activeMask: Uint8Array,
  coverage: Float32Array,
  width: number,
  height: number,
  sourceComponents: number,
  protectedCells: ReadonlySet<number>,
): number {
  if (sourceComponents !== 1) return 0
  let edits = 0
  for (let y = 0; y + 1 < height; y += 1) {
    for (let x = 0; x + 1 < width; x += 1) {
      const topLeft = y * width + x
      const topRight = topLeft + 1
      const bottomLeft = topLeft + width
      const bottomRight = bottomLeft + 1
      const firstDiagonal = activeMask[topLeft] === 1 && activeMask[bottomRight] === 1
        && activeMask[topRight] === 0 && activeMask[bottomLeft] === 0
      const secondDiagonal = activeMask[topRight] === 1 && activeMask[bottomLeft] === 1
        && activeMask[topLeft] === 0 && activeMask[bottomRight] === 0
      if (firstDiagonal === false && secondDiagonal === false) continue
      const candidates = firstDiagonal ? [topRight, bottomLeft] : [topLeft, bottomRight]
      const selected = candidates.reduce((best, candidate) =>
        (coverage[candidate] ?? 0) > (coverage[best] ?? 0) ? candidate : best)
      activeMask[selected] = 1
      if (protectedCells.has(selected) === false) edits += 1
    }
  }
  return edits
}

function refineBoundary(
  activeMask: Uint8Array,
  coverage: Float32Array,
  width: number,
  height: number,
  sourceHoles: number,
  protectedCells: ReadonlySet<number>,
  iterations: number,
): number {
  let edits = 0
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const snapshot = activeMask.slice()
    let iterationEdits = 0
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x
        if (protectedCells.has(index)) continue
        let orthogonal = 0
        for (const [offsetX, offsetY] of orthogonalOffsets) {
          const nextX = x + offsetX
          const nextY = y + offsetY
          if (nextX >= 0 && nextY >= 0 && nextX < width && nextY < height
            && snapshot[nextY * width + nextX] === 1) orthogonal += 1
        }
        if (snapshot[index] === 1 && orthogonal === 0 && (coverage[index] ?? 0) < 0.75) {
          activeMask[index] = 0
          iterationEdits += 1
        } else if (snapshot[index] === 0 && sourceHoles === 0 && orthogonal === 4
          && (coverage[index] ?? 0) >= 0.15) {
          activeMask[index] = 1
          iterationEdits += 1
        }
      }
    }
    edits += iterationEdits
    if (iterationEdits === 0) break
  }
  return edits
}

function allocateLandmarks(
  landmarks: readonly ImageLandmark[],
  analysisConfidence: number,
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
    const confidence = landmarkEffectiveConfidence(landmark, analysisConfidence)
    if (landmark.priority !== 'hard' || confidence < 0.5) continue
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

export function rasterizeSourceShape(
  model: SourceShapeModel,
  crop: CropRect,
  fit: CanvasFit,
  width: number,
  height: number,
  landmarks: readonly ImageLandmark[],
  options: ShapeRasterizationOptions = {},
): ShapeRasterization {
  const threshold = clamp(options.threshold ?? 0.5, 0, 1)
  const coverage = new Float32Array(width * height)
  const activeMask = new Uint8Array(width * height)
  const scaleX = crop.width / fit.width
  const scaleY = crop.height / fit.height
  for (let y = fit.y; y < fit.y + fit.height; y += 1) {
    for (let x = fit.x; x < fit.x + fit.width; x += 1) {
      const localX = x - fit.x
      const localY = y - fit.y
      const sourceLeft = crop.x + localX * scaleX
      const sourceTop = crop.y + localY * scaleY
      const sourceRight = crop.x + (localX + 1) * scaleX
      const sourceBottom = crop.y + (localY + 1) * scaleY
      const index = y * width + x
      coverage[index] = maskAreaSample(model.mask, sourceLeft, sourceTop, sourceRight, sourceBottom)
      activeMask[index] = coverage[index]! >= threshold ? 1 : 0
    }
  }

  if (model.foregroundArea > 0 && activeMask.includes(1) === false) {
    let strongest = 0
    for (let index = 1; index < coverage.length; index += 1) {
      if (coverage[index]! > coverage[strongest]!) strongest = index
    }
    if (coverage[strongest]! > 0) activeMask[strongest] = 1
  }

  const referenceMask = activeMask.slice()
  const referenceTopology = labelComponents(referenceMask, width, height)
  const referenceHoles = countHoles(referenceMask, width, height)
  const allocation = allocateLandmarks(
    landmarks,
    model.confidence,
    crop,
    fit,
    width,
    height,
    activeMask,
  )
  let shapeEdits = allocation.edits
  shapeEdits += resolveDiagonalConnectivity(
    activeMask,
    coverage,
    width,
    height,
    referenceTopology.components.length,
    allocation.protectedCells,
  )
  shapeEdits += refineBoundary(
    activeMask,
    coverage,
    width,
    height,
    referenceHoles,
    allocation.protectedCells,
    Math.max(0, Math.floor(options.refinementIterations ?? 2)),
  )

  const target = labelComponents(activeMask, width, height)
  const boundaryBand = dilate(boundaryMask(activeMask, width, height), width, height)
  const occupied = activeMask.reduce((sum, value) => sum + value, 0)
  return {
    width,
    height,
    coverage,
    activeMask,
    signedDistance: signedDistanceField(referenceMask, width, height),
    boundaryBand,
    protectedCells: allocation.protectedCells,
    landmarkAllocations: allocation.allocations,
    diagnostics: {
      sourceComponents: referenceTopology.components.length,
      targetComponents: target.components.length,
      sourceHoles: referenceHoles,
      targetHoles: countHoles(activeMask, width, height),
      boundaryIoU: boundaryIoU(activeMask, referenceMask, width, height),
      coverageIoU: coverageIoU(coverage, activeMask),
      meanBoundaryDistance: meanBoundaryDistance(activeMask, referenceMask, width, height),
      occupancyRatio: occupied / Math.max(1, fit.width * fit.height),
      shapeEdits,
    },
  }
}
