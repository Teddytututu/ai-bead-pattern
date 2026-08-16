import {
  colorDistance,
  prepareColors,
  rgbDistance,
  rgbToLab,
  type PreparedColor,
} from './color.js'
import { adaptPattern } from './adaptation.js'
import {
  countIsolatedCells,
  countThinStripes,
  optimizeGrid,
} from './grid.js'
import {
  applyStyle,
  gridCellForSourcePoint,
  normalizeCrop,
  resizePixels,
  sourcePointForGridCell,
  type CanvasFit,
} from './image.js'
import {
  landmarkEffectiveConfidence,
  landmarkGridRadiusCells,
} from './landmarks.js'
import { optimizePaletteAssignments } from './palette-optimization.js'
import { buildSourceGuidance, designRegionValues, type SourceGuidance } from './structure.js'
import type {
  AlgorithmEngine,
  BaselineMode,
  CandidateEvaluation,
  CandidateScore,
  ColorDistanceMethod,
  CropRect,
  GridSize,
  ImageAnalysis,
  Lab,
  MaterialCount,
  PatternCandidate,
  PatternCell,
  PatternGenerationRequest,
  PatternGenerationResult,
  PatternMetadata,
  PatternOptions,
  PatternStyle,
  PatternAdaptationRequest,
  PatternAdaptationResult,
  ResizeMethod,
  RGB,
} from './types.js'

interface CandidateContext {
  request: PatternGenerationRequest
  crop: CropRect
  size: GridSize
  style: PatternStyle
  baseline: BaselineMode
  resizeMethod: ResizeMethod
  distanceMethod: ColorDistanceMethod
  preparedPalette: readonly PreparedColor[]
  sourceGuidance: SourceGuidance
}

interface AssignedGrid {
  colorIds: readonly string[]
}

const defaultStyles: readonly PatternStyle[] = ['faithful', 'simple', 'high-contrast']
const maxImageSide = 2_048
const maxImagePixels = 4_000_000
const maxCanvasSide = 96
const maxCanvasCells = 9_216
const maxPaletteColors = 128
const maxSelectedColors = 48
const maxCanvasCandidates = 12
const maxGeneratedCandidates = 20

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const record = value as Readonly<Record<string, unknown>>
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, '0')
}

function validatePositiveInteger(value: number, label: string): void {
  if (Number.isInteger(value) === false || value <= 0) {
    throw new RangeError(`${label} must be a positive integer`)
  }
}

function validateRgb(rgb: RGB, label: string): void {
  if (rgb.some((channel) => Number.isFinite(channel) === false || channel < 0 || channel > 255)) {
    throw new RangeError(`${label} must contain sRGB byte values`)
  }
}

function validateMask(
  width: number,
  height: number,
  values: ArrayLike<number>,
  imageWidth: number,
  imageHeight: number,
  label: string,
): void {
  if (width !== imageWidth || height !== imageHeight || values.length !== width * height) {
    throw new RangeError(`${label} must align with the source image`)
  }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === undefined || Number.isFinite(value) === false || value < 0 || value > 1) {
      throw new RangeError(`${label} values must stay within 0..1`)
    }
  }
}

