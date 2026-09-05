import { gridCellForSourcePoint, type CanvasFit } from './image.js'
import { landmarkEvidenceReliability, landmarkObservationState } from './landmarks.js'
import { petSkeletonEdges } from './pet-structure.js'
import type { CropRect, ImageAnalysis, SemanticRegion, StructuralRole } from './types.js'

export interface PetPoseEvaluation {
  mode: 'none' | 'frontal' | 'oblique' | 'profile'
  available: boolean
  score: number
  confidence: number
  landmarkCoverage: number
  skeletonContinuity: number
  torsoAxisAgreement: number
  boneRatio: number
  groundContact: number
  negativeSpace: number
  tailPathQuality: number
  boundaryRhythm: number
  frontVerticalRunRatio: number
  frontChestScore: number
  earStructure: number
  earSpanCells: number
  earConnected: boolean
  muzzleStructure: number
  muzzleSeparationCells: number
  /** Count inferred from instance-prefixed semantic regions and landmarks. */
  instanceCount: number
  /** Mean per-instance source retention multiplied by projected grid occupancy. */
  subjectComponentRecall: number
  /** Lowest final-grid landmark coverage among detected instances. */
  weakestInstanceIdentityCompleteness: number
  /** Share of occupied keypoint cells claimed by more than one instance. */
  crossInstanceCollisionRate: number
}

export type PetInstanceIntegrityRejectionReason =
  | 'pet-instance-recall'
  | 'pet-instance-identity'
  | 'pet-instance-collision'

export interface PetInstanceIntegrityAssessment {
  applies: boolean
  valid: boolean
  subjectRecallValid: boolean
  weakestIdentityValid: boolean
  collisionValid: boolean
  rejectionReasons: readonly PetInstanceIntegrityRejectionReason[]
}

export const petInstanceIntegrityPolicy = Object.freeze({
  minimumSubjectComponentRecall: 0.88,
  minimumWeakestIdentityCompleteness: 0.35,
  maximumCrossInstanceCollisionRate: 0.12,
})

export const petPoseSchema = Object.freeze({
  id: 'pet-instance-structure-v2',
  upstreamContracts: Object.freeze([
    'facebookresearch/detectron2@a2f4a8771ab77e8411c26b27f24f9489a28a2453',
    'open-mmlab/mmpose@v1.3.2#5408bc76f5b848cf925a0d1857899011d8c5b497',
    'AlexTheBad/AP-10K@181b1a04755e4dc6fe5616ef7a88496f47bfe228',
  ]),
  projectHeuristics: Object.freeze([
    'mean-source-retention-times-grid-occupancy',
    'weakest-instance-landmark-coverage',
    'shared-grid-cell-owner-rate',
  ]),
  multiInstanceThresholds: petInstanceIntegrityPolicy,
  licenses: Object.freeze({
    detectron2: 'Apache-2.0',
    mmpose: 'Apache-2.0',
    ap10k: 'CC-BY-4.0',
  }),
})

type PetPoseCoreEvaluation = Omit<
  PetPoseEvaluation,
  | 'instanceCount'
  | 'subjectComponentRecall'
  | 'weakestInstanceIdentityCompleteness'
  | 'crossInstanceCollisionRate'
>

interface GridPoint {
  x: number
  y: number
}

interface ProjectedLandmark extends GridPoint {
  role: StructuralRole
  confidence: number
}

interface FaceFrame {
  centerX: number
  centerY: number
  axisX: number
  axisY: number
  eyeSpan: number
}

type FacePoseMode = 'frontal' | 'oblique' | 'profile'

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function plateauScore(
  value: number,
  minimum: number,
  maximum: number,
  lowerFade: number,
  upperFade: number,
): number {
  if (value < minimum) return lowerFade <= 0 ? 0 : clamp(1 - (minimum - value) / lowerFade)
  if (value > maximum) return upperFade <= 0 ? 0 : clamp(1 - (value - maximum) / upperFade)
  return 1
}

export function assessPetInstanceIntegrity(
  evaluation: PetPoseEvaluation,
): PetInstanceIntegrityAssessment {
  const applies = evaluation.instanceCount > 1
  const subjectRecallValid = applies === false
    || evaluation.subjectComponentRecall >= petInstanceIntegrityPolicy.minimumSubjectComponentRecall
  const weakestIdentityValid = applies === false
    || evaluation.weakestInstanceIdentityCompleteness
      >= petInstanceIntegrityPolicy.minimumWeakestIdentityCompleteness
  const collisionValid = applies === false
    || evaluation.crossInstanceCollisionRate
      <= petInstanceIntegrityPolicy.maximumCrossInstanceCollisionRate
  const rejectionReasons: PetInstanceIntegrityRejectionReason[] = []
  if (subjectRecallValid === false) rejectionReasons.push('pet-instance-recall')
  if (weakestIdentityValid === false) rejectionReasons.push('pet-instance-identity')
  if (collisionValid === false) rejectionReasons.push('pet-instance-collision')
  return {
    applies,
    valid: rejectionReasons.length === 0,
    subjectRecallValid,
    weakestIdentityValid,
    collisionValid,
    rejectionReasons,
  }
}

function emptyPetPoseEvaluation(): PetPoseCoreEvaluation {
  return {
    mode: 'none',
    available: false,
    score: 0,
    confidence: 0,
    landmarkCoverage: 0,
    skeletonContinuity: 0,
    torsoAxisAgreement: 0,
    boneRatio: 0,
    groundContact: 0,
    negativeSpace: 0,
    tailPathQuality: 0,
    boundaryRhythm: 0,
    frontVerticalRunRatio: 0,
    frontChestScore: 0,
    earStructure: 0,
    earSpanCells: 0,
    earConnected: false,
    muzzleStructure: 0,
    muzzleSeparationCells: 0,
  }
}

function lineCells(start: GridPoint, end: GridPoint): readonly GridPoint[] {
  const cells: GridPoint[] = []
  let x = start.x
  let y = start.y
  const deltaX = Math.abs(end.x - start.x)
  const deltaY = Math.abs(end.y - start.y)
  const stepX = start.x < end.x ? 1 : -1
  const stepY = start.y < end.y ? 1 : -1
  let error = deltaX - deltaY
  while (true) {
    cells.push({ x, y })
    if (x === end.x && y === end.y) break
    const doubled = error * 2
    if (doubled > -deltaY) {
      error -= deltaY
      x += stepX
    }
    if (doubled < deltaX) {
      error += deltaX
      y += stepY
    }
  }
  return cells
}

function occupiedWithin(
  activeMask: Uint8Array,
  width: number,
  height: number,
  point: GridPoint,
  radius: number,
): boolean {
  for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      const x = point.x + offsetX
      const y = point.y + offsetY
      if (x < 0 || y < 0 || x >= width || y >= height) continue
      if (activeMask[y * width + x] === 1) return true
    }
  }
  return false
}

