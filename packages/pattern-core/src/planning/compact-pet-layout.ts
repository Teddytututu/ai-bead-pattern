import type {
  BinaryMask,
  CropRect,
  EvidenceProvenance,
  ImageAnalysis,
  ImageLandmark,
  ImportanceMap,
  PixelImage,
  SemanticRegion,
} from '../types.js'

export type CompactPetBackground = 'transparent' | 'white'

export interface CompactPetLayoutInput {
  image: PixelImage
  analysis: ImageAnalysis
  /** Square output dimension in pixels. Defaults to the longer source dimension. */
  targetSize?: number
  /** Outer margin and spacing between layout cells. */
  gap?: number
  background?: CompactPetBackground
}

export interface CompactPetPlacement {
  instanceId: string
  sourceBounds: CropRect
  targetBounds: CropRect
  scale: number
  subjectOccupancy: number
}

export interface CompactPetLayoutDiagnostics {
  rows: number
  columns: number
  gap: number
  /** Smallest isotropic instance scale in the selected layout. */
  scale: number
  /** Smallest instance-mask area divided by the whole output canvas area. */
  weakestSubjectOccupancy: number
  placements: readonly CompactPetPlacement[]
}

export interface CompactPetLayoutResult {
  image: PixelImage
  analysis: ImageAnalysis
  diagnostics: CompactPetLayoutDiagnostics
}

interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

interface PetInstance {
  id: string
  subject: SemanticRegion
  regions: readonly SemanticRegion[]
  landmarks: readonly ImageLandmark[]
  bounds: CropRect
}

interface PlannedPlacement {
  instance: PetInstance
  sourceBounds: CropRect
  targetBounds: CropRect
  scale: number
}

interface LayoutPlan {
  rows: number
  columns: number
  scale: number
  placements: readonly PlannedPlacement[]
}

const layoutVersion = 'compact-pet-layout-v1'
const instanceSubjectPattern = /^(pet-\d+):subject$/
const instanceOwnedPattern = /^(pet-\d+):/
const maskThreshold = 0.2
const maximumTargetSize = 4096
const epsilon = 1e-12

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function validateMask(mask: BinaryMask, width: number, height: number, label: string): void {
  if (mask.width !== width || mask.height !== height || mask.values.length !== width * height) {
    throw new RangeError(`${label} must align with the source image`)
  }
  for (const value of mask.values) {
    if (Number.isFinite(value) === false || value < 0 || value > 1) {
      throw new RangeError(`${label} mask values must stay within 0..1`)
    }
  }
}

function validateImportanceMap(
  importanceMap: ImportanceMap,
  width: number,
  height: number,
): void {
  if (importanceMap.width !== width || importanceMap.height !== height
    || importanceMap.weights.length !== width * height) {
    throw new RangeError('Importance map must align with the source image')
  }
  for (const value of importanceMap.weights) {
    if (Number.isFinite(value) === false || value < 0 || value > 1) {
      throw new RangeError('Importance map weights must stay within 0..1')
    }
  }
}

function validateInput(input: CompactPetLayoutInput): {
  targetSize: number
  gap: number
  background: CompactPetBackground
} {
  const { image, analysis } = input
  if (Number.isInteger(image.width) === false || image.width <= 0
    || Number.isInteger(image.height) === false || image.height <= 0) {
    throw new RangeError('Image dimensions must be positive integers')
  }
  if (image.data.length !== image.width * image.height * 4) {
    throw new RangeError('Image data must contain one RGBA tuple per source pixel')
  }
  const targetSize = input.targetSize ?? Math.max(image.width, image.height)
  if (Number.isInteger(targetSize) === false || targetSize <= 0
    || targetSize > maximumTargetSize) {
    throw new RangeError(`Target size must be an integer within 1..${maximumTargetSize}`)
  }
  const gap = input.gap ?? Math.max(1, Math.round(targetSize * 0.025))
  if (Number.isInteger(gap) === false || gap < 0) {
    throw new RangeError('Gap must be a non-negative integer')
  }
  const background = input.background ?? 'transparent'
  if (background !== 'transparent' && background !== 'white') {
    throw new RangeError('Background must be transparent or white')
  }
  for (const region of analysis.semanticRegions ?? []) {
    validateMask(region.mask, image.width, image.height, `Semantic region ${region.id}`)
  }
  if (analysis.subjectMask !== undefined) {
    validateMask(analysis.subjectMask, image.width, image.height, 'Subject mask')
  }
  if (analysis.subjectMaskEvidence !== undefined) {
    validateMask(
      analysis.subjectMaskEvidence.mask,
      image.width,
      image.height,
      'Subject mask evidence',
    )
  }
  if (analysis.importanceMap !== undefined) {
    validateImportanceMap(analysis.importanceMap, image.width, image.height)
  }
  for (const landmark of analysis.landmarks ?? []) {
    if (instanceOwnedPattern.test(landmark.id) === false) continue
    if (Number.isFinite(landmark.x) === false || Number.isFinite(landmark.y) === false
      || landmark.x < 0 || landmark.x >= image.width
      || landmark.y < 0 || landmark.y >= image.height) {
      throw new RangeError(`Pet landmark ${landmark.id} must lie within the source image`)
    }
  }
  return { targetSize, gap, background }
}