function validateRequest(request: PatternGenerationRequest): void {
  validatePositiveInteger(request.image.width, 'Image width')
  validatePositiveInteger(request.image.height, 'Image height')
  if (request.image.data.length !== request.image.width * request.image.height * 4) {
    throw new RangeError('RGBA data length must equal width * height * 4')
  }
  if (request.image.width > maxImageSide || request.image.height > maxImageSide
    || request.image.width * request.image.height > maxImagePixels) {
    throw new RangeError('Image exceeds the MVP processing limit')
  }
  if (request.palette.colors.length === 0) {
    throw new RangeError('Palette requires at least one color')
  }
  if (request.palette.colors.length > maxPaletteColors) {
    throw new RangeError('Palette exceeds the MVP processing limit')
  }
  const colorIds = new Set(request.palette.colors.map((color) => color.id))
  if (colorIds.size !== request.palette.colors.length) {
    throw new RangeError('Palette color ids must be unique')
  }
  for (const color of request.palette.colors) {
    if (color.id.trim().length === 0) throw new RangeError('Palette color id is required')
    validateRgb(color.rgb, `Palette color ${color.id}`)
    if (color.lab?.some((value) => Number.isFinite(value) === false)) {
      throw new RangeError(`Palette color ${color.id} Lab values must be finite`)
    }
  }
  if (request.options.backgroundRgb !== undefined) {
    validateRgb(request.options.backgroundRgb, 'Background')
  }
  const analysis = request.analysis
  if (analysis?.subjectMask !== undefined) {
    validateMask(
      analysis.subjectMask.width,
      analysis.subjectMask.height,
      analysis.subjectMask.values,
      request.image.width,
      request.image.height,
      'Subject mask',
    )
  }
  if (analysis?.importanceMap !== undefined) {
    validateMask(
      analysis.importanceMap.width,
      analysis.importanceMap.height,
      analysis.importanceMap.weights,
      request.image.width,
      request.image.height,
      'Importance map',
    )
  }
  for (const region of analysis?.semanticRegions ?? []) {
    validateMask(
      region.mask.width,
      region.mask.height,
      region.mask.values,
      request.image.width,
      request.image.height,
      `Semantic region ${region.id}`,
    )
  }
  for (const landmark of analysis?.landmarks ?? []) {
    if ([landmark.x, landmark.y, landmark.confidence, landmark.radius ?? 0,
      landmark.sourceRadiusPx ?? 0, landmark.gridRadiusCells ?? 0]
      .some((value) => Number.isFinite(value) === false)) {
      throw new RangeError(`Landmark ${landmark.id} values must be finite`)
    }
    if (landmark.confidence < 0 || landmark.confidence > 1
      || (landmark.radius ?? 0) < 0
      || (landmark.sourceRadiusPx ?? 0) < 0
      || (landmark.gridRadiusCells ?? 0) < 0) {
      throw new RangeError(`Landmark ${landmark.id} confidence and radii are outside their valid range`)
    }
    const maximumSourceRadius = Math.max(request.image.width, request.image.height)
    if ((landmark.sourceRadiusPx ?? 0) > maximumSourceRadius
      || (landmark.gridRadiusCells ?? 0) > maxCanvasSide
      || (landmark.radius ?? 0) > Math.max(maximumSourceRadius, maxCanvasSide)) {
      throw new RangeError(`Landmark ${landmark.id} radius exceeds the processing limit`)
    }
  }
  if (analysis?.confidence !== undefined
    && (Number.isFinite(analysis.confidence) === false
      || analysis.confidence < 0 || analysis.confidence > 1)) {
    throw new RangeError('Analysis confidence must stay within 0..1')
  }
  if (analysis?.suggestedCrop !== undefined
    && [analysis.suggestedCrop.x, analysis.suggestedCrop.y,
      analysis.suggestedCrop.width, analysis.suggestedCrop.height]
      .some((value) => Number.isFinite(value) === false)) {
    throw new RangeError('Suggested crop values must be finite')
  }
  if (analysis?.suggestedCrop !== undefined
    && (analysis.suggestedCrop.width <= 0 || analysis.suggestedCrop.height <= 0)) {
    throw new RangeError('Suggested crop dimensions must be positive')
  }
  if (analysis?.suggestedCropSource !== undefined
    && analysis.suggestedCropSource !== 'automatic'
    && analysis.suggestedCropSource !== 'manual') {
    throw new RangeError('Suggested crop source must be automatic or manual')
  }
  if (analysis?.suggestedCropConfidence !== undefined
    && (Number.isFinite(analysis.suggestedCropConfidence) === false
      || analysis.suggestedCropConfidence < 0 || analysis.suggestedCropConfidence > 1)) {
    throw new RangeError('Suggested crop confidence must stay within 0..1')
  }
  validatePositiveInteger(request.options.maxColors, 'maxColors')
  if (request.options.maxColors > maxSelectedColors) {
    throw new RangeError('maxColors exceeds the MVP processing limit')
  }
  if (request.options.canvas?.mode === 'auto'
    && request.options.canvas.candidates.length > maxCanvasCandidates) {
    throw new RangeError('Canvas candidates exceed the MVP processing limit')
  }
  if (request.options.maxCandidates !== undefined) {
    validatePositiveInteger(request.options.maxCandidates, 'maxCandidates')
    if (request.options.maxCandidates > maxGeneratedCandidates) {
      throw new RangeError('maxCandidates exceeds the MVP processing limit')
    }
  }
  for (const [name, value] of Object.entries(request.options.optimization ?? {})) {
    if (value !== undefined && (Number.isFinite(value) === false || value < 0)) {
      throw new RangeError(`Optimization option ${name} must be a finite non-negative number`)
    }
  }
  for (const [name, value] of Object.entries(request.options.structure ?? {})) {
    if (value !== undefined && (Number.isFinite(value) === false || value < 0)) {
      throw new RangeError(`Structure option ${name} must be a finite non-negative number`)
    }
  }
  resolveSizes(request.options).forEach((size) => {
    validatePositiveInteger(size.width, 'Canvas width')
    validatePositiveInteger(size.height, 'Canvas height')
    if (size.width > maxCanvasSide || size.height > maxCanvasSide
      || size.width * size.height > maxCanvasCells) {
      throw new RangeError('Canvas size exceeds the MVP processing limit')
    }
  })
  const baseline = request.options.baseline ?? 'mvp'
  if (resolveSizes(request.options).length * resolveStyles(request.options, baseline).length
    > maxGeneratedCandidates) {
    throw new RangeError('Generated candidate count exceeds the MVP processing limit')
  }
}

function resolvedCrop(request: PatternGenerationRequest): CropRect | undefined {
  const analysis = request.analysis
  const crop = analysis?.suggestedCrop
  if (analysis === undefined || crop === undefined) return undefined
  if (analysis.suggestedCropSource === 'manual') return crop
  const hasAutomaticMetadata = analysis.suggestedCropSource === 'automatic'
    || analysis.suggestedCropConfidence !== undefined
    || analysis.confidence !== undefined
  if (hasAutomaticMetadata === false) return crop
  const confidence = (analysis.suggestedCropConfidence ?? 1) * (analysis.confidence ?? 1)
  return confidence >= 0.5 ? crop : undefined
}