function nearestOccupied(
  activeMask: Uint8Array,
  width: number,
  height: number,
  point: GridPoint,
  maximumRadius: number,
): GridPoint | undefined {
  let best: { point: GridPoint, distance: number } | undefined
  for (let offsetY = -maximumRadius; offsetY <= maximumRadius; offsetY += 1) {
    for (let offsetX = -maximumRadius; offsetX <= maximumRadius; offsetX += 1) {
      const x = point.x + offsetX
      const y = point.y + offsetY
      if (x < 0 || y < 0 || x >= width || y >= height || activeMask[y * width + x] !== 1) continue
      const distance = Math.hypot(offsetX, offsetY)
      if (best === undefined || distance < best.distance) best = { point: { x, y }, distance }
    }
  }
  return best?.point
}

function edgeCoverage(
  activeMask: Uint8Array,
  width: number,
  height: number,
  start: GridPoint,
  end: GridPoint,
): number {
  const cells = lineCells(start, end)
  return mean(cells.map((cell) => Number(occupiedWithin(activeMask, width, height, cell, 1))))
}

function angleAgreement(
  expectedStart: GridPoint,
  expectedEnd: GridPoint,
  actualStart: GridPoint,
  actualEnd: GridPoint,
): number {
  const expectedX = expectedEnd.x - expectedStart.x
  const expectedY = expectedEnd.y - expectedStart.y
  const actualX = actualEnd.x - actualStart.x
  const actualY = actualEnd.y - actualStart.y
  const expectedLength = Math.hypot(expectedX, expectedY)
  const actualLength = Math.hypot(actualX, actualY)
  if (expectedLength < 1 || actualLength < 1) return 0
  const cosine = (expectedX * actualX + expectedY * actualY) / (expectedLength * actualLength)
  return clamp((cosine + 1) / 2)
}

function ratioAgreement(expected: number, actual: number): number {
  if (expected <= 0 || actual <= 0) return 0
  return Math.exp(-Math.abs(Math.log(actual / expected)) / 0.25)
}

function negativeSpaceScore(
  activeMask: Uint8Array,
  width: number,
  height: number,
  landmarks: ReadonlyMap<StructuralRole, ProjectedLandmark>,
): number {
  const frontKnee = landmarks.get('front-knee')
  const rearKnee = landmarks.get('rear-knee')
  const frontPaw = landmarks.get('front-paw')
  const rearPaw = landmarks.get('rear-paw')
  if (frontKnee === undefined || rearKnee === undefined || frontPaw === undefined || rearPaw === undefined) return 0
  const left = Math.min(frontPaw.x, rearPaw.x) + 1
  const right = Math.max(frontPaw.x, rearPaw.x) - 1
  const top = Math.min(frontKnee.y, rearKnee.y) + 1
  const bottom = Math.max(frontPaw.y, rearPaw.y) - 1
  if (right < left || bottom < top) return 0
  let cells = 0
  let empty = 0
  for (let y = Math.max(0, top); y <= Math.min(height - 1, bottom); y += 1) {
    for (let x = Math.max(0, left); x <= Math.min(width - 1, right); x += 1) {
      cells += 1
      if (activeMask[y * width + x] !== 1) empty += 1
    }
  }
  return cells === 0 ? 0 : empty / cells
}

function longestNearVerticalRunRatio(values: readonly number[], tolerance: number): number {
  if (values.length === 0) return 1
  let longest = 1
  for (let start = 0; start < values.length; start += 1) {
    let minimum = values[start]!
    let maximum = values[start]!
    for (let end = start + 1; end < values.length; end += 1) {
      minimum = Math.min(minimum, values[end]!)
      maximum = Math.max(maximum, values[end]!)
      if (maximum - minimum > tolerance) break
      longest = Math.max(longest, end - start + 1)
    }
  }
  return longest / values.length
}

function forwardBoundaryRhythm(
  activeMask: Uint8Array,
  width: number,
  height: number,
  shoulder: GridPoint,
  frontPaw: GridPoint,
  direction: -1 | 1,
): { score: number; verticalRunRatio: number } {
  const values: number[] = []
  const widths: number[] = []
  for (let y = Math.max(0, shoulder.y); y <= Math.min(height - 1, frontPaw.y); y += 1) {
    let boundary: number | undefined
    for (let x = 0; x < width; x += 1) {
      if (activeMask[y * width + x] !== 1) continue
      boundary = boundary === undefined
        ? x
        : direction === 1 ? Math.max(boundary, x) : Math.min(boundary, x)
    }
    if (boundary !== undefined) {
      let runWidth = 1
      for (let x = boundary - direction; x >= 0 && x < width; x -= direction) {
        if (activeMask[y * width + x] !== 1) break
        runWidth += 1
      }
      values.push(boundary)
      widths.push(runWidth)
    }
  }
  if (values.length < 2) return { score: 0, verticalRunRatio: 1 }
  const verticalRunRatio = longestNearVerticalRunRatio(values, 1)
  const runScore = 1 - verticalRunRatio
  const rangeScore = clamp((Math.max(...values) - Math.min(...values) - 1) / 2)
  const split = Math.max(1, Math.floor(widths.length * 0.45))
  const upperWidth = mean(widths.slice(0, split))
  const lowerWidth = mean(widths.slice(split))
  const narrowingScore = clamp((upperWidth - lowerWidth) / Math.max(2, upperWidth * 0.6))
  return {
    score: clamp(runScore * 0.45 + rangeScore * 0.15 + narrowingScore * 0.4),
    verticalRunRatio,
  }
}

function occupiedGeodesicLength(
  activeMask: Uint8Array,
  width: number,
  height: number,
  start: GridPoint,
  end: GridPoint,
  corridorRadius: number,
): number | undefined {
  const startCell = start.y * width + start.x
  const endCell = end.y * width + end.x
  if (activeMask[startCell] !== 1 || activeMask[endCell] !== 1) return undefined
  const left = Math.max(0, Math.min(start.x, end.x) - corridorRadius)
  const right = Math.min(width - 1, Math.max(start.x, end.x) + corridorRadius)
  const top = Math.max(0, Math.min(start.y, end.y) - corridorRadius)
  const bottom = Math.min(height - 1, Math.max(start.y, end.y) + corridorRadius)
  const distance = new Int32Array(activeMask.length)
  distance.fill(-1)
  const queue = new Int32Array(activeMask.length)
  let head = 0
  let tail = 0
  queue[tail++] = startCell
  distance[startCell] = 1
  while (head < tail) {
    const cell = queue[head++]!
    if (cell === endCell) return distance[cell]
    const x = cell % width
    const y = Math.floor(cell / width)
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (offsetX === 0 && offsetY === 0) continue
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX < left || nextY < top || nextX > right || nextY > bottom) continue
        const next = nextY * width + nextX
        if (activeMask[next] !== 1 || distance[next]! >= 0) continue
        distance[next] = distance[cell]! + 1
        queue[tail++] = next
      }
    }
  }
  return undefined
}

