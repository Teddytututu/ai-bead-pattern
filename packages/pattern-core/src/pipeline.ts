import {
  colorDistance,
  prepareColors,
  rgbDistance,
  rgbToLab,
  type PreparedColor,
} from './color.js'
import {
  countIsolatedCells,
  countThinStripes,
  optimizeGrid,
} from './grid.js'
import { applyStyle, normalizeCrop, resizePixels } from './image.js'
import type {
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
}

interface AssignedGrid {
  colorIds: readonly string[]
  meanColorDistance: number
}

const defaultStyles: readonly PatternStyle[] = ['faithful', 'simple', 'high-contrast']
const maxImagePixels = 50_000_000
const maxCanvasSide = 256
const maxCanvasCells = 65_536
const maxPaletteColors = 512
const maxCanvasCandidates = 16

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
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
  valuesLength: number,
  imageWidth: number,
  imageHeight: number,
  label: string,
): void {
  if (width !== imageWidth || height !== imageHeight || valuesLength !== width * height) {
    throw new RangeError(`${label} must align with the source image`)
  }
}

function validateRequest(request: PatternGenerationRequest): void {
  validatePositiveInteger(request.image.width, 'Image width')
  validatePositiveInteger(request.image.height, 'Image height')
  if (request.image.data.length !== request.image.width * request.image.height * 4) {
    throw new RangeError('RGBA data length must equal width * height * 4')
  }
  if (request.image.width * request.image.height > maxImagePixels) {
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
      analysis.subjectMask.values.length,
      request.image.width,
      request.image.height,
      'Subject mask',
    )
  }
  if (analysis?.importanceMap !== undefined) {
    validateMask(
      analysis.importanceMap.width,
      analysis.importanceMap.height,
      analysis.importanceMap.weights.length,
      request.image.width,
      request.image.height,
      'Importance map',
    )
  }
  for (const region of analysis?.semanticRegions ?? []) {
    validateMask(
      region.mask.width,
      region.mask.height,
      region.mask.values.length,
      request.image.width,
      request.image.height,
      `Semantic region ${region.id}`,
    )
  }
  for (const landmark of analysis?.landmarks ?? []) {
    if ([landmark.x, landmark.y, landmark.confidence, landmark.radius ?? 0]
      .some((value) => Number.isFinite(value) === false)) {
      throw new RangeError(`Landmark ${landmark.id} values must be finite`)
    }
  }
  if (analysis?.suggestedCrop !== undefined
    && [analysis.suggestedCrop.x, analysis.suggestedCrop.y,
      analysis.suggestedCrop.width, analysis.suggestedCrop.height]
      .some((value) => Number.isFinite(value) === false)) {
    throw new RangeError('Suggested crop values must be finite')
  }
  validatePositiveInteger(request.options.maxColors, 'maxColors')
  if (request.options.maxColors > 256) {
    throw new RangeError('maxColors exceeds the MVP processing limit')
  }
  if (request.options.canvas?.mode === 'auto'
    && request.options.canvas.candidates.length > maxCanvasCandidates) {
    throw new RangeError('Canvas candidates exceed the MVP processing limit')
  }
  resolveSizes(request.options).forEach((size) => {
    validatePositiveInteger(size.width, 'Canvas width')
    validatePositiveInteger(size.height, 'Canvas height')
    if (size.width > maxCanvasSide || size.height > maxCanvasSide
      || size.width * size.height > maxCanvasCells) {
      throw new RangeError('Canvas size exceeds the MVP processing limit')
    }
  })
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
  crop: CropRect,
  width: number,
  height: number,
): readonly number[] {
  const weights = new Array<number>(width * height).fill(1)
  const importance = analysis?.importanceMap
  if (importance !== undefined
    && importance.weights.length === importance.width * importance.height
    && importance.width > 0
    && importance.height > 0) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const sourceX = clamp(
          Math.floor(crop.x + (x + 0.5) * crop.width / width),
          0,
          importance.width - 1,
        )
        const sourceY = clamp(
          Math.floor(crop.y + (y + 0.5) * crop.height / height),
          0,
          importance.height - 1,
        )
        weights[y * width + x] = 0.5 + 1.5 * clamp(
          importance.weights[sourceY * importance.width + sourceX] ?? 0,
          0,
          1,
        )
      }
    }
  }
  for (const landmark of analysis?.landmarks ?? []) {
    if (landmark.x < crop.x || landmark.y < crop.y
      || landmark.x >= crop.x + crop.width || landmark.y >= crop.y + crop.height) continue
    const gridX = clamp(Math.floor((landmark.x - crop.x) / crop.width * width), 0, width - 1)
    const gridY = clamp(Math.floor((landmark.y - crop.y) / crop.height * height), 0, height - 1)
    const radius = Math.max(0, Math.round(landmark.radius ?? 1))
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        const x = gridX + offsetX
        const y = gridY + offsetY
        if (x >= 0 && y >= 0 && x < width && y < height) {
          weights[y * width + x] = Math.max(
            weights[y * width + x] ?? 1,
            landmark.priority === 'hard' ? 3 : 2,
          )
        }
      }
    }
  }
  return weights
}