function resolveSizes(options: PatternOptions): readonly GridSize[] {
  if (options.canvas?.mode === 'fixed') {
    return [options.canvas.size]
  }
  if (options.canvas?.mode === 'auto') {
    const unique = new Map<string, GridSize>()
    for (const size of options.canvas.candidates) {
      unique.set(`${size.width}x${size.height}`, size)
    }
    if (unique.size === 0) {
      throw new RangeError('Automatic canvas requires at least one candidate')
    }
    return [...unique.values()].sort(
      (first, second) => first.width * first.height - second.width * second.height
        || first.width - second.width
        || first.height - second.height,
    )
  }
  if (options.width !== undefined && options.height !== undefined) {
    return [{ width: options.width, height: options.height }]
  }
  throw new RangeError('Canvas options or legacy width and height are required')
}

function resolveStyles(options: PatternOptions, baseline: BaselineMode): readonly PatternStyle[] {
  if (baseline !== 'mvp') return ['faithful']
  const styles = options.styles ?? defaultStyles
  if (styles.length === 0) throw new RangeError('At least one style is required')
  return [...new Set(styles)]
}

function resolveResizeMethod(options: PatternOptions, baseline: BaselineMode): ResizeMethod {
  if (baseline === 'a0') return 'nearest'
  if (baseline === 'a1') return 'area'
  return options.resizeMethod ?? 'area'
}

function resolveDistanceMethod(options: PatternOptions, baseline: BaselineMode): ColorDistanceMethod {
  if (baseline === 'a0') return 'delta-e-76'
  return options.colorDistanceMethod ?? 'delta-e-2000'
}

function styleColorLimit(style: PatternStyle, maximum: number): number {
  const factor: Record<PatternStyle, number> = {
    faithful: 1,
    cute: 0.9,
    simple: 0.65,
    'high-contrast': 0.85,
    soft: 0.8,
  }
  return Math.max(1, Math.round(maximum * factor[style]))
}

function buildImportanceWeights(
  analysis: ImageAnalysis | undefined,
  sourceGuidance: SourceGuidance,
  crop: CropRect,
  width: number,
  height: number,
  fit: CanvasFit,
  activeMask: Uint8Array,
): readonly number[] {
  const weights: number[] = Array.from(activeMask, (active) => active === 1 ? 1 : 0)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      const sourcePoint = sourcePointForGridCell(crop, fit, x, y)
      if (sourcePoint === undefined) continue
      const sourceX = clamp(Math.round(sourcePoint[0]), 0, sourceGuidance.width - 1)
      const sourceY = clamp(Math.round(sourcePoint[1]), 0, sourceGuidance.height - 1)
      weights[index] = 0.75 + 1.25 * clamp(
        sourceGuidance.importance[sourceY * sourceGuidance.width + sourceX] ?? 0,
        0,
        1,
      )
    }
  }
  for (const landmark of analysis?.landmarks ?? []) {
    if (landmark.x < crop.x || landmark.y < crop.y
      || landmark.x >= crop.x + crop.width || landmark.y >= crop.y + crop.height) continue
    const confidence = landmarkEffectiveConfidence(landmark, analysis?.confidence ?? 1)
    if (confidence <= 0) continue
    const [gridX, gridY] = gridCellForSourcePoint(crop, fit, landmark.x, landmark.y)
    const radius = landmarkGridRadiusCells(landmark, crop, fit)
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        const x = gridX + offsetX
        const y = gridY + offsetY
        const index = y * width + x
        if (x >= 0 && y >= 0 && x < width && y < height && activeMask[index] === 1) {
          weights[index] = Math.max(
            weights[index] ?? 1,
            1 + (landmark.priority === 'hard' ? 2 : 1) * confidence,
          )
        }
      }
    }
  }
  return weights
}

function gridRegionIds(
  analysis: ImageAnalysis | undefined,
  crop: CropRect,
  width: number,
  height: number,
  fit: CanvasFit,
  activeMask: Uint8Array,
): readonly (string | undefined)[] {
  const ids: Array<string | undefined> = new Array(width * height)
  const regions = analysis?.semanticRegions ?? []
  if (regions.length === 0) return ids
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      if (activeMask[index] !== 1) continue
      const sourcePoint = sourcePointForGridCell(crop, fit, x, y)
      if (sourcePoint === undefined) continue
      const sourceX = clamp(Math.round(sourcePoint[0]), 0, regions[0]!.mask.width - 1)
      const sourceY = clamp(Math.round(sourcePoint[1]), 0, regions[0]!.mask.height - 1)
      let bestScore = 0.4
      for (const region of regions) {
        const score = (region.mask.values[sourceY * region.mask.width + sourceX] ?? 0)
          * region.confidence
          * (analysis?.confidence ?? 1)
        if (score > bestScore) {
          bestScore = score
          ids[index] = region.id
        }
      }
    }
  }
  return ids
}

function protectedCells(
  analysis: ImageAnalysis | undefined,
  crop: CropRect,
  width: number,
  height: number,
  fit: CanvasFit,
  activeMask: Uint8Array,
): ReadonlySet<number> {
  const cells = new Set<number>()
  const analysisConfidence = analysis?.confidence ?? 1
  for (const landmark of analysis?.landmarks ?? []) {
    if (landmark.priority !== 'hard'
      || landmarkEffectiveConfidence(landmark, analysisConfidence) < 0.5) continue
    if (landmark.x < crop.x || landmark.y < crop.y
      || landmark.x >= crop.x + crop.width || landmark.y >= crop.y + crop.height) continue
    const [centerX, centerY] = gridCellForSourcePoint(crop, fit, landmark.x, landmark.y)
    const radius = landmarkGridRadiusCells(landmark, crop, fit)
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        const x = centerX + offsetX
        const y = centerY + offsetY
        const index = y * width + x
        if (x >= 0 && y >= 0 && x < width && y < height && activeMask[index] === 1) {
          cells.add(index)
        }
      }
    }
  }
  return cells
}