function pathStructureScore(
  activeMask: Uint8Array,
  width: number,
  height: number,
  start: GridPoint,
  end: GridPoint,
  minimumCells: number,
  corridorRadius = 2,
): number {
  const cells = lineCells(start, end)
  const coverage = mean(cells.map((cell) => Number(
    occupiedWithin(activeMask, width, height, cell, 0),
  )))
  const endpoints = mean([start, end].map((point) => Number(
    occupiedWithin(activeMask, width, height, point, 0),
  )))
  const geodesicLength = occupiedGeodesicLength(
    activeMask,
    width,
    height,
    start,
    end,
    corridorRadius,
  )
  const span = clamp((geodesicLength ?? cells.length) / minimumCells)
  if (geodesicLength === undefined) {
    return clamp(coverage * 0.35 + endpoints * 0.25 + span * 0.1)
  }
  return clamp(0.6 + span * 0.15 + endpoints * 0.15 + coverage * 0.1)
}

function boundaryExposure(
  activeMask: Uint8Array,
  width: number,
  height: number,
  point: GridPoint,
): number {
  let exposed = 0
  let samples = 0
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      if (offsetX === 0 && offsetY === 0) continue
      samples += 1
      const x = point.x + offsetX
      const y = point.y + offsetY
      if (x < 0 || y < 0 || x >= width || y >= height
        || activeMask[y * width + x] !== 1) exposed += 1
    }
  }
  return samples === 0 ? 0 : exposed / samples
}

function localOccupancy(
  activeMask: Uint8Array,
  width: number,
  height: number,
  point: GridPoint,
  radius: number,
): number {
  let occupied = 0
  let samples = 0
  for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      const x = point.x + offsetX
      const y = point.y + offsetY
      if (x < 0 || y < 0 || x >= width || y >= height) continue
      samples += 1
      if (activeMask[y * width + x] === 1) occupied += 1
    }
  }
  return samples === 0 ? 0 : occupied / samples
}

function singleEarStructureScore(
  activeMask: Uint8Array,
  width: number,
  height: number,
  tip: ProjectedLandmark,
  root: ProjectedLandmark,
): { score: number; spanCells: number; connected: boolean } {
  const pathTip = nearestOccupied(activeMask, width, height, tip, 1) ?? tip
  const pathRoot = nearestOccupied(activeMask, width, height, root, 1) ?? root
  const corridorRadius = Math.max(
    2,
    Math.ceil(Math.hypot(pathTip.x - pathRoot.x, pathTip.y - pathRoot.y) * 0.45),
  )
  const geodesicLength = occupiedGeodesicLength(
    activeMask,
    width,
    height,
    pathTip,
    pathRoot,
    corridorRadius,
  )
  const connected = geodesicLength !== undefined
  const pathScore = pathStructureScore(
    activeMask,
    width,
    height,
    pathTip,
    pathRoot,
    3,
    corridorRadius,
  )
  const tipExposure = boundaryExposure(activeMask, width, height, pathTip)
  const pathExposure = mean(lineCells(pathTip, pathRoot).map((point) =>
    boundaryExposure(activeMask, width, height, point)))
  const taper = clamp(
    (localOccupancy(activeMask, width, height, pathRoot, 1)
      - localOccupancy(activeMask, width, height, pathTip, 1)) / 0.5,
  )
  const score = connected
    ? clamp(pathScore * 0.4 + tipExposure * 0.25 + pathExposure * 0.25 + taper * 0.1)
    : clamp(pathScore * 0.4 + tipExposure * 0.1)
  return {
    score,
    spanCells: geodesicLength ?? 0,
    connected: connected && score >= 0.6,
  }
}

function earStructureScore(
  activeMask: Uint8Array,
  width: number,
  height: number,
  landmarks: ReadonlyMap<StructuralRole, ProjectedLandmark>,
): { score: number; observed: boolean; spanCells: number; connected: boolean } {
  const tip = landmarks.get('ear-tip')
  const root = landmarks.get('ear-root')
  if (tip === undefined || root === undefined) {
    return { score: 0, observed: false, spanCells: 0, connected: false }
  }
  const result = singleEarStructureScore(activeMask, width, height, tip, root)
  return {
    score: result.score,
    observed: true,
    spanCells: result.spanCells,
    connected: result.connected,
  }
}

function muzzleStructureScore(
  activeMask: Uint8Array,
  width: number,
  height: number,
  landmarks: ReadonlyMap<StructuralRole, ProjectedLandmark>,
): { score: number; observed: boolean; separationCells: number } {
  const nose = landmarks.get('nose-tip')
  const upperJaw = landmarks.get('upper-jaw')
  const lowerJaw = landmarks.get('lower-jaw')
  if (nose === undefined || upperJaw === undefined || lowerJaw === undefined) {
    return { score: 0, observed: false, separationCells: 0 }
  }
  const upperPath = pathStructureScore(activeMask, width, height, nose, upperJaw, 2)
  const lowerPath = pathStructureScore(activeMask, width, height, nose, lowerJaw, 2)
  const jawEndpointsPresent = occupiedWithin(activeMask, width, height, upperJaw, 0)
    && occupiedWithin(activeMask, width, height, lowerJaw, 0)
  const separationCells = jawEndpointsPresent
    ? Math.max(Math.abs(lowerJaw.x - upperJaw.x), Math.abs(lowerJaw.y - upperJaw.y))
    : 0
  const thicknessScore = clamp(separationCells / 2)
  const endpointCoverage = mean([nose, upperJaw, lowerJaw].map((point) => Number(
    occupiedWithin(activeMask, width, height, point, 0),
  )))
  const maximumRetreat = Math.max(
    Math.abs(nose.x - upperJaw.x),
    Math.abs(nose.x - lowerJaw.x),
  )
  const noseCapScore = clamp(1 - Math.max(0, maximumRetreat - 2) / 3)
  const jawPathFloor = Math.min(upperPath, lowerPath)
  const featureExposure = mean([nose, upperJaw, lowerJaw].map((point) =>
    boundaryExposure(activeMask, width, height, point)))
  const baseScore = clamp(
    jawPathFloor * 0.45
      + mean([upperPath, lowerPath]) * 0.1
      + endpointCoverage * 0.25
      + thicknessScore * 0.12
      + noseCapScore * 0.08,
  )
  return {
    score: clamp(
      (baseScore * 0.55 + featureExposure * 0.45)
        * (jawEndpointsPresent ? 1 : 0.65),
    ),
    observed: true,
    separationCells,
  }
}