function protectedCells(
  analysis: ImageAnalysis | undefined,
  crop: CropRect,
  width: number,
  height: number,
): ReadonlySet<number> {
  const cells = new Set<number>()
  for (const landmark of analysis?.landmarks ?? []) {
    if (landmark.priority !== 'hard' || landmark.confidence <= 0) continue
    if (landmark.x < crop.x || landmark.y < crop.y
      || landmark.x >= crop.x + crop.width || landmark.y >= crop.y + crop.height) continue
    const x = clamp(Math.floor((landmark.x - crop.x) / crop.width * width), 0, width - 1)
    const y = clamp(Math.floor((landmark.y - crop.y) / crop.height * height), 0, height - 1)
    cells.add(y * width + x)
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
  let totalDistance = 0
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
    totalDistance += baseline === 'a0'
      ? colorDistance(pixelLabs[index]!, bestColor.lab, 'delta-e-2000')
      : bestDistance
  }
  return { colorIds, meanColorDistance: totalDistance / pixels.length }
}

function materialCounts(colorIds: readonly string[], palette: readonly PreparedColor[]): readonly MaterialCount[] {
  const counts = new Map<string, number>()
  for (const colorId of colorIds) counts.set(colorId, (counts.get(colorId) ?? 0) + 1)
  return palette
    .filter((color) => counts.has(color.id))
    .map((color) => ({ colorId: color.id, count: counts.get(color.id)! }))
}

function finalMeanColorDistance(
  pixelLabs: readonly Lab[],
  colorIds: readonly string[],
  palette: readonly PreparedColor[],
): number {
  const colorsById = new Map(palette.map((color) => [color.id, color]))
  let total = 0
  for (let index = 0; index < colorIds.length; index += 1) {
    const color = colorsById.get(colorIds[index]!)
    if (color === undefined) throw new RangeError('Generated grid references an unknown palette color')
    total += colorDistance(pixelLabs[index]!, color.lab, 'delta-e-2000')
  }
  return total / Math.max(1, colorIds.length)
}