function selectPalette(
  pixelLabs: readonly Lab[],
  weights: readonly number[],
  colors: readonly PreparedColor[],
  maximum: number,
  distanceMethod: ColorDistanceMethod,
): readonly PreparedColor[] {
  const limit = Math.min(maximum, colors.length)
  if (colors.length <= limit) return colors
  const distanceMatrix = colors.map((color) => Float32Array.from(
    pixelLabs.map((pixelLab) => colorDistance(pixelLab, color.lab, distanceMethod)),
  ))
  const selectedIndices = new Set<number>()
  const bestDistances = new Array<number>(pixelLabs.length).fill(Number.POSITIVE_INFINITY)
  while (selectedIndices.size < limit) {
    let bestColorIndex = -1
    let bestCost = Number.POSITIVE_INFINITY
    for (let colorIndex = 0; colorIndex < colors.length; colorIndex += 1) {
      if (selectedIndices.has(colorIndex)) continue
      let cost = 0
      for (let index = 0; index < pixelLabs.length; index += 1) {
        const candidateDistance = distanceMatrix[colorIndex]![index]!
        cost += Math.min(bestDistances[index]!, candidateDistance) * (weights[index] ?? 1)
      }
      const colorId = colors[colorIndex]!.id
      const bestColorId = bestColorIndex >= 0 ? colors[bestColorIndex]!.id : ''
      if (cost < bestCost || (cost === bestCost && colorId.localeCompare(bestColorId) < 0)) {
        bestCost = cost
        bestColorIndex = colorIndex
      }
    }
    if (bestColorIndex < 0) break
    selectedIndices.add(bestColorIndex)
    for (let index = 0; index < pixelLabs.length; index += 1) {
      bestDistances[index] = Math.min(
        bestDistances[index]!,
        distanceMatrix[bestColorIndex]![index]!,
      )
    }
  }
  return colors.filter((_color, index) => selectedIndices.has(index))
}

function assignGrid(
  pixels: readonly RGB[],
  pixelLabs: readonly Lab[],
  colors: readonly PreparedColor[],
  baseline: BaselineMode,
  distanceMethod: ColorDistanceMethod,
): AssignedGrid {
  const colorIds: string[] = []
  for (let index = 0; index < pixels.length; index += 1) {
    let bestColor = colors[0]!
    let bestDistance = Number.POSITIVE_INFINITY
    for (const color of colors) {
      const distance = baseline === 'a0'
        ? rgbDistance(pixels[index]!, color.rgb)
        : colorDistance(pixelLabs[index]!, color.lab, distanceMethod)
      if (distance < bestDistance || (distance === bestDistance && color.id.localeCompare(bestColor.id) < 0)) {
        bestDistance = distance
        bestColor = color
      }
    }
    colorIds.push(bestColor.id)
  }
  return { colorIds }
}

function materialCounts(
  colorIds: readonly string[],
  palette: readonly PreparedColor[],
  activeMask: Uint8Array,
): readonly MaterialCount[] {
  const counts = new Map<string, number>()
  for (let index = 0; index < colorIds.length; index += 1) {
    if (activeMask[index] !== 1) continue
    const colorId = colorIds[index]!
    counts.set(colorId, (counts.get(colorId) ?? 0) + 1)
  }
  return palette
    .filter((color) => counts.has(color.id))
    .map((color) => ({ colorId: color.id, count: counts.get(color.id)! }))
}

function finalMeanColorDistance(
  pixelLabs: readonly Lab[],
  colorIds: readonly string[],
  palette: readonly PreparedColor[],
  activeMask: Uint8Array,
): number {
  const colorsById = new Map(palette.map((color) => [color.id, color]))
  let total = 0
  let count = 0
  for (let index = 0; index < colorIds.length; index += 1) {
    if (activeMask[index] !== 1) continue
    const color = colorsById.get(colorIds[index]!)
    if (color === undefined) throw new RangeError('Generated grid references an unknown palette color')
    total += colorDistance(pixelLabs[index]!, color.lab, 'delta-e-2000')
    count += 1
  }
  return total / Math.max(1, count)
}

function boundaryAgreement(
  pixelLabs: readonly Lab[],
  colorIds: readonly string[],
  width: number,
  height: number,
  activeMask: Uint8Array,
): number {
  let agreements = 0
  let comparisons = 0
  const compare = (first: number, second: number): void => {
    if (activeMask[first] !== 1 || activeMask[second] !== 1) return
    const sourceEdge = colorDistance(pixelLabs[first]!, pixelLabs[second]!, 'delta-e-76') >= 12
    const patternEdge = colorIds[first] !== colorIds[second]
    if (sourceEdge === patternEdge) agreements += 1
    comparisons += 1
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const current = y * width + x
      if (x + 1 < width) compare(current, current + 1)
      if (y + 1 < height) compare(current, current + width)
    }
  }
  return comparisons === 0 ? 1 : agreements / comparisons
}

interface FeatureVisibilityResult {
  score: number
  confidence: number
  coverage: number
  purity: number
  connectivity: number
  localContrast: number
  valid: boolean
  rejectionReasons: readonly string[]
}