function tailCrossSectionWidth(
  activeMask: Uint8Array,
  width: number,
  height: number,
  start: GridPoint,
  end: GridPoint,
  amount: number,
): number {
  const axisX = end.x - start.x
  const axisY = end.y - start.y
  const span = Math.hypot(axisX, axisY)
  if (span < 1) return 0
  const centerX = start.x + axisX * amount
  const centerY = start.y + axisY * amount
  const radius = Math.max(2, Math.min(8, Math.ceil(span * 0.18)))
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  for (let y = Math.max(0, Math.floor(centerY - radius)); y <= Math.min(height - 1, Math.ceil(centerY + radius)); y += 1) {
    for (let x = Math.max(0, Math.floor(centerX - radius)); x <= Math.min(width - 1, Math.ceil(centerX + radius)); x += 1) {
      if (activeMask[y * width + x] !== 1) continue
      const deltaX = x - centerX
      const deltaY = y - centerY
      const along = (deltaX * axisX + deltaY * axisY) / span
      if (Math.abs(along) > 0.8) continue
      const across = (-deltaX * axisY + deltaY * axisX) / span
      minimum = Math.min(minimum, across)
      maximum = Math.max(maximum, across)
    }
  }
  return Number.isFinite(minimum) && Number.isFinite(maximum)
    ? Math.max(1, maximum - minimum + 1)
    : 0
}

function tailStructureScore(
  activeMask: Uint8Array,
  width: number,
  height: number,
  start: GridPoint,
  end: GridPoint,
): number {
  const pathScore = pathStructureScore(activeMask, width, height, start, end, 3, 2)
  const widths = [0.12, 0.32, 0.52, 0.72, 0.9]
    .map((amount) => tailCrossSectionWidth(activeMask, width, height, start, end, amount))
  const rootWidth = mean(widths.slice(0, 2))
  const tipWidth = mean(widths.slice(-2))
  const orderedSteps = mean(widths.slice(0, -1).map((value, index) =>
    Number(value + 0.35 >= widths[index + 1]!)))
  const widthDrop = clamp((rootWidth - tipWidth) / Math.max(1, rootWidth * 0.65))
  const compactTip = clamp(1 - Math.max(0, tipWidth - 1) / Math.max(1.5, rootWidth))
  const taperScore = clamp(widthDrop * 0.55 + orderedSteps * 0.25 + compactTip * 0.2)
  const tipExposure = boundaryExposure(activeMask, width, height, end)
  return clamp(pathScore * 0.55 + taperScore * 0.35 + tipExposure * 0.1)
}

function projectedLandmarks(
  analysis: ImageAnalysis,
  crop: CropRect,
  fit: CanvasFit,
): ReadonlyMap<StructuralRole, ProjectedLandmark> {
  const groups = projectedLandmarkGroups(analysis, crop, fit)
  const result = new Map<StructuralRole, ProjectedLandmark>()
  for (const [role, landmarks] of groups) {
    const strongest = [...landmarks].sort((first, second) => second.confidence - first.confidence)[0]
    if (strongest !== undefined) result.set(role, strongest)
  }
  return result
}

function projectedLandmarkGroups(
  analysis: ImageAnalysis,
  crop: CropRect,
  fit: CanvasFit,
): ReadonlyMap<StructuralRole, readonly ProjectedLandmark[]> {
  const groups = new Map<StructuralRole, ProjectedLandmark[]>()
  for (const landmark of analysis.landmarks ?? []) {
    if (landmark.structuralRole === undefined
      || landmarkObservationState(landmark) === 'missing'
      || landmark.confidence <= 0) continue
    const [x, y] = gridCellForSourcePoint(crop, fit, landmark.x, landmark.y)
    const confidence = landmarkEvidenceReliability(landmark)
    const group = groups.get(landmark.structuralRole) ?? []
    group.push({ role: landmark.structuralRole, x, y, confidence })
    groups.set(landmark.structuralRole, group)
  }
  return groups
}

function faceFrame(leftEye: GridPoint, rightEye: GridPoint): FaceFrame {
  const deltaX = rightEye.x - leftEye.x
  const deltaY = rightEye.y - leftEye.y
  const eyeSpan = Math.max(1, Math.hypot(deltaX, deltaY))
  return {
    centerX: (leftEye.x + rightEye.x) / 2,
    centerY: (leftEye.y + rightEye.y) / 2,
    axisX: deltaX / eyeSpan,
    axisY: deltaY / eyeSpan,
    eyeSpan,
  }
}

function faceLocalPoint(frame: FaceFrame, point: GridPoint): GridPoint {
  const deltaX = point.x - frame.centerX
  const deltaY = point.y - frame.centerY
  return {
    x: deltaX * frame.axisX + deltaY * frame.axisY,
    y: -deltaX * frame.axisY + deltaY * frame.axisX,
  }
}

function faceGridPoint(frame: FaceFrame, point: GridPoint): GridPoint {
  return {
    x: Math.round(frame.centerX + point.x * frame.axisX - point.y * frame.axisY),
    y: Math.round(frame.centerY + point.x * frame.axisY + point.y * frame.axisX),
  }
}

function classifyFacePose(
  frame: FaceFrame,
  leftEye: GridPoint,
  rightEye: GridPoint,
  nose: GridPoint,
): FacePoseMode {
  const localNose = faceLocalPoint(frame, nose)
  const noseOffset = Math.abs(localNose.x) / frame.eyeSpan
  const leftDistance = Math.hypot(nose.x - leftEye.x, nose.y - leftEye.y)
  const rightDistance = Math.hypot(nose.x - rightEye.x, nose.y - rightEye.y)
  const eyeNoseImbalance = Math.abs(leftDistance - rightDistance)
    / Math.max(1e-6, leftDistance + rightDistance)
  if (noseOffset <= 0.25 && eyeNoseImbalance <= 0.2) return 'frontal'
  if (noseOffset <= 0.55) return 'oblique'
  return 'profile'
}