function boundaryAgreement(
  pixelLabs: readonly Lab[],
  colorIds: readonly string[],
  width: number,
  height: number,
): number {
  let agreements = 0
  let comparisons = 0
  const compare = (first: number, second: number): void => {
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

function scoreCandidate(
  style: PatternStyle,
  size: GridSize,
  maxColors: number,
  meanColorDistance: number,
  structure: number,
  hardFeatureCount: number,
  isolatedCells: number,
  thinStripes: number,
  uniqueColors: number,
): CandidateScore {
  const totalCells = size.width * size.height
  const colorFidelity = 1 / (1 + meanColorDistance / 15)
  const featureProtection = hardFeatureCount > 0 ? 1 : 0.85
  const cleanliness = clamp(1 - (isolatedCells * 2 + thinStripes) / Math.max(1, totalCells), 0, 1)
  const craftEase = clamp(
    1 - uniqueColors / Math.max(1, maxColors) * 0.25 - isolatedCells / Math.max(1, totalCells),
    0,
    1,
  )
  const canvasFit = clamp(0.6 + Math.sqrt(totalCells) / 160 - totalCells / 40000, 0, 1)
  const styleBias: Record<PatternStyle, number> = {
    faithful: 0.015,
    cute: 0,
    simple: 0.01,
    'high-contrast': 0.005,
    soft: 0,
  }
  const total = colorFidelity * 0.27
    + structure * 0.22
    + featureProtection * 0.18
    + cleanliness * 0.14
    + craftEase * 0.11
    + canvasFit * 0.08
    + styleBias[style]
  return {
    total,
    colorFidelity,
    structure,
    featureProtection,
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
  const rawPixels = resizePixels(
    request.image,
    crop,
    size.width,
    size.height,
    resizeMethod,
    request.options.backgroundRgb,
  )
  const pixels = rawPixels.map((pixel) => applyStyle(pixel, style))
  const pixelLabs = pixels.map(rgbToLab)
  const weights = buildImportanceWeights(request.analysis, crop, size.width, size.height)
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
  const protectedSet = protectedCells(request.analysis, crop, size.width, size.height)
  const optimization = baseline === 'a0'
    ? { colorIds: assigned.colorIds, edits: [], removedSmallRegions: 0 }
    : optimizeGrid(
      assigned.colorIds,
      size.width,
      size.height,
      protectedSet,
      request.options.optimization,
    )
  const counts = materialCounts(optimization.colorIds, selectedPalette)
  const usedIds = new Set(counts.map((entry) => entry.colorId))
  const usedPalette = selectedPalette.filter((color) => usedIds.has(color.id))
  const cells: PatternCell[] = optimization.colorIds.map((colorId, index) => ({
    x: index % size.width,
    y: Math.floor(index / size.width),
    colorId,
  }))
  const isolatedCells = countIsolatedCells(optimization.colorIds, size.width, size.height)
  const thinStripes = countThinStripes(optimization.colorIds, size.width, size.height)
  const structure = boundaryAgreement(pixelLabs, optimization.colorIds, size.width, size.height)
  const meanColorDistance = finalMeanColorDistance(
    pixelLabs,
    optimization.colorIds,
    selectedPalette,
  )
  const score = scoreCandidate(
    style,
    size,
    request.options.maxColors,
    meanColorDistance,
    structure,
    protectedSet.size,
    isolatedCells,
    thinStripes,
    counts.length,
  )
  const totalBeads = size.width * size.height
  return {
    id: `${size.width}x${size.height}-${style}-${baseline}`,
    style,
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
      meanColorDistance,
      isolatedCells,
      thinStripes,
    },
    score,
    edits: optimization.edits,
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
  readonly #clock: () => number

  constructor(config: { version?: string; clock?: () => number }) {
    this.version = config.version ?? '0.1.0-mvp'
    this.#clock = config.clock ?? Date.now
  }

  async generate(request: PatternGenerationRequest): Promise<PatternGenerationResult> {
    validateRequest(request)
    const baseline = request.options.baseline ?? 'mvp'
    const sizes = resolveSizes(request.options)
    const styles = resolveStyles(request.options, baseline)
    const crop = normalizeCrop(request.image, request.analysis?.suggestedCrop)
    const preparedPalette = prepareColors(request.palette.colors)
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
        }, this.version, this.#clock))
      }
    }
    candidates.sort((first, second) => second.score.total - first.score.total || first.id.localeCompare(second.id))
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
}