function connectedFeatureRatio(
  featureCells: ReadonlySet<number>,
  center: number,
  width: number,
): number {
  if (featureCells.size === 0 || featureCells.has(center) === false) return 0
  const visited = new Set<number>([center])
  const queue = [center]
  while (queue.length > 0) {
    const current = queue.pop()!
    const x = current % width
    const candidates = [current - width, current + width]
    if (x > 0) candidates.push(current - 1)
    if (x + 1 < width) candidates.push(current + 1)
    for (const next of candidates) {
      if (featureCells.has(next) && visited.has(next) === false) {
        visited.add(next)
        queue.push(next)
      }
    }
  }
  return visited.size / featureCells.size
}

function sourceRgbAt(
  request: PatternGenerationRequest,
  x: number,
  y: number,
): RGB {
  const sourceX = clamp(Math.round(x), 0, request.image.width - 1)
  const sourceY = clamp(Math.round(y), 0, request.image.height - 1)
  const index = (sourceY * request.image.width + sourceX) * 4
  const alpha = (request.image.data[index + 3] ?? 255) / 255
  const background = request.options.backgroundRgb ?? [255, 255, 255]
  return [0, 1, 2].map((channel) => Math.round(
    (request.image.data[index + channel] ?? 0) * alpha + background[channel]! * (1 - alpha),
  )) as unknown as RGB
}

function featureVisibility(
  request: PatternGenerationRequest,
  analysis: ImageAnalysis | undefined,
  crop: CropRect,
  width: number,
  height: number,
  fit: CanvasFit,
  colorIds: readonly string[],
  palette: readonly PreparedColor[],
  activeMask: Uint8Array,
  regionIds: readonly (string | undefined)[],
): FeatureVisibilityResult {
  const analysisConfidence = analysis?.confidence ?? 1
  const landmarks = (analysis?.landmarks ?? []).filter((landmark) =>
    landmarkEffectiveConfidence(landmark, analysisConfidence) > 0
      && landmark.x >= crop.x && landmark.y >= crop.y
      && landmark.x < crop.x + crop.width && landmark.y < crop.y + crop.height,
  )
  if (landmarks.length === 0) {
    return {
      score: 0,
      confidence: 0,
      coverage: 0,
      purity: 0,
      connectivity: 0,
      localContrast: 0,
      valid: true,
      rejectionReasons: [],
    }
  }
  const colorsById = new Map(palette.map((color) => [color.id, color]))
  const evaluated = landmarks.map((landmark) => {
    const [centerX, centerY] = gridCellForSourcePoint(crop, fit, landmark.x, landmark.y)
    const center = centerY * width + centerX
    const colorId = colorIds[center]
    const color = colorId === undefined ? undefined : colorsById.get(colorId)
    if (activeMask[center] !== 1 || color === undefined) {
      const enforced = landmark.priority === 'hard'
        && landmarkEffectiveConfidence(landmark, analysisConfidence) >= 0.5
      return {
        landmark,
        cell: center,
        area: 0,
        score: 0,
        coverage: 0,
        purity: 0,
        connectivity: 0,
        contrastScore: 0,
        sourceMatch: 0,
        valid: enforced === false,
        rejectionReasons: enforced ? ['hard-feature-missing'] : [],
      }
    }
    const radius = landmarkGridRadiusCells(landmark, crop, fit)
    const regionCells: number[] = []
    const matchingCells = new Set<number>()
    const neighborCells: number[] = []
    const carrierRegionId = regionIds[center]
    for (let offsetY = -radius - 1; offsetY <= radius + 1; offsetY += 1) {
      for (let offsetX = -radius - 1; offsetX <= radius + 1; offsetX += 1) {
        const x = centerX + offsetX
        const y = centerY + offsetY
        if (x < 0 || y < 0 || x >= width || y >= height) continue
        const index = y * width + x
        if (activeMask[index] !== 1) continue
        const insideFeature = Math.abs(offsetX) <= radius && Math.abs(offsetY) <= radius
        if (insideFeature) {
          regionCells.push(index)
          if (colorIds[index] === colorId) matchingCells.add(index)
        } else if (carrierRegionId === undefined || regionIds[index] === carrierRegionId) {
          neighborCells.push(index)
        }
      }
    }
    const minimumCells = radius === 0 ? 1 : Math.max(2, Math.ceil(regionCells.length * 0.4))
    const coverage = clamp(matchingCells.size / minimumCells, 0, 1)
    const purity = matchingCells.size / Math.max(1, regionCells.length)
    const connectivity = connectedFeatureRatio(matchingCells, center, width)
    const contrast = neighborCells.length === 0 ? 0 : neighborCells.reduce((sum, index) => {
      const neighbor = colorsById.get(colorIds[index]!)
      return sum + (neighbor === undefined ? 0 : colorDistance(color.lab, neighbor.lab, 'delta-e-2000'))
    }, 0) / neighborCells.length
    const contrastScore = clamp(contrast / 24, 0, 1)
    const sourceMatch = 1 / (1 + colorDistance(
      rgbToLab(sourceRgbAt(request, landmark.x, landmark.y)),
      color.lab,
      'delta-e-2000',
    ) / 15)
    const rejectionReasons: string[] = []
    if (landmark.priority === 'hard'
      && landmarkEffectiveConfidence(landmark, analysisConfidence) >= 0.5) {
      if (coverage < 0.75 || purity < 0.35) rejectionReasons.push('hard-feature-area')
      if (connectivity < 0.75) rejectionReasons.push('hard-feature-fragmented')
      if (contrastScore < 0.2) rejectionReasons.push('hard-feature-low-contrast')
      if (sourceMatch < 0.35) rejectionReasons.push('hard-feature-source-mismatch')
    }
    return {
      landmark,
      cell: center,
      area: matchingCells.size,
      score: sourceMatch * (
        coverage * 0.25
        + purity * 0.2
        + connectivity * 0.2
        + contrastScore * 0.35
      ),
      coverage,
      purity,
      connectivity,
      contrastScore,
      sourceMatch,
      valid: rejectionReasons.length === 0,
      rejectionReasons,
    }
  })
  const baseScore = evaluated.reduce((sum, entry) => sum + entry.score, 0) / evaluated.length
  const symmetryGroups = new Map<string, typeof evaluated>()
  for (const entry of evaluated) {
    if (entry.landmark.symmetryGroup === undefined) continue
    const group = symmetryGroups.get(entry.landmark.symmetryGroup) ?? []
    group.push(entry)
    symmetryGroups.set(entry.landmark.symmetryGroup, group)
  }
  const hardCollision = [...symmetryGroups.values()].some((group) =>
    group.some((entry) => entry.landmark.priority === 'hard'
      && landmarkEffectiveConfidence(entry.landmark, analysisConfidence) >= 0.5)
      && new Set(group.map((entry) => entry.cell)).size < group.length)
  const groupScores = [...symmetryGroups.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const uniqueRatio = new Set(group.map((entry) => entry.cell)).size / group.length
      const areas = group.map((entry) => entry.area)
      const maximumArea = Math.max(...areas, 1)
      const minimumArea = Math.min(...areas)
      return uniqueRatio * (minimumArea / maximumArea)
    })
  const symmetryScore = groupScores.length === 0
    ? baseScore
    : groupScores.reduce((sum, score) => sum + score, 0) / groupScores.length
  const confidence = evaluated.reduce((sum, entry) =>
    sum + landmarkEffectiveConfidence(entry.landmark, analysisConfidence), 0) / evaluated.length
  const rejectionReasons = new Set(evaluated.flatMap((entry) => entry.rejectionReasons))
  if (hardCollision) rejectionReasons.add('hard-feature-collision')
  return {
    score: clamp(baseScore * 0.85 + symmetryScore * 0.15, 0, 1),
    confidence: clamp(confidence, 0, 1),
    coverage: evaluated.reduce((sum, entry) => sum + entry.coverage, 0) / evaluated.length,
    purity: evaluated.reduce((sum, entry) => sum + entry.purity, 0) / evaluated.length,
    connectivity: evaluated.reduce((sum, entry) => sum + entry.connectivity, 0) / evaluated.length,
    localContrast: evaluated.reduce((sum, entry) => sum + entry.contrastScore, 0) / evaluated.length,
    valid: evaluated.every((entry) => entry.valid) && hardCollision === false,
    rejectionReasons: [...rejectionReasons].sort(),
  }
}