function frontalSilhouetteSymmetry(
  activeMask: Uint8Array,
  width: number,
  height: number,
  frame: FaceFrame,
  left: number,
  right: number,
  top: number,
  bottom: number,
): number {
  let matches = 0
  let samples = 0
  const radius = Math.max(1, Math.floor(Math.min(Math.abs(left), right)))
  const comparisonRadius = frame.eyeSpan >= 8 ? 2 : 1
  for (let y = Math.ceil(top); y <= Math.floor(bottom); y += 1) {
    for (let offset = 0; offset <= radius; offset += 1) {
      const leftPoint = faceGridPoint(frame, { x: -offset, y })
      const rightPoint = faceGridPoint(frame, { x: offset, y })
      if (leftPoint.x < 0 || leftPoint.y < 0 || leftPoint.x >= width || leftPoint.y >= height
        || rightPoint.x < 0 || rightPoint.y < 0 || rightPoint.x >= width || rightPoint.y >= height) continue
      samples += 1
      const leftOccupancy = localOccupancy(activeMask, width, height, leftPoint, comparisonRadius)
      const rightOccupancy = localOccupancy(activeMask, width, height, rightPoint, comparisonRadius)
      matches += 1 - Math.abs(leftOccupancy - rightOccupancy)
    }
  }
  return samples === 0 ? 0 : matches / samples
}

function frontalFaceEvaluation(
  analysis: ImageAnalysis,
  crop: CropRect,
  fit: CanvasFit,
  activeMask: Uint8Array,
  width: number,
  height: number,
): PetPoseCoreEvaluation | undefined {
  const groups = projectedLandmarkGroups(analysis, crop, fit)
  const eyes = [...(groups.get('eye-center') ?? [])].sort((first, second) => first.x - second.x)
  const nose = [...(groups.get('nose-tip') ?? [])]
    .sort((first, second) => second.confidence - first.confidence)[0]
  if ((groups.get('ear-tip')?.length ?? 0) < 2 || (groups.get('ear-root')?.length ?? 0) < 2
    || eyes.length < 2 || nose === undefined) return undefined

  const leftEye = eyes[0]!
  const rightEye = eyes.at(-1)!
  const frame = faceFrame(leftEye, rightEye)
  const poseMode = classifyFacePose(frame, leftEye, rightEye, nose)
  if (poseMode === 'profile') return undefined
  const localSort = (first: ProjectedLandmark, second: ProjectedLandmark): number =>
    faceLocalPoint(frame, first).x - faceLocalPoint(frame, second).x
  const earTips = [...(groups.get('ear-tip') ?? [])].sort(localSort)
  const earRoots = [...(groups.get('ear-root') ?? [])].sort(localSort)
  const mouths = [...(groups.get('mouth-corner') ?? [])].sort(localSort)
  const leftEyeLocal = faceLocalPoint(frame, leftEye)
  const rightEyeLocal = faceLocalPoint(frame, rightEye)
  const noseLocal = faceLocalPoint(frame, nose)
  const mouthLocals = mouths.map((point) => faceLocalPoint(frame, point))
  const eyeSpan = frame.eyeSpan
  const pairedEars = [
    singleEarStructureScore(activeMask, width, height, earTips[0]!, earRoots[0]!),
    singleEarStructureScore(activeMask, width, height, earTips.at(-1)!, earRoots.at(-1)!),
  ]
  const earStructure = Math.min(...pairedEars.map((ear) => ear.score))
  const earConnected = pairedEars.every((ear) => ear.connected)
  const earSpanCells = Math.min(...pairedEars.map((ear) => ear.spanCells))
  const eyeAlignment = clamp(1 - Math.abs(leftEyeLocal.y - rightEyeLocal.y) / Math.max(1, eyeSpan * 0.2))
  const noseOffset = Math.abs(noseLocal.x) / eyeSpan
  const noseAxis = poseMode === 'frontal'
    ? plateauScore(noseOffset, 0, 0.12, 0, 0.33)
    : plateauScore(noseOffset, 0.2, 0.5, 0.2, 0.15)
  const noseBelowEyes = plateauScore(
    (noseLocal.y - mean([leftEyeLocal.y, rightEyeLocal.y])) / eyeSpan,
    0.04,
    0.9,
    0.14,
    0.6,
  )
  const mouthPair = mouths.length < 2 ? undefined : [mouths[0]!, mouths.at(-1)!] as const
  const mouthLocalPair = mouthLocals.length < 2
    ? undefined
    : [mouthLocals[0]!, mouthLocals.at(-1)!] as const
  const mouthSpan = mouthLocalPair === undefined
    ? 0
    : Math.abs(mouthLocalPair[1].x - mouthLocalPair[0].x)
  const mouthCenter = mouthLocalPair === undefined
    ? undefined
    : {
        x: mean(mouthLocalPair.map((point) => point.x)),
        y: mean(mouthLocalPair.map((point) => point.y)),
      }
  const mouthBelowNose = mouthCenter === undefined
    ? 0.6
    : plateauScore((mouthCenter.y - noseLocal.y) / eyeSpan, 0.02, 0.85, 0.12, 0.55)
  const mouthCentered = mouthCenter === undefined
    ? 0.6
    : plateauScore(Math.abs(mouthCenter.x - noseLocal.x) / eyeSpan, 0, 0.12, 0, 0.23)
  const mouthSpanScore = mouthLocalPair === undefined
    ? 0.6
    : plateauScore(mouthSpan / eyeSpan, 0.2, 1.35, 0.2, 0.65)
  const noseOccupancy = Number(occupiedWithin(activeMask, width, height, nose, 1))
  const mouthEndpointCoverage = mouthPair === undefined
    ? 0.6
    : mean(mouthPair.map((point) => Number(occupiedWithin(activeMask, width, height, point, 1))))
  const gapScore = mean([noseBelowEyes, mouthBelowNose])
  const muzzleStructure = clamp(
    noseOccupancy * 0.25
      + mouthCentered * 0.25
      + gapScore * 0.2
      + mouthSpanScore * 0.15
      + mouthEndpointCoverage * 0.15,
  )
  const relevant = [...earTips, ...earRoots, leftEye, rightEye, nose, ...mouths]
  const landmarkCoverage = mean(relevant.map((landmark) => Number(
    occupiedWithin(activeMask, width, height, landmark, 1),
  )))
  const earTipLocals = earTips.map((point) => faceLocalPoint(frame, point))
  const earRootLocals = earRoots.map((point) => faceLocalPoint(frame, point))
  const top = Math.min(...earTipLocals.map((point) => point.y))
  const bottom = Math.max(noseLocal.y + eyeSpan, ...mouthLocals.map((point) => point.y))
  const left = Math.min(...earRootLocals.map((point) => point.x), leftEyeLocal.x - eyeSpan)
  const right = Math.max(...earRootLocals.map((point) => point.x), rightEyeLocal.x + eyeSpan)
  const symmetry = frontalSilhouetteSymmetry(
    activeMask,
    width,
    height,
    frame,
    left,
    right,
    top,
    bottom,
  )
  const facialGeometry = mean([eyeAlignment, noseAxis, noseBelowEyes, mouthBelowNose, mouthCentered])
  const confidence = clamp(mean(relevant.map((landmark) => landmark.confidence)) * Math.min(1, relevant.length / 7))
  const weights = poseMode === 'frontal'
    ? { symmetry: 0.17, muzzle: 0.18, coverage: 0.1, geometry: 0.05 }
    : { symmetry: 0.07, muzzle: 0.24, coverage: 0.12, geometry: 0.07 }
  const score = clamp(
    earStructure * 0.5
      + symmetry * weights.symmetry
      + muzzleStructure * weights.muzzle
      + landmarkCoverage * weights.coverage
      + facialGeometry * weights.geometry,
  )
  return {
    mode: poseMode,
    available: true,
    score,
    confidence,
    landmarkCoverage,
    skeletonContinuity: mean(pairedEars.map((ear) => Number(ear.connected))),
    torsoAxisAgreement: 0,
    boneRatio: 0,
    groundContact: 0,
    negativeSpace: 0,
    tailPathQuality: 0,
    boundaryRhythm: symmetry,
    frontVerticalRunRatio: 0,
    frontChestScore: symmetry,
    earStructure,
    earSpanCells,
    earConnected,
    muzzleStructure,
    muzzleSeparationCells: Math.max(0, mouthSpan),
  }
}