function maskBounds(mask: BinaryMask): Bounds | undefined {
  let left = mask.width
  let top = mask.height
  let right = -1
  let bottom = -1
  for (let index = 0; index < mask.values.length; index += 1) {
    if ((mask.values[index] ?? 0) < maskThreshold) continue
    const x = index % mask.width
    const y = Math.floor(index / mask.width)
    left = Math.min(left, x)
    top = Math.min(top, y)
    right = Math.max(right, x + 1)
    bottom = Math.max(bottom, y + 1)
  }
  return right <= left || bottom <= top ? undefined : { left, top, right, bottom }
}

function includeBounds(base: Bounds | undefined, addition: Bounds): Bounds {
  if (base === undefined) return addition
  return {
    left: Math.min(base.left, addition.left),
    top: Math.min(base.top, addition.top),
    right: Math.max(base.right, addition.right),
    bottom: Math.max(base.bottom, addition.bottom),
  }
}

function landmarkBounds(landmark: ImageLandmark): Bounds {
  const radius = Math.max(0, landmark.sourceRadiusPx ?? landmark.radius ?? 0)
  return {
    left: landmark.x - radius,
    top: landmark.y - radius,
    right: landmark.x + radius + 1,
    bottom: landmark.y + radius + 1,
  }
}

function normalizeBounds(bounds: Bounds, width: number, height: number): CropRect {
  const left = clamp(bounds.left, 0, width)
  const top = clamp(bounds.top, 0, height)
  const right = clamp(bounds.right, left, width)
  const bottom = clamp(bounds.bottom, top, height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function collectInstances(input: CompactPetLayoutInput): readonly PetInstance[] {
  const regions = input.analysis.semanticRegions ?? []
  const subjectById = new Map<string, SemanticRegion>()
  for (const region of regions) {
    const match = instanceSubjectPattern.exec(region.id)
    if (match === null) continue
    const instanceId = match[1]!
    if (subjectById.has(instanceId)) {
      throw new RangeError(`Pet instance ${instanceId} has duplicate subject masks`)
    }
    if (maskBounds(region.mask) === undefined) {
      throw new RangeError(`Pet instance ${instanceId} subject mask must contain foreground`)
    }
    subjectById.set(instanceId, region)
  }
  if (subjectById.size === 0) {
    throw new RangeError('At least one pet instance subject mask is required')
  }
  for (const region of regions) {
    const match = instanceOwnedPattern.exec(region.id)
    if (match !== null && subjectById.has(match[1]!) === false) {
      throw new RangeError(`Semantic region ${region.id} has no pet instance subject mask`)
    }
  }
  for (const landmark of input.analysis.landmarks ?? []) {
    const match = instanceOwnedPattern.exec(landmark.id)
    if (match !== null && subjectById.has(match[1]!) === false) {
      throw new RangeError(`Pet landmark ${landmark.id} has no pet instance subject mask`)
    }
  }
  return [...subjectById.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([id, subject]) => {
      const ownedRegions = regions.filter((region) => region.id.startsWith(`${id}:`))
      const ownedLandmarks = (input.analysis.landmarks ?? []).filter((landmark) =>
        landmark.id.startsWith(`${id}:`))
      let bounds: Bounds | undefined
      for (const region of ownedRegions) {
        const regionBounds = maskBounds(region.mask)
        if (regionBounds !== undefined) bounds = includeBounds(bounds, regionBounds)
      }
      for (const landmark of ownedLandmarks) {
        if (landmark.observationState === 'missing') continue
        bounds = includeBounds(bounds, landmarkBounds(landmark))
      }
      const normalized = normalizeBounds(bounds!, input.image.width, input.image.height)
      if (normalized.width <= 0 || normalized.height <= 0) {
        throw new RangeError(`Pet instance ${id} bounds must contain foreground`)
      }
      return {
        id,
        subject,
        regions: ownedRegions,
        landmarks: ownedLandmarks,
        bounds: normalized,
      }
    })
}

function planLayout(
  instances: readonly PetInstance[],
  targetSize: number,
  gap: number,
): LayoutPlan {
  let best: LayoutPlan | undefined
  for (let columns = 1; columns <= instances.length; columns += 1) {
    const rows = Math.ceil(instances.length / columns)
    const cellWidth = (targetSize - gap * (columns + 1)) / columns
    const cellHeight = (targetSize - gap * (rows + 1)) / rows
    if (cellWidth <= 0 || cellHeight <= 0) continue
    const placements: PlannedPlacement[] = []
    for (let index = 0; index < instances.length; index += 1) {
      const instance = instances[index]!
      const row = Math.floor(index / columns)
      const column = index % columns
      const entriesInRow = Math.min(columns, instances.length - row * columns)
      const rowWidth = entriesInRow * cellWidth + Math.max(0, entriesInRow - 1) * gap
      const rowStart = (targetSize - rowWidth) * 0.5
      const cellX = rowStart + column * (cellWidth + gap)
      const cellY = gap + row * (cellHeight + gap)
      const scale = Math.min(
        cellWidth / instance.bounds.width,
        cellHeight / instance.bounds.height,
      )
      const targetWidth = instance.bounds.width * scale
      const targetHeight = instance.bounds.height * scale
      placements.push({
        instance,
        sourceBounds: instance.bounds,
        targetBounds: {
          x: cellX + (cellWidth - targetWidth) * 0.5,
          y: cellY + (cellHeight - targetHeight) * 0.5,
          width: targetWidth,
          height: targetHeight,
        },
        scale,
      })
    }
    const scale = Math.min(...placements.map((placement) => placement.scale))
    const plan: LayoutPlan = { rows, columns, scale, placements }
    if (best === undefined
      || plan.scale > best.scale + epsilon
      || (Math.abs(plan.scale - best.scale) <= epsilon
        && plan.rows < best.rows)
      || (Math.abs(plan.scale - best.scale) <= epsilon
        && plan.rows === best.rows && plan.columns < best.columns)) {
      best = plan
    }
  }
  if (best === undefined) {
    throw new RangeError('Gap leaves no room for a compact pet layout')
  }
  return best
}

function scalarAt(values: Float32Array, width: number, height: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= width || y >= height) return 0
  return values[y * width + x] ?? 0
}

function sampleScalar(
  values: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const tx = x - x0
  const ty = y - y0
  return clamp(
    scalarAt(values, width, height, x0, y0) * (1 - tx) * (1 - ty)
      + scalarAt(values, width, height, x0 + 1, y0) * tx * (1 - ty)
      + scalarAt(values, width, height, x0, y0 + 1) * (1 - tx) * ty
      + scalarAt(values, width, height, x0 + 1, y0 + 1) * tx * ty,
    0,
    1,
  )
}

function sourcePoint(
  placement: PlannedPlacement,
  targetX: number,
  targetY: number,
): readonly [number, number] {
  return [
    placement.sourceBounds.x
      + (targetX + 0.5 - placement.targetBounds.x) / placement.scale - 0.5,
    placement.sourceBounds.y
      + (targetY + 0.5 - placement.targetBounds.y) / placement.scale - 0.5,
  ]
}

function forEachTargetPixel(
  placement: PlannedPlacement,
  targetSize: number,
  visit: (targetX: number, targetY: number, sourceX: number, sourceY: number) => void,
): void {
  const left = Math.max(0, Math.floor(placement.targetBounds.x))
  const top = Math.max(0, Math.floor(placement.targetBounds.y))
  const right = Math.min(targetSize, Math.ceil(
    placement.targetBounds.x + placement.targetBounds.width,
  ))
  const bottom = Math.min(targetSize, Math.ceil(
    placement.targetBounds.y + placement.targetBounds.height,
  ))
  for (let targetY = top; targetY < bottom; targetY += 1) {
    for (let targetX = left; targetX < right; targetX += 1) {
      const centerX = targetX + 0.5
      const centerY = targetY + 0.5
      if (centerX < placement.targetBounds.x
        || centerX >= placement.targetBounds.x + placement.targetBounds.width
        || centerY < placement.targetBounds.y
        || centerY >= placement.targetBounds.y + placement.targetBounds.height) continue
      const source = sourcePoint(placement, targetX, targetY)
      visit(targetX, targetY, source[0], source[1])
    }
  }
}

function transformMask(
  mask: BinaryMask,
  placement: PlannedPlacement,
  targetSize: number,
): BinaryMask {
  const values = new Float32Array(targetSize * targetSize)
  forEachTargetPixel(placement, targetSize, (targetX, targetY, sourceX, sourceY) => {
    values[targetY * targetSize + targetX] = sampleScalar(
      mask.values,
      mask.width,
      mask.height,
      sourceX,
      sourceY,
    )
  })
  return { width: targetSize, height: targetSize, values }
}

function combineMasks(masks: readonly BinaryMask[], targetSize: number): BinaryMask {
  return {
    width: targetSize,
    height: targetSize,
    values: Float32Array.from({ length: targetSize * targetSize }, (_, index) =>
      Math.max(...masks.map((mask) => mask.values[index] ?? 0))),
  }
}

function byteAt(image: PixelImage, x: number, y: number, channel: number): number {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return 0
  return image.data[(y * image.width + x) * 4 + channel] ?? 0
}

function sampleByte(image: PixelImage, x: number, y: number, channel: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const tx = x - x0
  const ty = y - y0
  return byteAt(image, x0, y0, channel) * (1 - tx) * (1 - ty)
    + byteAt(image, x0 + 1, y0, channel) * tx * (1 - ty)
    + byteAt(image, x0, y0 + 1, channel) * (1 - tx) * ty
    + byteAt(image, x0 + 1, y0 + 1, channel) * tx * ty
}

function composeImage(
  image: PixelImage,
  plan: LayoutPlan,
  targetSize: number,
  background: CompactPetBackground,
): PixelImage {
  const data = new Uint8ClampedArray(targetSize * targetSize * 4)
  if (background === 'white') data.fill(255)
  for (const placement of plan.placements) {
    forEachTargetPixel(placement, targetSize, (targetX, targetY, sourceX, sourceY) => {
      const mask = sampleScalar(
        placement.instance.subject.mask.values,
        image.width,
        image.height,
        sourceX,
        sourceY,
      )
      if (mask <= 0) return
      const sourceAlpha = sampleByte(image, sourceX, sourceY, 3) / 255
      const alpha = clamp(mask * sourceAlpha, 0, 1)
      if (alpha <= 0) return
      const offset = (targetY * targetSize + targetX) * 4
      for (let channel = 0; channel < 3; channel += 1) {
        const sourceValue = sampleByte(image, sourceX, sourceY, channel)
        data[offset + channel] = background === 'white'
          ? Math.round(sourceValue * alpha + 255 * (1 - alpha))
          : Math.round(sourceValue)
      }
      data[offset + 3] = background === 'white' ? 255 : Math.round(alpha * 255)
    })
  }
  return { width: targetSize, height: targetSize, data }
}

function transformLandmark(
  landmark: ImageLandmark,
  placement: PlannedPlacement,
): ImageLandmark {
  return {
    ...landmark,
    x: placement.targetBounds.x
      + (landmark.x - placement.sourceBounds.x + 0.5) * placement.scale - 0.5,
    y: placement.targetBounds.y
      + (landmark.y - placement.sourceBounds.y + 0.5) * placement.scale - 0.5,
    ...(landmark.sourceRadiusPx === undefined
      ? {}
      : { sourceRadiusPx: landmark.sourceRadiusPx * placement.scale }),
    ...(landmark.radius === undefined
      ? {}
      : { radius: landmark.radius * placement.scale }),
  }
}

function transformImportanceMap(
  importanceMap: ImportanceMap,
  plan: LayoutPlan,
  targetSize: number,
): ImportanceMap {
  const weights = new Float32Array(targetSize * targetSize)
  for (const placement of plan.placements) {
    forEachTargetPixel(placement, targetSize, (targetX, targetY, sourceX, sourceY) => {
      const importance = sampleScalar(
        importanceMap.weights,
        importanceMap.width,
        importanceMap.height,
        sourceX,
        sourceY,
      )
      const subject = sampleScalar(
        placement.instance.subject.mask.values,
        placement.instance.subject.mask.width,
        placement.instance.subject.mask.height,
        sourceX,
        sourceY,
      )
      const index = targetY * targetSize + targetX
      weights[index] = Math.max(weights[index] ?? 0, importance * subject)
    })
  }
  return { width: targetSize, height: targetSize, weights }
}

function activeArea(mask: BinaryMask): number {
  let area = 0
  for (const value of mask.values) area += Number(value >= 0.5)
  return area
}

function cropForMask(mask: BinaryMask): CropRect {
  const bounds = maskBounds(mask)!
  return {
    x: bounds.left,
    y: bounds.top,
    width: bounds.right - bounds.left,
    height: bounds.bottom - bounds.top,
  }
}

function layoutProvenance(): EvidenceProvenance {
  return {
    origin: 'fused',
    provider: 'pattern-core/compact-pet-layout',
    version: layoutVersion,
  }
}

export function compactPetLayout(input: CompactPetLayoutInput): CompactPetLayoutResult {
  const { targetSize, gap, background } = validateInput(input)
  const instances = collectInstances(input)
  const plan = planLayout(instances, targetSize, gap)
  const transformedRegionMasks = new Map<string, BinaryMask>()
  const transformedSubjectMasks: BinaryMask[] = []
  for (const placement of plan.placements) {
    for (const region of placement.instance.regions) {
      const mask = transformMask(region.mask, placement, targetSize)
      transformedRegionMasks.set(region.id, mask)
      if (region.id === `${placement.instance.id}:subject`) {
        transformedSubjectMasks.push(mask)
      }
    }
  }
  const subjectMask = combineMasks(transformedSubjectMasks, targetSize)
  const originalSubject = (input.analysis.semanticRegions ?? []).find((region) =>
    region.id === 'subject')
  const provenance = layoutProvenance()
  const semanticRegions: SemanticRegion[] = [
    {
      ...(originalSubject ?? {
        id: 'subject',
        label: 'all pets',
        confidence: input.analysis.confidence ?? 1,
        importance: 1,
      }),
      mask: subjectMask,
      provenance: [...(originalSubject?.provenance ?? []), provenance],
    },
    ...(input.analysis.semanticRegions ?? [])
      .filter((region) => instanceOwnedPattern.test(region.id))
      .map((region) => ({
        ...region,
        mask: transformedRegionMasks.get(region.id)!,
        provenance: [...(region.provenance ?? []), provenance],
      })),
  ]
  const placementByInstance = new Map(plan.placements.map((placement) => [
    placement.instance.id,
    placement,
  ]))
  const landmarks = (input.analysis.landmarks ?? [])
    .filter((landmark) => instanceOwnedPattern.test(landmark.id))
    .map((landmark) => {
      const instanceId = instanceOwnedPattern.exec(landmark.id)![1]!
      return transformLandmark(landmark, placementByInstance.get(instanceId)!)
    })
  const importanceMap = input.analysis.importanceMap === undefined
    ? undefined
    : transformImportanceMap(input.analysis.importanceMap, plan, targetSize)
  const subjectMaskEvidence = input.analysis.subjectMaskEvidence === undefined
    ? undefined
    : {
      ...input.analysis.subjectMaskEvidence,
      mask: subjectMask,
      revision: `${input.analysis.subjectMaskEvidence.revision}:${layoutVersion}`,
      provenance: [
        ...(input.analysis.subjectMaskEvidence.provenance ?? []),
        provenance,
      ],
    }
  const analysis: ImageAnalysis = {
    ...input.analysis,
    subjectMask,
    ...(subjectMaskEvidence === undefined ? {} : { subjectMaskEvidence }),
    semanticRegions,
    landmarks,
    ...(importanceMap === undefined ? {} : { importanceMap }),
    suggestedCrop: cropForMask(subjectMask),
    suggestedCropConfidence: input.analysis.suggestedCropConfidence
      ?? input.analysis.confidence ?? 1,
    suggestedCropSource: 'automatic',
    modelVersions: {
      ...(input.analysis.modelVersions ?? {}),
      petCompactLayout: layoutVersion,
    },
    provenance: [...(input.analysis.provenance ?? []), provenance],
  }
  const placements = plan.placements.map((placement) => {
    const mask = transformedRegionMasks.get(`${placement.instance.id}:subject`)!
    return {
      instanceId: placement.instance.id,
      sourceBounds: placement.sourceBounds,
      targetBounds: placement.targetBounds,
      scale: placement.scale,
      subjectOccupancy: activeArea(mask) / (targetSize * targetSize),
    }
  })
  return {
    image: composeImage(input.image, plan, targetSize, background),
    analysis,
    diagnostics: {
      rows: plan.rows,
      columns: plan.columns,
      gap,
      scale: plan.scale,
      weakestSubjectOccupancy: Math.min(...placements.map((item) => item.subjectOccupancy)),
      placements,
    },
  }
}