function scoreCandidate(
  style: PatternStyle,
  totalCells: number,
  maxColors: number,
  sourceMeanColorDistance: number,
  planMeanColorDistance: number,
  structure: number,
  feature: FeatureVisibilityResult,
  isolatedCells: number,
  thinStripes: number,
  uniqueColors: number,
): CandidateScore {
  const sourceFidelity = 1 / (1 + sourceMeanColorDistance / 15)
  const planFidelity = 1 / (1 + planMeanColorDistance / 15)
  const colorFidelity = planFidelity
  const featureProtection = feature.score
  const cleanliness = clamp(1 - (isolatedCells * 2 + thinStripes) / Math.max(1, totalCells), 0, 1)
  const craftEase = clamp(
    1 - uniqueColors / Math.max(1, maxColors) * 0.25 - isolatedCells / Math.max(1, totalCells),
    0,
    1,
  )
  const beadCostScore = 1 / (1 + totalCells / 1024)
  const canvasFit = beadCostScore
  const styleBias: Record<PatternStyle, number> = {
    faithful: 0.015,
    cute: 0,
    simple: 0.01,
    'high-contrast': 0.005,
    soft: 0,
  }
  const featureWeight = 0.18 * feature.confidence
  const weightedTotal = sourceFidelity * 0.18
    + planFidelity * 0.09
    + structure * 0.22
    + featureProtection * featureWeight
    + cleanliness * 0.14
    + craftEase * 0.11
    + canvasFit * 0.08
  const total = clamp(weightedTotal / (0.82 + featureWeight) + styleBias[style], 0, 1)
  return {
    total,
    colorFidelity,
    sourceFidelity,
    planFidelity,
    structure,
    featureProtection,
    featureProtectionConfidence: feature.confidence,
    cleanliness,
    craftEase,
    canvasFit,
  }
}

function metadata(
  request: PatternGenerationRequest,
  version: string,
  style: PatternStyle,
  baseline: BaselineMode,
  totalBeads: number,
  generatedAt: number,
): PatternMetadata {
  const result: PatternMetadata = {
    sourceWidth: request.image.width,
    sourceHeight: request.image.height,
    totalBeads,
    generatedAt,
    algorithmVersion: version,
    aiEnhanced: Boolean(request.options.aiEnhancement && request.analysis !== undefined),
    style,
    baseline,
    engine: 'baseline',
  }
  if (request.options.beadDiameterMm !== undefined) {
    result.beadDiameterMm = request.options.beadDiameterMm
  }
  return result
}