function evaluateSinglePetPoseStructure(input: {
  analysis: ImageAnalysis
  crop: CropRect
  fit: CanvasFit
  width: number
  height: number
  activeMask: Uint8Array
}): PetPoseCoreEvaluation {
  const { analysis, crop, fit, width, height, activeMask } = input
  const empty = emptyPetPoseEvaluation()
  const frontal = frontalFaceEvaluation(analysis, crop, fit, activeMask, width, height)
  if (frontal !== undefined) return frontal
  const landmarks = projectedLandmarks(analysis, crop, fit)
  const requiredBodyRoles = ['shoulder', 'tail-root', 'front-paw', 'rear-paw'] as const
  if (requiredBodyRoles.some((role) => landmarks.has(role) === false)) {
    return empty
  }
  const landmarkEntries = [...landmarks.values()]
  const landmarkCoverage = mean(landmarkEntries.map((landmark) => Number(
    occupiedWithin(activeMask, width, height, landmark, 1),
  )))
  const observableEdges = petSkeletonEdges.flatMap(([from, to]) => {
    const start = landmarks.get(from)
    const end = landmarks.get(to)
    return start === undefined || end === undefined ? [] : [[start, end] as const]
  })
  const skeletonContinuity = mean(observableEdges.map(([start, end]) =>
    edgeCoverage(activeMask, width, height, start, end)))
  const shoulder = landmarks.get('shoulder')
  const tailRoot = landmarks.get('tail-root')
  const actualShoulder = shoulder === undefined
    ? undefined
    : nearestOccupied(activeMask, width, height, shoulder, 3)
  const actualTailRoot = tailRoot === undefined
    ? undefined
    : nearestOccupied(activeMask, width, height, tailRoot, 3)
  const torsoAxisAgreement = shoulder === undefined || tailRoot === undefined
    || actualShoulder === undefined || actualTailRoot === undefined
    ? 0
    : angleAgreement(shoulder, tailRoot, actualShoulder, actualTailRoot)
  const ratioPairs: readonly [StructuralRole, StructuralRole, StructuralRole, StructuralRole][] = [
    ['shoulder', 'front-knee', 'front-knee', 'front-paw'],
    ['hip', 'rear-knee', 'rear-knee', 'rear-paw'],
  ]
  const ratios = ratioPairs.flatMap(([firstStartRole, firstEndRole, secondStartRole, secondEndRole]) => {
    const firstStart = landmarks.get(firstStartRole)
    const firstEnd = landmarks.get(firstEndRole)
    const secondStart = landmarks.get(secondStartRole)
    const secondEnd = landmarks.get(secondEndRole)
    if (firstStart === undefined || firstEnd === undefined || secondStart === undefined || secondEnd === undefined) return []
    const actualFirstStart = nearestOccupied(activeMask, width, height, firstStart, 3)
    const actualFirstEnd = nearestOccupied(activeMask, width, height, firstEnd, 3)
    const actualSecondStart = nearestOccupied(activeMask, width, height, secondStart, 3)
    const actualSecondEnd = nearestOccupied(activeMask, width, height, secondEnd, 3)
    if (actualFirstStart === undefined || actualFirstEnd === undefined
      || actualSecondStart === undefined || actualSecondEnd === undefined) return []
    const expectedRatio = Math.hypot(firstEnd.x - firstStart.x, firstEnd.y - firstStart.y)
      / Math.max(1e-6, Math.hypot(secondEnd.x - secondStart.x, secondEnd.y - secondStart.y))
    const actualRatio = Math.hypot(actualFirstEnd.x - actualFirstStart.x, actualFirstEnd.y - actualFirstStart.y)
      / Math.max(1e-6, Math.hypot(actualSecondEnd.x - actualSecondStart.x, actualSecondEnd.y - actualSecondStart.y))
    return [ratioAgreement(expectedRatio, actualRatio)]
  })
  const boneRatio = mean(ratios)
  let maximumOccupiedY = -1
  for (let index = 0; index < activeMask.length; index += 1) {
    if (activeMask[index] === 1) maximumOccupiedY = Math.max(maximumOccupiedY, Math.floor(index / width))
  }
  const paws = (['front-paw', 'rear-paw'] as const).flatMap((role) => landmarks.get(role) ?? [])
  const groundContact = maximumOccupiedY < 0 || paws.length === 0
    ? 0
    : mean(paws.map((paw) => clamp(
      1 - Math.abs(maximumOccupiedY - paw.y) / Math.max(2, height * 0.08),
    )))
  const negativeSpace = negativeSpaceScore(activeMask, width, height, landmarks)
  const tailStart = landmarks.get('tail-root')
  const tailEnd = landmarks.get('tail-tip')
  const tailPathQuality = tailStart === undefined || tailEnd === undefined
    ? 0
    : tailStructureScore(activeMask, width, height, tailStart, tailEnd)
  const neck = landmarks.get('neck-base')
  const direction: -1 | 1 = neck !== undefined && tailRoot !== undefined && neck.x < tailRoot.x ? -1 : 1
  const frontPaw = landmarks.get('front-paw')
  const boundary = shoulder === undefined || frontPaw === undefined
    ? { score: 0, verticalRunRatio: 1 }
    : forwardBoundaryRhythm(activeMask, width, height, shoulder, frontPaw, direction)
  const ear = earStructureScore(activeMask, width, height, landmarks)
  const muzzle = muzzleStructureScore(activeMask, width, height, landmarks)
  const confidence = clamp(
    mean(landmarkEntries.map((landmark) => landmark.confidence))
      * Math.min(1, landmarks.size / 10),
  )
  const scoreParts: Array<readonly [number, number]> = [
    [landmarkCoverage, 0.05],
    [skeletonContinuity, 0.07],
    [torsoAxisAgreement, 0.05],
    [boneRatio, 0.05],
    [groundContact, 0.06],
    [negativeSpace, 0.16],
    [tailPathQuality, 0.04],
    [boundary.score, 0.14],
  ]
  if (ear.observed) scoreParts.push([ear.score, 0.19])
  if (muzzle.observed) scoreParts.push([muzzle.score, 0.19])
  const scoreWeight = scoreParts.reduce((sum, entry) => sum + entry[1], 0)
  const score = clamp(scoreParts.reduce((sum, entry) => sum + entry[0] * entry[1], 0) / scoreWeight)
  return {
    mode: 'profile',
    available: true,
    score,
    confidence,
    landmarkCoverage,
    skeletonContinuity,
    torsoAxisAgreement,
    boneRatio,
    groundContact,
    negativeSpace,
    tailPathQuality,
    boundaryRhythm: boundary.score,
    frontVerticalRunRatio: boundary.verticalRunRatio,
    frontChestScore: boundary.score,
    earStructure: ear.score,
    earSpanCells: ear.spanCells,
    earConnected: ear.connected,
    muzzleStructure: muzzle.score,
    muzzleSeparationCells: muzzle.separationCells,
  }
}