function generateCandidate(
  context: CandidateContext,
  version: string,
  clock: () => number,
): PatternCandidate {
  const startedAt = performance.now()
  const { request, crop, size, style, baseline, resizeMethod, distanceMethod } = context
  const structureOptions = request.options.structure ?? {}
  const resized = resizePixels(
    request.image,
    crop,
    size.width,
    size.height,
    resizeMethod,
    request.options.backgroundRgb,
    baseline === 'mvp' ? {
      source: context.sourceGuidance,
      importanceStrength: Math.max(0, structureOptions.importanceStrength ?? 4),
      edgeStrength: Math.max(0, structureOptions.edgeStrength ?? 1.25),
    } : undefined,
  )
  const rawResized = baseline === 'mvp'
    ? resizePixels(
      request.image,
      crop,
      size.width,
      size.height,
      resizeMethod,
      request.options.backgroundRgb,
    )
    : resized
  const weights = buildImportanceWeights(
    request.analysis,
    context.sourceGuidance,
    crop,
    size.width,
    size.height,
    resized.fit,
    resized.activeMask,
  )
  const sourceLabs = rawResized.pixels.map(rgbToLab)
  const styledPixels = resized.pixels.map((pixel) => applyStyle(pixel, style))
  const valueLevels = structureOptions.valueLevels
    ?? (style === 'simple' ? 2 : 3)
  const regionIds = gridRegionIds(
    request.analysis,
    crop,
    size.width,
    size.height,
    resized.fit,
    resized.activeMask,
  )
  const pixels = baseline === 'mvp'
    ? designRegionValues(
      styledPixels,
      resized.activeMask,
      valueLevels,
      weights,
      regionIds,
    )
    : styledPixels
  const pixelLabs = pixels.map(rgbToLab)
  const maximumColors = styleColorLimit(
    style,
    Math.min(request.options.maxColors, context.preparedPalette.length),
  )
  const selectedPalette = selectPalette(
    pixelLabs,
    weights,
    context.preparedPalette,
    maximumColors,
    distanceMethod,
  )
  const assigned = assignGrid(pixels, pixelLabs, selectedPalette, baseline, distanceMethod)
  const protectedSet = protectedCells(
    request.analysis,
    crop,
    size.width,
    size.height,
    resized.fit,
    resized.activeMask,
  )
  const paletteOptimization = baseline === 'mvp'
    ? optimizePaletteAssignments({
      pixelLabs,
      initialColorIds: assigned.colorIds,
      colors: selectedPalette,
      width: size.width,
      height: size.height,
      activeMask: resized.activeMask,
      importance: weights,
      protectedCells: protectedSet,
      coherence: Math.max(0, request.options.optimization?.paletteCoherence ?? 1.15),
      edgeProtection: clamp(request.options.optimization?.edgeProtection ?? 0.8, 0, 1),
      iterations: Math.max(0, Math.floor(request.options.optimization?.localSearchIterations ?? 2)),
      distanceMethod,
    })
    : { colorIds: assigned.colorIds, changedCells: 0 }
  const paletteEdits = paletteOptimization.colorIds.flatMap((colorId, index) => {
    const fromColorId = assigned.colorIds[index]
    if (resized.activeMask[index] !== 1 || fromColorId === undefined || fromColorId === colorId) return []
    return [{
      x: index % size.width,
      y: Math.floor(index / size.width),
      fromColorId,
      toColorId: colorId,
      reason: 'palette-coherence' as const,
    }]
  })
  const optimizationOptions = baseline === 'mvp'
    ? {
      ...request.options.optimization,
      stripePenalty: request.options.optimization?.stripePenalty ?? 1,
      aliasPenalty: request.options.optimization?.aliasPenalty ?? 1,
    }
    : request.options.optimization
  const optimization = baseline === 'a0'
    ? { colorIds: assigned.colorIds, edits: [], removedSmallRegions: 0, topologyEdits: 0 }
    : optimizeGrid(
      paletteOptimization.colorIds,
      size.width,
      size.height,
      protectedSet,
      optimizationOptions,
      resized.activeMask,
    )
  const counts = materialCounts(optimization.colorIds, selectedPalette, resized.activeMask)
  const usedIds = new Set(counts.map((entry) => entry.colorId))
  const usedPalette = selectedPalette.filter((color) => usedIds.has(color.id))
  const cells: PatternCell[] = []
  for (let index = 0; index < optimization.colorIds.length; index += 1) {
    if (resized.activeMask[index] !== 1) continue
    cells.push({
      x: index % size.width,
      y: Math.floor(index / size.width),
      colorId: optimization.colorIds[index]!,
    })
  }
  const isolatedCells = countIsolatedCells(
    optimization.colorIds,
    size.width,
    size.height,
    resized.activeMask,
  )
  const thinStripes = countThinStripes(
    optimization.colorIds,
    size.width,
    size.height,
    resized.activeMask,
  )
  const sourceBoundaryAgreement = boundaryAgreement(
    sourceLabs,
    optimization.colorIds,
    size.width,
    size.height,
    resized.activeMask,
  )
  const planBoundaryAgreement = boundaryAgreement(
    pixelLabs,
    optimization.colorIds,
    size.width,
    size.height,
    resized.activeMask,
  )
  const structure = sourceBoundaryAgreement * 0.65 + planBoundaryAgreement * 0.35
  const planMeanColorDistance = finalMeanColorDistance(
    pixelLabs,
    optimization.colorIds,
    selectedPalette,
    resized.activeMask,
  )
  const sourceMeanColorDistance = finalMeanColorDistance(
    sourceLabs,
    optimization.colorIds,
    selectedPalette,
    resized.activeMask,
  )
  const totalBeads = cells.length
  const visibility = featureVisibility(
    request,
    request.analysis,
    crop,
    size.width,
    size.height,
    resized.fit,
    optimization.colorIds,
    selectedPalette,
    resized.activeMask,
    regionIds,
  )
  const score = scoreCandidate(
    style,
    totalBeads,
    request.options.maxColors,
    sourceMeanColorDistance,
    planMeanColorDistance,
    structure,
    visibility,
    isolatedCells,
    thinStripes,
    counts.length,
  )
  const identity = stableSerialize({
    engine: 'baseline',
    version,
    size,
    style,
    baseline,
    crop,
    resizeMethod,
    distanceMethod,
    maxColors: request.options.maxColors,
    palette: selectedPalette.map((color) => color.id),
    landmarks: request.analysis?.landmarks?.map((landmark) => ({
      id: landmark.id,
      kind: landmark.kind,
      x: landmark.x,
      y: landmark.y,
      priority: landmark.priority,
      sourceRadiusPx: landmark.sourceRadiusPx ?? landmark.radius ?? 0,
      gridRadiusCells: landmark.gridRadiusCells ?? landmark.radius ?? 0,
    })) ?? [],
    structure: request.options.structure ?? {},
    optimization: request.options.optimization ?? {},
  })
  return {
    id: `${size.width}x${size.height}-${style}-${baseline}-${stableHash(identity)}`,
    style,
    valid: visibility.valid,
    rejectionReasons: visibility.rejectionReasons,
    pattern: {
      width: size.width,
      height: size.height,
      palette: usedPalette,
      cells,
      metadata: metadata(request, version, style, baseline, totalBeads, clock()),
    },
    materialCounts: counts,
    metrics: {
      processingTimeMs: Math.max(0, performance.now() - startedAt),
      uniqueColors: counts.length,
      removedSmallRegions: optimization.removedSmallRegions,
      totalBeads,
      meanColorDistance: planMeanColorDistance,
      sourceMeanColorDistance,
      planMeanColorDistance,
      isolatedCells,
      thinStripes,
      featureExpressibility: visibility.score,
      featureVisibilityConfidence: visibility.confidence,
      featureCoverage: visibility.coverage,
      featurePurity: visibility.purity,
      featureConnectivity: visibility.connectivity,
      featureLocalContrast: visibility.localContrast,
      sourceBoundaryAgreement,
      planBoundaryAgreement,
      paletteOptimizationChanges: paletteOptimization.changedCells,
      topologyEdits: optimization.topologyEdits,
    },
    score,
    edits: [...paletteEdits, ...optimization.edits],
  }
}