const PET_INSTANCE_ID = /^(pet-\d+):/

function petInstanceId(id: string): string | undefined {
  return PET_INSTANCE_ID.exec(id)?.[1]
}

function sourcePointInsideCrop(crop: CropRect, x: number, y: number): boolean {
  return x >= crop.x && y >= crop.y && x < crop.x + crop.width && y < crop.y + crop.height
}

function instanceIdsForAnalysis(analysis: ImageAnalysis): readonly string[] {
  const ids = new Set<string>()
  for (const landmark of analysis.landmarks ?? []) {
    const id = petInstanceId(landmark.id)
    if (id !== undefined) ids.add(id)
  }
  for (const region of analysis.semanticRegions ?? []) {
    const id = petInstanceId(region.id)
    if (id !== undefined) ids.add(id)
  }
  return [...ids].sort()
}

function subjectRegionForInstance(
  analysis: ImageAnalysis,
  instanceId: string,
): SemanticRegion | undefined {
  return analysis.semanticRegions?.find((region) => region.id === `${instanceId}:subject`)
}

interface ProjectedSubjectRegion {
  weights: Float32Array
  sourceRetention: number
  expectedWeight: number
}

export class PetPoseProjectionCache {
  readonly #regions = new WeakMap<SemanticRegion, Map<string, ProjectedSubjectRegion>>()

  get(region: SemanticRegion, key: string): ProjectedSubjectRegion | undefined {
    return this.#regions.get(region)?.get(key)
  }

  set(region: SemanticRegion, key: string, value: ProjectedSubjectRegion): void {
    const regionCache = this.#regions.get(region) ?? new Map<string, ProjectedSubjectRegion>()
    regionCache.set(key, value)
    this.#regions.set(region, regionCache)
  }
}

function subjectProjectionKey(
  crop: CropRect,
  fit: CanvasFit,
  width: number,
  height: number,
): string {
  return [
    crop.x, crop.y, crop.width, crop.height,
    fit.x, fit.y, fit.width, fit.height,
    width, height,
  ].join(':')
}

function projectSubjectRegion(input: {
  region: SemanticRegion
  crop: CropRect
  fit: CanvasFit
  width: number
  height: number
}, cache: PetPoseProjectionCache): ProjectedSubjectRegion {
  const { region, crop, fit, width, height } = input
  const cacheKey = subjectProjectionKey(crop, fit, width, height)
  const cached = cache.get(region, cacheKey)
  if (cached !== undefined) return cached
  const weights = new Float32Array(width * height)
  let sourceWeight = 0
  let retainedSourceWeight = 0
  let expectedWeight = 0
  for (let y = 0; y < region.mask.height; y += 1) {
    for (let x = 0; x < region.mask.width; x += 1) {
      const value = clamp(region.mask.values[y * region.mask.width + x] ?? 0)
      if (value <= 0) continue
      sourceWeight += value
      if (sourcePointInsideCrop(crop, x, y) === false) continue
      retainedSourceWeight += value
      const [gridX, gridY] = gridCellForSourcePoint(crop, fit, x, y)
      const index = gridY * width + gridX
      const previous = weights[index]!
      if (value > previous) {
        weights[index] = value
        expectedWeight += value - previous
      }
    }
  }
  const projected = {
    weights,
    sourceRetention: sourceWeight <= 0 ? 0 : retainedSourceWeight / sourceWeight,
    expectedWeight,
  }
  cache.set(region, cacheKey, projected)
  return projected
}

function subjectRegionRecall(input: {
  region: SemanticRegion
  crop: CropRect
  fit: CanvasFit
  width: number
  height: number
  activeMask: Uint8Array
  projectionCache: PetPoseProjectionCache
}): number {
  const projected = projectSubjectRegion(input, input.projectionCache)
  let occupiedWeight = 0
  for (let index = 0; index < projected.weights.length; index += 1) {
    const weight = projected.weights[index]!
    if (input.activeMask[index] === 1) occupiedWeight += weight
  }
  const gridRecall = projected.expectedWeight <= 0
    ? 0
    : occupiedWeight / projected.expectedWeight
  return clamp(projected.sourceRetention * gridRecall)
}

function crossInstanceCollisionRate(
  analysis: ImageAnalysis,
  crop: CropRect,
  fit: CanvasFit,
  width: number,
): number {
  const ownersByCell = new Map<number, Set<string>>()
  for (const landmark of analysis.landmarks ?? []) {
    const instanceId = petInstanceId(landmark.id)
    if (instanceId === undefined
      || landmark.structuralRole === undefined
      || landmarkObservationState(landmark) === 'missing'
      || landmark.confidence <= 0
      || sourcePointInsideCrop(crop, landmark.x, landmark.y) === false) continue
    const [x, y] = gridCellForSourcePoint(crop, fit, landmark.x, landmark.y)
    const index = y * width + x
    const owners = ownersByCell.get(index) ?? new Set<string>()
    owners.add(instanceId)
    ownersByCell.set(index, owners)
  }
  if (ownersByCell.size === 0) return 0
  const collisions = [...ownersByCell.values()].filter((owners) => owners.size > 1).length
  return collisions / ownersByCell.size
}

function isolateInstanceMask(input: {
  instanceId: string
  analysis: ImageAnalysis
  crop: CropRect
  fit: CanvasFit
  width: number
  height: number
  activeMask: Uint8Array
  projectionCache: PetPoseProjectionCache
}): Uint8Array {
  const subjectRegion = subjectRegionForInstance(input.analysis, input.instanceId)
  if (subjectRegion !== undefined) {
    const projected = projectSubjectRegion({ ...input, region: subjectRegion }, input.projectionCache)
    return Uint8Array.from(input.activeMask, (value, index) =>
      value === 1 && projected.weights[index]! > 0 ? 1 : 0)
  }
  const projected = projectedLandmarkGroups(input.analysis, input.crop, input.fit)
  const points = [...projected.values()].flat()
  if (points.length === 0) return new Uint8Array(input.activeMask.length)
  const minimumX = Math.min(...points.map((point) => point.x))
  const maximumX = Math.max(...points.map((point) => point.x))
  const minimumY = Math.min(...points.map((point) => point.y))
  const maximumY = Math.max(...points.map((point) => point.y))
  const span = Math.max(maximumX - minimumX, maximumY - minimumY)
  const padding = Math.max(2, Math.ceil(span * 0.25))
  const left = Math.max(0, minimumX - padding)
  const right = Math.min(input.width - 1, maximumX + padding)
  const top = Math.max(0, minimumY - padding)
  const bottom = Math.min(input.height - 1, maximumY + padding)
  const isolated = new Uint8Array(input.activeMask.length)
  for (let y = top; y <= bottom; y += 1) {
    const offset = y * input.width
    for (let x = left; x <= right; x += 1) isolated[offset + x] = input.activeMask[offset + x]!
  }
  return isolated
}

function weakestWeightedMean(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.min(...values) * 0.7 + mean(values) * 0.3
}

function weakestWeightedPenalty(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values) * 0.7 + mean(values) * 0.3
}

function aggregatePetPoseEvaluations(
  evaluations: readonly PetPoseCoreEvaluation[],
): PetPoseCoreEvaluation {
  if (evaluations.length === 0 || evaluations.every((evaluation) => evaluation.available === false)) {
    return emptyPetPoseEvaluation()
  }
  const weakest = [...evaluations].sort((first, second) => first.score - second.score)[0]!
  const positive = (select: (evaluation: PetPoseCoreEvaluation) => number): number =>
    weakestWeightedMean(evaluations.map(select))
  return {
    mode: weakest.mode,
    available: true,
    score: positive((evaluation) => evaluation.score),
    confidence: positive((evaluation) => evaluation.confidence),
    landmarkCoverage: positive((evaluation) => evaluation.landmarkCoverage),
    skeletonContinuity: positive((evaluation) => evaluation.skeletonContinuity),
    torsoAxisAgreement: positive((evaluation) => evaluation.torsoAxisAgreement),
    boneRatio: positive((evaluation) => evaluation.boneRatio),
    groundContact: positive((evaluation) => evaluation.groundContact),
    negativeSpace: positive((evaluation) => evaluation.negativeSpace),
    tailPathQuality: positive((evaluation) => evaluation.tailPathQuality),
    boundaryRhythm: positive((evaluation) => evaluation.boundaryRhythm),
    frontVerticalRunRatio: weakestWeightedPenalty(
      evaluations.map((evaluation) => evaluation.frontVerticalRunRatio),
    ),
    frontChestScore: positive((evaluation) => evaluation.frontChestScore),
    earStructure: positive((evaluation) => evaluation.earStructure),
    earSpanCells: Math.min(...evaluations.map((evaluation) => evaluation.earSpanCells)),
    earConnected: evaluations.every((evaluation) => evaluation.earConnected),
    muzzleStructure: positive((evaluation) => evaluation.muzzleStructure),
    muzzleSeparationCells: Math.min(
      ...evaluations.map((evaluation) => evaluation.muzzleSeparationCells),
    ),
  }
}

export function evaluatePetPoseStructure(input: {
  analysis: ImageAnalysis | undefined
  crop: CropRect
  fit: CanvasFit
  width: number
  height: number
  activeMask: Uint8Array
  projectionCache?: PetPoseProjectionCache
}): PetPoseEvaluation {
  if (input.activeMask.length !== input.width * input.height) {
    throw new RangeError('Pet pose mask must align with the target grid')
  }
  if (input.analysis?.imageType !== 'pet') {
    return {
      ...emptyPetPoseEvaluation(),
      instanceCount: 0,
      subjectComponentRecall: 0,
      weakestInstanceIdentityCompleteness: 0,
      crossInstanceCollisionRate: 0,
    }
  }
  const analysisInput = input.analysis
  const projectionCache = input.projectionCache ?? new PetPoseProjectionCache()
  const instanceIds = instanceIdsForAnalysis(analysisInput)
  if (instanceIds.length <= 1) {
    const evaluation = evaluateSinglePetPoseStructure({ ...input, analysis: analysisInput })
    const subjectRegion = instanceIds.length === 1
      ? subjectRegionForInstance(analysisInput, instanceIds[0]!)
      : undefined
    return {
      ...evaluation,
      instanceCount: 1,
      subjectComponentRecall: subjectRegion === undefined
        ? 1
        : subjectRegionRecall({ ...input, region: subjectRegion, projectionCache }),
      weakestInstanceIdentityCompleteness: evaluation.landmarkCoverage,
      crossInstanceCollisionRate: 0,
    }
  }
  const evaluations = instanceIds.map((instanceId) => {
    const analysis: ImageAnalysis = {
      ...analysisInput,
      landmarks: (analysisInput.landmarks ?? []).filter((landmark) =>
        petInstanceId(landmark.id) === instanceId),
    }
    return evaluateSinglePetPoseStructure({
      ...input,
      analysis,
      activeMask: isolateInstanceMask({ ...input, instanceId, analysis, projectionCache }),
    })
  })
  const subjectRecalls = instanceIds.map((instanceId) => {
    const region = subjectRegionForInstance(analysisInput, instanceId)
    return region === undefined
      ? 1
      : subjectRegionRecall({ ...input, region, projectionCache })
  })
  const aggregate = aggregatePetPoseEvaluations(evaluations)
  const subjectComponentRecall = mean(subjectRecalls)
  const weakestInstanceIdentityCompleteness = Math.min(
    ...evaluations.map((evaluation) => evaluation.landmarkCoverage),
  )
  const instanceCollisionRate = crossInstanceCollisionRate(
    analysisInput,
    input.crop,
    input.fit,
    input.width,
  )
  const multiInstanceIntegrity = clamp(
    subjectComponentRecall * 0.35
      + weakestInstanceIdentityCompleteness * 0.35
      + (1 - instanceCollisionRate) * 0.3,
  )
  return {
    ...aggregate,
    score: clamp(aggregate.score * (0.5 + multiInstanceIntegrity * 0.5)),
    instanceCount: instanceIds.length,
    subjectComponentRecall,
    weakestInstanceIdentityCompleteness,
    crossInstanceCollisionRate: instanceCollisionRate,
  }
}