function evaluateCandidates(candidates: readonly PatternCandidate[]): CandidateEvaluation {
  return {
    rankedCandidateIds: candidates.map((candidate) => candidate.id),
    scores: Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate.score])),
  }
}

export class DeterministicPatternAlgorithm {
  readonly version: string
  readonly engine: AlgorithmEngine
  readonly #clock: () => number

  constructor(config: { version?: string; clock?: () => number }) {
    this.engine = 'baseline'
    this.version = config.version ?? '0.2.2-baseline'
    this.#clock = config.clock ?? Date.now
  }

  async generate(request: PatternGenerationRequest): Promise<PatternGenerationResult> {
    validateRequest(request)
    const baseline = request.options.baseline ?? 'mvp'
    const sizes = resolveSizes(request.options)
    const styles = resolveStyles(request.options, baseline)
    const crop = normalizeCrop(request.image, resolvedCrop(request))
    const preparedPalette = prepareColors(request.palette.colors)
    const sourceGuidance = buildSourceGuidance(
      request.image,
      request.analysis,
      request.options.backgroundRgb,
    )
    const resizeMethod = resolveResizeMethod(request.options, baseline)
    const distanceMethod = resolveDistanceMethod(request.options, baseline)
    const candidates: PatternCandidate[] = []
    for (const size of sizes) {
      for (const style of styles) {
        candidates.push(generateCandidate({
          request,
          crop,
          size,
          style,
          baseline,
          resizeMethod,
          distanceMethod,
          preparedPalette,
          sourceGuidance,
        }, this.version, this.#clock))
      }
    }
    candidates.sort((first, second) => Number(second.valid) - Number(first.valid)
      || second.score.total - first.score.total
      || first.id.localeCompare(second.id))
    const maximumCandidates = Math.max(1, Math.floor(request.options.maxCandidates ?? 5))
    const ranked = candidates.slice(0, maximumCandidates)
    const recommended = ranked[0]!
    return {
      pattern: recommended.pattern,
      materialCounts: recommended.materialCounts,
      metrics: recommended.metrics,
      recommended,
      alternatives: ranked.slice(1),
      evaluation: evaluateCandidates(ranked),
    }
  }

  async adapt(request: PatternAdaptationRequest): Promise<PatternAdaptationResult> {
    return adaptPattern(request, this.version, this.#clock())
  }
}
