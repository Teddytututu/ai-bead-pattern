import {
  colorDistance,
  prepareColors,
  rgbDistance,
  rgbToLab,
  type PreparedColor,
} from './color.js'
import { adaptPattern } from './adaptation.js'
import {
  normalizeEvidenceProvenance,
  resolvedSubjectMask,
  subjectMaskConfidence,
  subjectMaskTrust,
} from './analysis-evidence.js'
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
  samplePixelsAtSourceMapping,
  sourcePointForGridCell,
  type CanvasFit,
} from './image.js'
import {
  landmarkEffectiveConfidence,
  landmarkGridRadiusCells,
} from './landmarks.js'
import { optimizePaletteAssignments } from './palette-optimization.js'
import { refineGridClusters } from './grid-refinement.js'
import {
  planCanvases,
  planCanvasesWithShapeVariants,
} from './planning/canvas-planner.js'
import {
  createFeatureConstraint,
  searchFeaturePlacements,
  type ResolvedFeaturePlacement,
} from './planning/feature-placement.js'
import { searchFeaturePairs } from './planning/feature-pair-search.js'
import { resolveFeatureColors } from './planning/feature-color-resolver.js'
import { buildStructurePlan } from './planning/structure-planner.js'
import { buildValuePlan } from './planning/value-planner.js'
import { buildPalettePlan } from './planning/palette-planner.js'
import type {
  CanvasPlan,
  OccupancyMode,
  PalettePlan,
  ValuePlan,
  ValueRole,
} from './contracts.js'
import {
  buildSourceShapeModel,
  shapeRasterizationThreshold,
  type ShapeRasterization,
} from './shape.js'
import { ShapeVariantCache } from './planning/shape-variant-cache.js'
import { buildSourceGuidance, designRegionValues, type SourceGuidance } from './structure.js'
import type {
  AlgorithmEngine,
  BaselineMode,
  CandidateEvaluation,
  CandidateScore,
  ColorDistanceMethod,
  CropRect,
  EvidenceProvenance,
  GridSize,
  GenerationTiming,
  ImageAnalysis,
  ImageLandmark,
  LandmarkKind,
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
  shapeRasterization: ShapeRasterization | undefined
  occupancyMode: ResolvedOccupancyMode
  canvasPlan: CanvasPlan
}

type ResolvedOccupancyMode = Extract<OccupancyMode, 'full-frame' | 'subject-shape'>

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
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first ^= code
    first = Math.imul(first, 0x01000193)
    second ^= code + index
    second = Math.imul(second, 0x85ebca6b)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}

async function sha256Hex(data: ArrayBufferView): Promise<string> {
  const bytes = new Uint8Array(data.byteLength)
  bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.buffer)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function sha256Text(value: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(value))
}

export async function arrayFingerprint(values: ArrayLike<number> | undefined): Promise<string | undefined> {
  if (values === undefined) return undefined
  const normalized = new ArrayBuffer(values.length * Float64Array.BYTES_PER_ELEMENT)
  const view = new DataView(normalized)
  for (let index = 0; index < values.length; index += 1) {
    view.setFloat64(index * Float64Array.BYTES_PER_ELEMENT, values[index] ?? 0, false)
  }
  return sha256Hex(new Uint8Array(normalized))
}

async function generationFingerprint(
  request: PatternGenerationRequest,
  version: string,
): Promise<string> {
  const sourceBytes = new Uint8Array(
    request.image.data.buffer,
    request.image.data.byteOffset,
    request.image.data.byteLength,
  )
  const analysis = request.analysis
  const semanticRegions = await Promise.all(
    [...(analysis?.semanticRegions ?? [])]
      .sort((first, second) => first.id.localeCompare(second.id))
      .map(async (region) => ({
        id: region.id,
        label: region.label,
        confidence: region.confidence,
        importance: region.importance,
        provenance: normalizeEvidenceProvenance(region.provenance),
        mask: await arrayFingerprint(region.mask.values),
      })),
  )
  const landmarks = [...(analysis?.landmarks ?? [])]
    .sort((first, second) => first.id.localeCompare(second.id))
    .map((landmark) => ({
      ...landmark,
      provenance: normalizeEvidenceProvenance(landmark.provenance),
    }))
  const subjectMaskEvidence = analysis?.subjectMaskEvidence
  const identity = {
    engine: 'baseline',
    version,
    source: {
      width: request.image.width,
      height: request.image.height,
      hash: await sha256Hex(sourceBytes),
    },
    palette: request.palette,
    analysis: analysis === undefined ? undefined : {
      confidence: analysis.confidence,
      imageType: analysis.imageType,
      modelVersions: analysis.modelVersions,
      suggestedCrop: analysis.suggestedCrop,
      suggestedCropConfidence: analysis.suggestedCropConfidence,
      suggestedCropSource: analysis.suggestedCropSource,
      subjectMask: subjectMaskEvidence === undefined
        ? await arrayFingerprint(analysis.subjectMask?.values)
        : undefined,
      subjectMaskEvidence: subjectMaskEvidence === undefined ? undefined : {
        confidence: subjectMaskEvidence.confidence,
        source: subjectMaskEvidence.source,
        revision: subjectMaskEvidence.revision,
        userConfirmed: subjectMaskEvidence.userConfirmed,
        provenance: normalizeEvidenceProvenance(subjectMaskEvidence.provenance),
        mask: await arrayFingerprint(subjectMaskEvidence.mask.values),
      },
      importanceMap: await arrayFingerprint(analysis.importanceMap?.weights),
      semanticRegions,
      landmarks,
      provenance: normalizeEvidenceProvenance(analysis.provenance),
    },
    options: request.options,
  }
  return (await sha256Text(stableSerialize(identity))).slice(0, 32)
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

function validateEnum(value: string | undefined, allowed: ReadonlySet<string>, label: string): void {
  if (value !== undefined && allowed.has(value) === false) {
    throw new RangeError(`${label} has an unsupported value`)
  }
}

function validateUnitInterval(value: number | undefined, label: string): void {
  if (value !== undefined && (Number.isFinite(value) === false || value < 0 || value > 1)) {
    throw new RangeError(`${label} must stay within 0..1`)
  }
}

function validateProvenance(
  provenance: readonly EvidenceProvenance[] | undefined,
  label: string,
): void {
  for (const entry of provenance ?? []) {
    if (entry.origin !== 'model' && entry.origin !== 'source' && entry.origin !== 'heuristic'
      && entry.origin !== 'manual' && entry.origin !== 'fused') {
      throw new RangeError(`${label} origin has an unsupported value`)
    }
    if (entry.provider.trim().length === 0) {
      throw new RangeError(`${label} provider is required`)
    }
    if (entry.model !== undefined && entry.model.trim().length === 0) {
      throw new RangeError(`${label} model must be non-empty when provided`)
    }
    if (entry.version !== undefined && entry.version.trim().length === 0) {
      throw new RangeError(`${label} version must be non-empty when provided`)
    }
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
  validateEnum(request.options.baseline, new Set(['a0', 'a1', 'mvp']), 'baseline')
  validateEnum(request.options.resizeMethod, new Set(['area', 'bilinear', 'nearest']), 'resizeMethod')
  validateEnum(
    request.options.colorDistanceMethod,
    new Set(['delta-e-76', 'delta-e-2000']),
    'colorDistanceMethod',
  )
  validateEnum(request.options.imageType, new Set(['portrait', 'pet', 'illustration', 'landscape', 'general']), 'imageType')
  for (const style of request.options.styles ?? []) {
    validateEnum(style, new Set(['faithful', 'cute', 'simple', 'high-contrast', 'soft']), 'style')
  }
  if (request.options.structure?.valueLevels !== undefined
    && [2, 3, 4].includes(request.options.structure.valueLevels) === false) {
    throw new RangeError('valueLevels must be 2, 3, or 4')
  }
  validateEnum(
    request.options.structure?.occupancyMode,
    new Set(['auto', 'full-frame', 'subject-shape']),
    'occupancyMode',
  )
  if (request.options.structure?.shapeRefinementIterations !== undefined
    && (Number.isFinite(request.options.structure.shapeRefinementIterations) === false
      || request.options.structure.shapeRefinementIterations < 0
      || Number.isInteger(request.options.structure.shapeRefinementIterations) === false
      || request.options.structure.shapeRefinementIterations > 32)) {
    throw new RangeError('shapeRefinementIterations must be an integer within 0..32')
  }
  if (request.options.beadDiameterMm !== undefined
    && (Number.isFinite(request.options.beadDiameterMm) === false
      || request.options.beadDiameterMm <= 0)) {
    throw new RangeError('beadDiameterMm must be a finite positive number')
  }
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
  const subjectMask = resolvedSubjectMask(analysis)
  if (subjectMask !== undefined) {
    validateMask(
      subjectMask.width,
      subjectMask.height,
      subjectMask.values,
      request.image.width,
      request.image.height,
      'Subject mask',
    )
  }
  if (analysis?.subjectMaskEvidence !== undefined) {
    validateUnitInterval(analysis.subjectMaskEvidence.confidence, 'Subject mask evidence confidence')
    if (analysis.subjectMaskEvidence.revision.trim().length === 0) {
      throw new RangeError('Subject mask evidence revision is required')
    }
    if (['ai', 'alpha', 'heuristic', 'manual', 'ai+manual', 'fused', 'legacy']
      .includes(analysis.subjectMaskEvidence.source) === false) {
      throw new RangeError('Subject mask evidence source has an unsupported value')
    }
    if (analysis.subjectMaskEvidence.userConfirmed !== undefined
      && typeof analysis.subjectMaskEvidence.userConfirmed !== 'boolean') {
      throw new RangeError('Subject mask evidence userConfirmed must be boolean')
    }
    validateProvenance(analysis.subjectMaskEvidence.provenance, 'Subject mask evidence provenance')
  }
  if (request.options.structure?.occupancyMode === 'subject-shape'
    && (subjectMask === undefined
      || subjectMask.values.some(
        (value) => value >= shapeRasterizationThreshold,
      ) === false)) {
    throw new RangeError('subject-shape occupancy requires a non-empty subject mask')
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
  const semanticRegionIds = new Set<string>()
  for (const region of analysis?.semanticRegions ?? []) {
    if (region.id.trim().length === 0 || semanticRegionIds.has(region.id)) {
      throw new RangeError('Semantic region ids must be unique and non-empty')
    }
    semanticRegionIds.add(region.id)
    validateUnitInterval(region.confidence, `Semantic region ${region.id} confidence`)
    validateUnitInterval(region.importance, `Semantic region ${region.id} importance`)
    validateProvenance(region.provenance, `Semantic region ${region.id} provenance`)
    validateMask(
      region.mask.width,
      region.mask.height,
      region.mask.values,
      request.image.width,
      request.image.height,
      `Semantic region ${region.id}`,
    )
  }
  const landmarkIds = new Set<string>()
  for (const landmark of analysis?.landmarks ?? []) {
    if (landmark.id.trim().length === 0 || landmarkIds.has(landmark.id)) {
      throw new RangeError('Landmark ids must be unique and non-empty')
    }
    landmarkIds.add(landmark.id)
    validateEnum(
      landmark.kind,
      new Set(['eye', 'mouth', 'nose', 'ear', 'face-contour', 'body', 'identity-mark', 'custom']),
      `Landmark ${landmark.id} kind`,
    )
    validateEnum(landmark.priority, new Set(['hard', 'soft']), `Landmark ${landmark.id} priority`)
    if (landmark.affectsOccupancy !== undefined && typeof landmark.affectsOccupancy !== 'boolean') {
      throw new RangeError(`Landmark ${landmark.id} affectsOccupancy must be boolean`)
    }
    for (const regionId of [landmark.featureRegionId, landmark.carrierRegionId]) {
      if (regionId !== undefined && semanticRegionIds.has(regionId) === false) {
        throw new RangeError(`Landmark ${landmark.id} references an unknown semantic region`)
      }
    }
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
    validateProvenance(landmark.provenance, `Landmark ${landmark.id} provenance`)
    const maximumSourceRadius = Math.max(request.image.width, request.image.height)
    if ((landmark.sourceRadiusPx ?? 0) > maximumSourceRadius
      || (landmark.gridRadiusCells ?? 0) > maxCanvasSide
      || (landmark.radius ?? 0) > Math.max(maximumSourceRadius, maxCanvasSide)) {
      throw new RangeError(`Landmark ${landmark.id} radius exceeds the processing limit`)
    }
  }
  validateUnitInterval(analysis?.confidence, 'Analysis confidence')
  validateProvenance(analysis?.provenance, 'Analysis provenance')
  for (const [name, modelVersion] of Object.entries(analysis?.modelVersions ?? {})) {
    if (name.trim().length === 0 || typeof modelVersion !== 'string' || modelVersion.trim().length === 0) {
      throw new RangeError('Analysis model versions require non-empty names and versions')
    }
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
  if (analysis?.suggestedCropSource === 'automatic'
    && analysis.suggestedCropConfidence === undefined) {
    throw new RangeError('Automatic crop confidence is required')
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
  validateEnum(
    request.options.optimization?.refinementMode,
    new Set(['fast', 'quality']),
    'refinementMode',
  )
  for (const [name, value] of Object.entries(request.options.optimization ?? {})) {
    if (name === 'refinementMode') continue
    if (value !== undefined && (Number.isFinite(value) === false || value < 0)) {
      throw new RangeError(`Optimization option ${name} must be a finite non-negative number`)
    }
  }
  for (const [name, value] of Object.entries(request.options.structure ?? {})) {
    if (name === 'occupancyMode') continue
    if (value !== undefined && (typeof value !== 'number' || Number.isFinite(value) === false || value < 0)) {
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
  if (resolveSizes(request.options).length
    * resolveStyles(request.options, baseline).length
    * resolveOccupancyModes(request, baseline).length
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
  if (hasAutomaticMetadata === false) return crop
  return (analysis.suggestedCropConfidence ?? 0) >= 0.5 ? crop : undefined
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

function resolveOccupancyModes(
  request: PatternGenerationRequest,
  baseline: BaselineMode,
): readonly ResolvedOccupancyMode[] {
  if (baseline !== 'mvp' || resolvedSubjectMask(request.analysis) === undefined) return ['full-frame']
  const mode = request.options.structure?.occupancyMode ?? 'auto'
  if (mode === 'full-frame') return ['full-frame']
  if (mode === 'subject-shape') return ['subject-shape']
  return hasConfidentSubjectMask(request.analysis)
    ? ['full-frame', 'subject-shape']
    : ['full-frame']
}

function hasConfidentSubjectMask(analysis: ImageAnalysis | undefined): boolean {
  const mask = resolvedSubjectMask(analysis)
  return mask !== undefined
    && subjectMaskTrust(analysis) >= 0.5
    && mask.values.some((value) => value >= shapeRasterizationThreshold)
}

function withoutSubjectMask(analysis: ImageAnalysis | undefined): ImageAnalysis | undefined {
  if (analysis === undefined || resolvedSubjectMask(analysis) === undefined) return analysis
  const copy: ImageAnalysis = { ...analysis }
  delete copy.subjectMask
  delete copy.subjectMaskEvidence
  return copy
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
    const confidence = landmarkEffectiveConfidence(landmark)
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
        if (score > bestScore) {
          bestScore = score
          ids[index] = region.id
        }
      }
    }
  }
  return ids
}

function maskFromActiveCells(width: number, height: number, activeMask: Uint8Array) {
  return { width, height, values: Float32Array.from(activeMask) }
}

function carrierMask(
  carrierRegionId: string,
  width: number,
  height: number,
  regionIds: readonly (string | undefined)[],
) {
  return {
    width,
    height,
    values: Float32Array.from(regionIds, (regionId) => Number(regionId === carrierRegionId)),
  }
}

function planFeaturePlacements(
  analysis: ImageAnalysis | undefined,
  canvasPlan: CanvasPlan,
  activeMask: Uint8Array,
  regionIds: readonly (string | undefined)[],
): readonly ResolvedFeaturePlacement[] {
  const eligible = (analysis?.landmarks ?? []).filter((landmark) =>
    landmark.kind === 'eye' || landmark.kind === 'mouth' || landmark.kind === 'nose')
  if (eligible.length === 0) return []
  const budgets = new Map(canvasPlan.featureBudgets.map((budget) => [budget.featureId, budget]))
  const occupancyMask = maskFromActiveCells(canvasPlan.size.width, canvasPlan.size.height, activeMask)
  const blockedCells = new Set<number>()
  const selected: ResolvedFeaturePlacement[] = []
  const handled = new Set<string>()
  const eyeGroups = new Map<string, ImageLandmark[]>()
  for (const landmark of eligible) {
    if (landmark.kind !== 'eye' || landmark.symmetryGroup === undefined) continue
    const group = eyeGroups.get(landmark.symmetryGroup) ?? []
    group.push(landmark)
    eyeGroups.set(landmark.symmetryGroup, group)
  }
  for (const group of eyeGroups.values()) {
    if (group.length !== 2) continue
    const ordered = [...group].sort((first, second) => first.x - second.x || first.id.localeCompare(second.id))
    const left = ordered[0]!
    const right = ordered[1]!
    const leftBudget = budgets.get(left.id)
    const rightBudget = budgets.get(right.id)
    if (leftBudget === undefined || rightBudget === undefined) continue
    const leftCandidates = searchFeaturePlacements({
      canvasPlan,
      budget: leftBudget,
      landmark: left,
      occupancyMask,
      blockedCells,
      ...(left.carrierRegionId === undefined ? {} : {
        carrierMask: carrierMask(
          left.carrierRegionId,
          canvasPlan.size.width,
          canvasPlan.size.height,
          regionIds,
        ),
      }),
    })
    const rightCandidates = searchFeaturePlacements({
      canvasPlan,
      budget: rightBudget,
      landmark: right,
      occupancyMask,
      blockedCells,
      ...(right.carrierRegionId === undefined ? {} : {
        carrierMask: carrierMask(
          right.carrierRegionId,
          canvasPlan.size.width,
          canvasPlan.size.height,
          regionIds,
        ),
      }),
    })
    const leftConstraint = createFeatureConstraint(leftBudget, left, canvasPlan)
    const rightConstraint = createFeatureConstraint(rightBudget, right, canvasPlan)
    const pair = searchFeaturePairs({
      leftCandidates,
      rightCandidates,
      expectedLeftCenter: leftConstraint.targetCenter,
      expectedRightCenter: rightConstraint.targetCenter,
      maximumPairs: 1,
    })[0]
    if (pair === undefined) continue
    selected.push(pair.left, pair.right)
    for (const cell of [...pair.left.occupiedCells, ...pair.right.occupiedCells]) blockedCells.add(cell)
    handled.add(left.id)
    handled.add(right.id)
  }
  const remaining = eligible.filter((landmark) => handled.has(landmark.id) === false)
    .sort((first, second) => Number(second.priority === 'hard') - Number(first.priority === 'hard')
      || second.confidence - first.confidence
      || first.id.localeCompare(second.id))
  for (const landmark of remaining) {
    const budget = budgets.get(landmark.id)
    if (budget === undefined) continue
    const placement = searchFeaturePlacements({
      canvasPlan,
      budget,
      landmark,
      occupancyMask,
      blockedCells,
      ...(landmark.carrierRegionId === undefined ? {} : {
        carrierMask: carrierMask(
          landmark.carrierRegionId,
          canvasPlan.size.width,
          canvasPlan.size.height,
          regionIds,
        ),
      }),
      maximumCandidates: 1,
    })[0]
    if (placement === undefined) continue
    selected.push(placement)
    for (const cell of placement.occupiedCells) blockedCells.add(cell)
  }
  return selected.sort((first, second) => first.featureId.localeCompare(second.featureId))
}

function plannedFeatureConstraints(
  analysis: ImageAnalysis | undefined,
  canvasPlan: CanvasPlan,
  placements: readonly ResolvedFeaturePlacement[],
) {
  const landmarks = new Map((analysis?.landmarks ?? []).map((landmark) => [landmark.id, landmark]))
  const budgets = new Map(canvasPlan.featureBudgets.map((budget) => [budget.featureId, budget]))
  return placements.flatMap((placement) => {
    const landmark = landmarks.get(placement.featureId)
    const budget = budgets.get(placement.featureId)
    return landmark === undefined || budget === undefined
      ? []
      : [createFeatureConstraint(budget, landmark, canvasPlan)]
  })
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
  for (const landmark of analysis?.landmarks ?? []) {
    if (landmark.priority !== 'hard'
      || landmarkEffectiveConfidence(landmark) < 0.5) continue
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

function valueOrderAccuracy(
  valuePlan: ValuePlan | undefined,
  roleIdsByCell: readonly (string | undefined)[] | undefined,
  colorIds: readonly string[],
  palette: readonly PreparedColor[],
  activeMask: Uint8Array,
): number {
  if (valuePlan === undefined || roleIdsByCell === undefined) return 0
  const colorsById = new Map(palette.map((color) => [color.id, color]))
  const lightnessByRole = new Map<string, { total: number; count: number }>()
  for (let cell = 0; cell < activeMask.length; cell += 1) {
    const roleId = roleIdsByCell[cell]
    const color = colorsById.get(colorIds[cell]!)
    if (activeMask[cell] !== 1 || roleId === undefined || color === undefined) continue
    const current = lightnessByRole.get(roleId) ?? { total: 0, count: 0 }
    current.total += color.lab[0]
    current.count += 1
    lightnessByRole.set(roleId, current)
  }
  const rolesByRegion = new Map<string, ValueRole[]>()
  for (const role of valuePlan.roles) {
    const roles = rolesByRegion.get(role.regionId) ?? []
    roles.push(role)
    rolesByRegion.set(role.regionId, roles)
  }
  let correct = 0
  let comparisons = 0
  for (const roles of rolesByRegion.values()) {
    const ordered = [...roles].sort((first, second) =>
      first.targetLightness - second.targetLightness)
    for (let index = 1; index < ordered.length; index += 1) {
      const lower = lightnessByRole.get(ordered[index - 1]!.id)
      const higher = lightnessByRole.get(ordered[index]!.id)
      if (lower === undefined || higher === undefined) continue
      const required = Math.min(6, Math.max(
        ordered[index - 1]!.minimumSeparation,
        ordered[index]!.minimumSeparation,
      ))
      if (higher.total / higher.count - lower.total / lower.count >= required) correct += 1
      comparisons += 1
    }
  }
  return comparisons === 0 ? 1 : correct / comparisons
}

function paletteRoleConsistency(
  palettePlan: PalettePlan | undefined,
  roleIdsByCell: readonly (string | undefined)[] | undefined,
  colorIds: readonly string[],
  activeMask: Uint8Array,
  excludedCells: ReadonlySet<number>,
): number {
  if (palettePlan === undefined || roleIdsByCell === undefined) return 0
  let matches = 0
  let total = 0
  for (let cell = 0; cell < activeMask.length; cell += 1) {
    const roleId = roleIdsByCell[cell]
    if (activeMask[cell] !== 1 || excludedCells.has(cell) || roleId === undefined) continue
    const expected = palettePlan.assignments[roleId]
    if (expected === undefined) continue
    if (colorIds[cell] === expected) matches += 1
    total += 1
  }
  return total === 0 ? 1 : matches / total
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

interface ReferenceMetrics {
  meanColorDistance: number
  boundaryAgreement: number
}

function referenceMetrics(
  request: PatternGenerationRequest,
  crop: CropRect,
  fit: CanvasFit,
  width: number,
  height: number,
  colorIds: readonly string[],
  palette: readonly PreparedColor[],
  activeMask: Uint8Array,
): ReferenceMetrics {
  const referenceSize = 96
  const source = resizePixels(
    request.image,
    crop,
    referenceSize,
    referenceSize,
    crop.width <= referenceSize && crop.height <= referenceSize ? 'nearest' : 'area',
    request.options.backgroundRgb,
  )
  const colorsById = new Map(palette.map((color) => [color.id, color]))
  const candidateIds = Array.from({ length: referenceSize * referenceSize }, () => '')
  const referenceActiveMask = new Uint8Array(referenceSize * referenceSize)
  let totalDistance = 0
  let count = 0
  for (let y = 0; y < referenceSize; y += 1) {
    for (let x = 0; x < referenceSize; x += 1) {
      const index = y * referenceSize + x
      if (source.activeMask[index] !== 1) continue
      const normalizedX = (x - source.fit.x + 0.5) / source.fit.width
      const normalizedY = (y - source.fit.y + 0.5) / source.fit.height
      const candidateX = clamp(fit.x + Math.floor(normalizedX * fit.width), fit.x, fit.x + fit.width - 1)
      const candidateY = clamp(fit.y + Math.floor(normalizedY * fit.height), fit.y, fit.y + fit.height - 1)
      const candidateIndex = candidateY * width + candidateX
      if (activeMask[candidateIndex] !== 1) continue
      const colorId = colorIds[candidateIndex]
      if (colorId === undefined) continue
      const color = colorsById.get(colorId)
      if (color === undefined) continue
      candidateIds[index] = colorId
      referenceActiveMask[index] = 1
      totalDistance += colorDistance(rgbToLab(source.pixels[index]!), color.lab, 'delta-e-2000')
      count += 1
    }
  }
  return {
    meanColorDistance: count === 0 ? 0 : totalDistance / count,
    boundaryAgreement: boundaryAgreement(
      source.pixels.map(rgbToLab),
      candidateIds,
      referenceSize,
      referenceSize,
      referenceActiveMask,
    ),
  }
}

interface FeatureVisibilityResult {
  score: number
  confidence: number
  coverage: number
  purity: number
  connectivity: number
  localContrast: number
  symmetryQuality: number
  valid: boolean
  rejectionReasons: readonly string[]
}

interface FeatureEvaluationProfile {
  metric: 'blob' | 'template' | 'contour' | 'geometry'
  kindWeight: number
  minimumCoverage: number
  minimumPurity: number
  minimumConnectivity: number
  minimumContrast: number
  minimumBoundary: number
}

const featureProfiles: Readonly<Record<LandmarkKind, FeatureEvaluationProfile>> = {
  eye: {
    metric: 'blob', kindWeight: 1.4, minimumCoverage: 0.75, minimumPurity: 0.35,
    minimumConnectivity: 0.75, minimumContrast: 0.2, minimumBoundary: 0,
  },
  nose: {
    metric: 'blob', kindWeight: 1, minimumCoverage: 0.5, minimumPurity: 0.25,
    minimumConnectivity: 0.5, minimumContrast: 0.08, minimumBoundary: 0,
  },
  'identity-mark': {
    metric: 'blob', kindWeight: 1.3, minimumCoverage: 0.6, minimumPurity: 0.3,
    minimumConnectivity: 0.6, minimumContrast: 0.12, minimumBoundary: 0,
  },
  custom: {
    metric: 'blob', kindWeight: 0.8, minimumCoverage: 0.5, minimumPurity: 0.25,
    minimumConnectivity: 0.5, minimumContrast: 0.1, minimumBoundary: 0,
  },
  mouth: {
    metric: 'template', kindWeight: 1.2, minimumCoverage: 0.45, minimumPurity: 0,
    minimumConnectivity: 0.45, minimumContrast: 0.08, minimumBoundary: 0,
  },
  ear: {
    metric: 'contour', kindWeight: 0.9, minimumCoverage: 0, minimumPurity: 0,
    minimumConnectivity: 0, minimumContrast: 0, minimumBoundary: 0.12,
  },
  'face-contour': {
    metric: 'contour', kindWeight: 1.1, minimumCoverage: 0, minimumPurity: 0,
    minimumConnectivity: 0, minimumContrast: 0, minimumBoundary: 0.12,
  },
  body: {
    metric: 'geometry', kindWeight: 0.7, minimumCoverage: 0, minimumPurity: 0,
    minimumConnectivity: 0, minimumContrast: 0, minimumBoundary: 0,
  },
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
  const landmarks = (analysis?.landmarks ?? []).filter((landmark) =>
    landmarkEffectiveConfidence(landmark) > 0
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
      symmetryQuality: 1,
      valid: true,
      rejectionReasons: [],
    }
  }
  const colorsById = new Map(palette.map((color) => [color.id, color]))
  const evaluated = landmarks.map((landmark) => {
    const profile = featureProfiles[landmark.kind]
    const effectiveConfidence = landmarkEffectiveConfidence(landmark)
    const [centerX, centerY] = gridCellForSourcePoint(crop, fit, landmark.x, landmark.y)
    const center = centerY * width + centerX
    const colorId = colorIds[center]
    const color = colorId === undefined ? undefined : colorsById.get(colorId)
    if (activeMask[center] !== 1 || color === undefined) {
      const enforced = landmark.priority === 'hard' && effectiveConfidence >= 0.5
      return {
        landmark,
        profile,
        effectiveConfidence,
        cell: center,
        area: 0,
        score: 0,
        coverage: 0,
        purity: 0,
        connectivity: 0,
        contrastScore: 0,
        boundaryScore: 0,
        sourceMatch: 0,
        valid: enforced === false,
        rejectionReasons: enforced ? ['hard-feature-missing'] : [],
      }
    }
    const radius = landmarkGridRadiusCells(landmark, crop, fit)
    const regionCells: number[] = []
    const matchingCells = new Set<number>()
    const ringCells: number[] = []
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
        } else ringCells.push(index)
      }
    }
    const regionCounts = new Map<string, number>()
    for (const index of ringCells) {
      const regionId = regionIds[index]
      if (regionId === undefined || regionId === landmark.featureRegionId) continue
      regionCounts.set(regionId, (regionCounts.get(regionId) ?? 0) + 1)
    }
    const inferredCarrierRegionId = [...regionCounts.entries()]
      .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))[0]?.[0]
    const carrierRegionId = landmark.carrierRegionId ?? inferredCarrierRegionId ?? regionIds[center]
    const neighborCells = carrierRegionId === undefined
      ? ringCells
      : ringCells.filter((index) => regionIds[index] === carrierRegionId)
    const minimumCells = radius === 0 ? 1 : Math.max(2, Math.ceil(regionCells.length * 0.4))
    const coverage = clamp(matchingCells.size / minimumCells, 0, 1)
    const purity = matchingCells.size / Math.max(1, regionCells.length)
    const connectivity = connectedFeatureRatio(matchingCells, center, width)
    const contrast = neighborCells.length === 0 ? 0 : neighborCells.reduce((sum, index) => {
      const neighbor = colorsById.get(colorIds[index]!)
      return sum + (neighbor === undefined ? 0 : colorDistance(color.lab, neighbor.lab, 'delta-e-2000'))
    }, 0) / neighborCells.length
    const contrastScore = clamp(contrast / 24, 0, 1)
    const boundaryScore = ringCells.length === 0 ? 0 : ringCells.reduce(
      (sum, index) => sum + Number(colorIds[index] !== colorId),
      0,
    ) / ringCells.length
    const sourceMatch = 1 / (1 + colorDistance(
      rgbToLab(sourceRgbAt(request, landmark.x, landmark.y)),
      color.lab,
      'delta-e-2000',
    ) / 15)
    const rejectionReasons: string[] = []
    if (landmark.priority === 'hard' && effectiveConfidence >= 0.5) {
      if (coverage < profile.minimumCoverage || purity < profile.minimumPurity) {
        rejectionReasons.push('hard-feature-area')
      }
      if (connectivity < profile.minimumConnectivity) rejectionReasons.push('hard-feature-fragmented')
      if (contrastScore < profile.minimumContrast) rejectionReasons.push('hard-feature-low-contrast')
      if (boundaryScore < profile.minimumBoundary) rejectionReasons.push('hard-feature-boundary')
      if (profile.metric !== 'geometry' && sourceMatch < 0.35) {
        rejectionReasons.push('hard-feature-source-mismatch')
      }
    }
    const profileScore = profile.metric === 'geometry'
      ? 1
      : profile.metric === 'contour'
        ? sourceMatch * (boundaryScore * 0.75 + contrastScore * 0.25)
        : profile.metric === 'template'
          ? sourceMatch * (coverage * 0.2 + connectivity * 0.3 + contrastScore * 0.25 + boundaryScore * 0.25)
          : sourceMatch * (coverage * 0.25 + purity * 0.2 + connectivity * 0.2 + contrastScore * 0.35)
    return {
      landmark,
      profile,
      effectiveConfidence,
      cell: center,
      area: matchingCells.size,
      score: profileScore,
      coverage,
      purity,
      connectivity,
      contrastScore,
      boundaryScore,
      sourceMatch,
      valid: rejectionReasons.length === 0,
      rejectionReasons,
    }
  })
  const evaluationWeight = (entry: typeof evaluated[number]): number =>
    entry.effectiveConfidence
      * (entry.landmark.priority === 'hard' ? 1.5 : 1)
      * entry.profile.kindWeight
  const totalWeight = evaluated.reduce((sum, entry) => sum + evaluationWeight(entry), 0)
  const weightedAverage = (select: (entry: typeof evaluated[number]) => number): number =>
    totalWeight === 0 ? 0 : evaluated.reduce(
      (sum, entry) => sum + select(entry) * evaluationWeight(entry),
      0,
    ) / totalWeight
  const baseScore = weightedAverage((entry) => entry.score)
  const symmetryGroups = new Map<string, typeof evaluated>()
  for (const entry of evaluated) {
    if (entry.landmark.symmetryGroup === undefined) continue
    const group = symmetryGroups.get(entry.landmark.symmetryGroup) ?? []
    group.push(entry)
    symmetryGroups.set(entry.landmark.symmetryGroup, group)
  }
  const hardCollision = [...symmetryGroups.values()].some((group) => {
    const enforcedMembers = group.filter((entry) => entry.landmark.priority === 'hard'
      && entry.effectiveConfidence >= 0.5)
    return enforcedMembers.length > 1
      && new Set(enforcedMembers.map((entry) => entry.cell)).size < enforcedMembers.length
  })
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
  const confidence = weightedAverage((entry) => entry.effectiveConfidence)
  const rejectionReasons = new Set(evaluated.flatMap((entry) => entry.rejectionReasons))
  if (hardCollision) rejectionReasons.add('hard-feature-collision')
  return {
    score: clamp(baseScore * 0.85 + symmetryScore * 0.15, 0, 1),
    confidence: clamp(confidence, 0, 1),
    coverage: weightedAverage((entry) => entry.coverage),
    purity: weightedAverage((entry) => entry.purity),
    connectivity: weightedAverage((entry) => entry.connectivity),
    localContrast: weightedAverage((entry) => entry.contrastScore),
    symmetryQuality: clamp(symmetryScore, 0, 1),
    valid: evaluated.every((entry) => entry.valid) && hardCollision === false,
    rejectionReasons: [...rejectionReasons].sort(),
  }
}

function scoreCandidate(
  style: PatternStyle,
  totalCells: number,
  maxColors: number,
  sourceMeanColorDistance: number,
  referenceMeanColorDistance: number,
  planMeanColorDistance: number,
  structure: number,
  feature: FeatureVisibilityResult,
  isolatedCells: number,
  thinStripes: number,
  uniqueColors: number,
  canvasPlanScore: number,
): CandidateScore {
  const sourceFidelity = 1 / (1 + (sourceMeanColorDistance * 0.35 + referenceMeanColorDistance * 0.65) / 15)
  const planFidelity = 1 / (1 + planMeanColorDistance / 15)
  const colorFidelity = planFidelity
  const featureProtection = feature.score
  const cleanliness = clamp(1 - (isolatedCells * 2 + thinStripes) / Math.max(1, totalCells), 0, 1)
  const craftEase = clamp(
    1 - uniqueColors / Math.max(1, maxColors) * 0.25 - isolatedCells / Math.max(1, totalCells),
    0,
    1,
  )
  const canvasFit = canvasPlanScore
  const styleBias: Record<PatternStyle, number> = {
    faithful: 0.015,
    cute: 0,
    simple: 0.01,
    'high-contrast': 0.005,
    soft: 0,
  }
  const fidelityWeight = style === 'faithful' ? 0.24 : 0.18
  const craftWeight = style === 'faithful' ? 0.05 : 0.11
  const featureWeight = 0.18 * feature.confidence
  const weightedTotal = sourceFidelity * fidelityWeight
    + planFidelity * 0.09
    + structure * 0.22
    + featureProtection * featureWeight
    + cleanliness * 0.14
    + craftEase * craftWeight
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
  generationId: string,
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
  const shapeRasterization = context.shapeRasterization
  const activeMask = shapeRasterization?.activeMask ?? resized.activeMask
  const weights = buildImportanceWeights(
    request.analysis,
    context.sourceGuidance,
    crop,
    size.width,
    size.height,
    resized.fit,
    activeMask,
  )
  const sourceLabs = rawResized.pixels.map(rgbToLab)
  const valueLevels = structureOptions.valueLevels
    ?? (style === 'simple' ? 2 : 3)
  const regionIds = gridRegionIds(
    request.analysis,
    crop,
    size.width,
    size.height,
    resized.fit,
    activeMask,
  )
  const featurePlacements = baseline === 'mvp'
    ? planFeaturePlacements(request.analysis, context.canvasPlan, activeMask, regionIds)
    : []
  const structurePlan = baseline === 'mvp'
    ? buildStructurePlan({
      width: size.width,
      height: size.height,
      crop,
      fit: resized.fit,
      activeMask,
      pixelLabs: resized.pixels.map(rgbToLab),
      semanticRegionIds: regionIds,
      importance: weights,
      sourceGuidance: context.sourceGuidance,
      featurePlacements,
      featureConstraints: plannedFeatureConstraints(request.analysis, context.canvasPlan, featurePlacements),
      maximumSourceShiftCells: 0.35,
    })
    : undefined
  const semanticPlanningActive = baseline === 'mvp'
    && structurePlan !== undefined
    && regionIds.some((regionId) => regionId !== undefined)
  const structureMappingActive = semanticPlanningActive
  const structuredPixels = structureMappingActive === false
    ? resized.pixels
    : samplePixelsAtSourceMapping(
      resized.pixels,
      size.width,
      size.height,
      structurePlan.sourceMapping,
      activeMask,
      crop,
      resized.fit,
      request.options.backgroundRgb,
    )
  const styledPixels = structuredPixels.map((pixel) => applyStyle(pixel, style))
  const pixels = baseline === 'mvp'
    ? designRegionValues(
      styledPixels,
      activeMask,
      valueLevels,
      weights,
      regionIds,
    )
    : styledPixels
  const valuePlanning = semanticPlanningActive && structurePlan !== undefined
    ? buildValuePlan({
      structurePlan,
      pixelLabs: pixels.map(rgbToLab),
      activeMask,
      levels: valueLevels,
    })
    : undefined
  const pixelLabs = valuePlanning?.plannedLabs ?? pixels.map(rgbToLab)
  const maximumColors = styleColorLimit(
    style,
    Math.min(request.options.maxColors, context.preparedPalette.length),
  )
  const palettePlanning = semanticPlanningActive && structurePlan !== undefined
    && valuePlanning !== undefined
    ? buildPalettePlan({
      valuePlan: valuePlanning.plan,
      roleIdsByCell: valuePlanning.roleIdsByCell,
      plannedLabs: valuePlanning.plannedLabs,
      structurePlan,
      colors: context.preparedPalette,
      maximumColors,
      distanceMethod,
      featurePlacements,
    })
    : undefined
  const selectedPaletteIds = new Set(palettePlanning?.plan.selectedColorIds ?? [])
  const selectedPalette = palettePlanning === undefined
    ? selectPalette(
      pixelLabs,
      weights,
      context.preparedPalette,
      maximumColors,
      distanceMethod,
    )
    : context.preparedPalette.filter((color) => selectedPaletteIds.has(color.id))
  const assigned = palettePlanning === undefined
    ? assignGrid(pixels, pixelLabs, selectedPalette, baseline, distanceMethod)
    : { colorIds: palettePlanning.colorIds }
  const landmarkProtected = protectedCells(
    request.analysis,
    crop,
    size.width,
    size.height,
    resized.fit,
    activeMask,
  )
  const protectedSet = new Set([
    ...landmarkProtected,
    ...(shapeRasterization?.protectedCells ?? []),
    ...featurePlacements.flatMap((placement) => placement.occupiedCells),
  ])
  const semanticFeatureIds = new Set((request.analysis?.landmarks ?? [])
    .filter((landmark) => landmark.carrierRegionId !== undefined)
    .map((landmark) => landmark.id))
  const colorPlacements = featurePlacements.filter((placement) =>
    semanticFeatureIds.has(placement.featureId))
  const featureColors = baseline === 'mvp'
    ? resolveFeatureColors({
      placements: colorPlacements,
      initialColorIds: assigned.colorIds,
      colors: selectedPalette,
      width: size.width,
      height: size.height,
      activeMask,
      minimumContrastByFeature: new Map(context.canvasPlan.featureBudgets.map((budget) => [
        budget.featureId,
        budget.minimumContrast,
      ])),
      distanceMethod,
    })
    : { colorIds: assigned.colorIds, edits: [] }
  const paletteOptimization = baseline === 'mvp'
    ? optimizePaletteAssignments({
      pixelLabs,
      initialColorIds: featureColors.colorIds,
      colors: selectedPalette,
      width: size.width,
      height: size.height,
      activeMask,
      importance: weights,
      protectedCells: protectedSet,
      coherence: Math.max(0, request.options.optimization?.paletteCoherence ?? 1.15),
      edgeProtection: clamp(request.options.optimization?.edgeProtection ?? 0.8, 0, 1),
      iterations: Math.max(0, Math.floor(request.options.optimization?.localSearchIterations ?? 2)),
      distanceMethod,
    })
    : { colorIds: assigned.colorIds, changedCells: 0 }
  const paletteEdits = paletteOptimization.colorIds.flatMap((colorId, index) => {
    const fromColorId = featureColors.colorIds[index]
    if (activeMask[index] !== 1 || fromColorId === undefined || fromColorId === colorId) return []
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
      activeMask,
    )
  const gridRefinement = semanticPlanningActive && structurePlan !== undefined
    ? refineGridClusters({
      colorIds: optimization.colorIds,
      width: size.width,
      height: size.height,
      activeMask,
      protectedCells: protectedSet,
      pixelLabs,
      colors: selectedPalette,
      boundaryStrength: structurePlan.boundaryStrength,
      importance: weights,
      featurePlacements,
      distanceMethod,
      mode: request.options.optimization?.refinementMode ?? 'fast',
    })
    : undefined
  const finalColorIds = gridRefinement?.colorIds ?? optimization.colorIds
  const counts = materialCounts(finalColorIds, selectedPalette, activeMask)
  const usedIds = new Set(counts.map((entry) => entry.colorId))
  const usedPalette = selectedPalette.filter((color) => usedIds.has(color.id))
  const cells: PatternCell[] = []
  for (let index = 0; index < finalColorIds.length; index += 1) {
    if (activeMask[index] !== 1) continue
    cells.push({
      x: index % size.width,
      y: Math.floor(index / size.width),
      colorId: finalColorIds[index]!,
    })
  }
  const isolatedCells = countIsolatedCells(
    finalColorIds,
    size.width,
    size.height,
    activeMask,
  )
  const thinStripes = countThinStripes(
    finalColorIds,
    size.width,
    size.height,
    activeMask,
  )
  const sourceBoundaryAgreement = boundaryAgreement(
    sourceLabs,
    finalColorIds,
    size.width,
    size.height,
    activeMask,
  )
  const planBoundaryAgreement = boundaryAgreement(
    pixelLabs,
    finalColorIds,
    size.width,
    size.height,
    activeMask,
  )
  const reference = referenceMetrics(
    request,
    crop,
    resized.fit,
    size.width,
    size.height,
    finalColorIds,
    selectedPalette,
    activeMask,
  )
  const colorStructure = sourceBoundaryAgreement * 0.3
    + planBoundaryAgreement * 0.2
    + reference.boundaryAgreement * 0.5
  const topologyAgreement = shapeRasterization === undefined
    ? 1
    : 1 - clamp(
      Math.abs(shapeRasterization.diagnostics.referenceComponents - shapeRasterization.diagnostics.targetComponents) * 0.25
        + Math.abs(shapeRasterization.diagnostics.referenceHoles - shapeRasterization.diagnostics.targetHoles) * 0.25,
      0,
      1,
    )
  const shapeStructure = shapeRasterization === undefined
    ? 1
    : shapeRasterization.diagnostics.boundaryIoU * 0.4
      + shapeRasterization.diagnostics.coverageIoU * 0.4
      + topologyAgreement * 0.2
  const structure = shapeRasterization === undefined
    ? colorStructure
    : colorStructure * 0.55 + shapeStructure * 0.45
  const planMeanColorDistance = finalMeanColorDistance(
    pixelLabs,
    finalColorIds,
    selectedPalette,
    activeMask,
  )
  const sourceMeanColorDistance = finalMeanColorDistance(
    sourceLabs,
    finalColorIds,
    selectedPalette,
    activeMask,
  )
  const totalBeads = cells.length
  const finalValueOrderAccuracy = valueOrderAccuracy(
    valuePlanning?.plan,
    valuePlanning?.roleIdsByCell,
    finalColorIds,
    selectedPalette,
    activeMask,
  )
  const finalPaletteRoleConsistency = paletteRoleConsistency(
    palettePlanning?.plan,
    valuePlanning?.roleIdsByCell,
    finalColorIds,
    activeMask,
    protectedSet,
  )
  const visibility = featureVisibility(
    request,
    request.analysis,
    crop,
    size.width,
    size.height,
    resized.fit,
    finalColorIds,
    selectedPalette,
    activeMask,
    regionIds,
  )
  const rejectionReasons = [...new Set([
    ...context.canvasPlan.rejectionReasons,
    ...visibility.rejectionReasons,
  ])].sort()
  const score = scoreCandidate(
    style,
    totalBeads,
    request.options.maxColors,
    sourceMeanColorDistance,
    reference.meanColorDistance,
    planMeanColorDistance,
    structure,
    visibility,
    isolatedCells,
    thinStripes,
    counts.length,
    baseline === 'mvp'
      ? context.canvasPlan.score.total
      : 1 / (1 + totalBeads / 1024),
  )
  const variantIdentity = stableSerialize({
    size,
    style,
    baseline,
    occupancyMode: context.occupancyMode,
    crop,
    resizeMethod,
    distanceMethod,
    maxColors: request.options.maxColors,
    palette: selectedPalette.map((color) => ({ id: color.id, lab: color.lab })),
    landmarks: request.analysis?.landmarks?.map((landmark: ImageLandmark) => ({
      id: landmark.id,
      kind: landmark.kind,
      x: landmark.x,
      y: landmark.y,
      priority: landmark.priority,
      sourceRadiusPx: landmark.sourceRadiusPx ?? landmark.radius ?? 0,
      gridRadiusCells: landmark.gridRadiusCells ?? landmark.radius ?? 0,
      featureRegionId: landmark.featureRegionId,
      carrierRegionId: landmark.carrierRegionId,
    })) ?? [],
    featurePlacements,
    structureRegions: structurePlan?.regions.map((region) => ({
      id: region.id,
      sourceRegionId: region.sourceRegionId,
      cells: region.cellIndices.length,
      adjacentRegionIds: region.adjacentRegionIds,
    })) ?? [],
    valueRoles: valuePlanning?.plan.roles ?? [],
    palettePlan: palettePlanning?.plan,
    structure: request.options.structure ?? {},
    optimization: request.options.optimization ?? {},
  })
  const variantId = stableHash(variantIdentity)
  return {
    id: `${generationId}-${variantId}`,
    generationId,
    variantId,
    style,
    valid: context.canvasPlan.feasible && visibility.valid,
    rejectionReasons,
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
      referenceMeanColorDistance: reference.meanColorDistance,
      referenceBoundaryAgreement: reference.boundaryAgreement,
      valueOrderAccuracy: finalValueOrderAccuracy,
      paletteRoleConsistency: finalPaletteRoleConsistency,
      paletteOptimizationChanges: paletteOptimization.changedCells,
      gridRefinementChanges: gridRefinement?.changedCells ?? 0,
      symmetryQuality: visibility.symmetryQuality,
      topologyEdits: optimization.topologyEdits,
      shapeApplied: shapeRasterization !== undefined,
      subjectOccupancyRatio: shapeRasterization?.diagnostics.occupancyRatio ?? 1,
      silhouetteBoundaryIoU: shapeRasterization?.diagnostics.boundaryIoU ?? 1,
      subjectCoverageIoU: shapeRasterization?.diagnostics.coverageIoU ?? 1,
      shapeMeanBoundaryDistance: shapeRasterization?.diagnostics.meanBoundaryDistance ?? 0,
      referenceShapeComponents: shapeRasterization?.diagnostics.referenceComponents ?? 0,
      targetShapeComponents: shapeRasterization?.diagnostics.targetComponents ?? 0,
      referenceShapeHoles: shapeRasterization?.diagnostics.referenceHoles ?? 0,
      targetShapeHoles: shapeRasterization?.diagnostics.targetHoles ?? 0,
      shapeEdits: shapeRasterization?.diagnostics.shapeEdits ?? 0,
    },
    score,
    canvasPlan: context.canvasPlan,
    ...(featurePlacements.length === 0 ? {} : { featurePlacements }),
    ...(structurePlan === undefined ? {} : { structurePlan }),
    ...(valuePlanning === undefined ? {} : { valuePlan: valuePlanning.plan }),
    ...(palettePlanning === undefined ? {} : { palettePlan: palettePlanning.plan }),
    ...(gridRefinement === undefined
      ? {}
      : {
        gridRefinement: {
          mode: gridRefinement.mode,
          changedCells: gridRefinement.changedCells,
          energyBefore: gridRefinement.energyBefore,
          energyAfter: gridRefinement.energyAfter,
          iterations: gridRefinement.iterations,
        },
      }),
    edits: [
      ...featureColors.edits,
      ...paletteEdits,
      ...optimization.edits,
      ...(gridRefinement?.edits ?? []),
    ],
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
    this.version = config.version ?? '0.6.0-grid-refinement'
    this.#clock = config.clock ?? Date.now
  }

  async generate(request: PatternGenerationRequest): Promise<PatternGenerationResult> {
    const generationStartedAt = performance.now()
    let shapeModelMs = 0
    let shapePlanningMs = 0
    let canvasPlanningMs = 0
    let candidateGenerationMs = 0
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
    const occupancyModes = resolveOccupancyModes(request, baseline)
    const generationId = await generationFingerprint(request, this.version)
    const shouldBuildPlanningShape = baseline === 'mvp'
      && (occupancyModes.includes('subject-shape') || hasConfidentSubjectMask(request.analysis))
    const shapeModelStartedAt = performance.now()
    const analysisShape = shouldBuildPlanningShape === false
      ? undefined
      : buildSourceShapeModel(
        resolvedSubjectMask(request.analysis)!,
        subjectMaskTrust(request.analysis),
        request.analysis?.landmarks ?? [],
      )
    shapeModelMs = Math.max(0, performance.now() - shapeModelStartedAt)
    const shapeCache = analysisShape === undefined
      ? undefined
      : new ShapeVariantCache(analysisShape, request.analysis?.landmarks ?? [])
    const shapeRefinementIterations = request.options.structure?.shapeRefinementIterations ?? 2
    const shapeVariants = new Map<string, ShapeRasterization>()
    const shapePlanningStartedAt = performance.now()
    if (shapeCache !== undefined) {
      for (const size of sizes) {
        const shape = shapeCache.get({
          crop,
          size,
          refinementIterations: shapeRefinementIterations,
        })
        if (shape !== undefined) shapeVariants.set(`${size.width}x${size.height}`, shape)
      }
    }
    shapePlanningMs = Math.max(0, performance.now() - shapePlanningStartedAt)
    const canvasPlanningStartedAt = performance.now()
    const occupancyVariants = occupancyModes.map((occupancyMode) => {
      const usesSubjectShape = occupancyMode === 'subject-shape'
        && (analysisShape?.foregroundArea ?? 0) > 0
      const planningAnalysis = shapeVariants.size === 0
        ? withoutSubjectMask(request.analysis)
        : request.analysis
      const canvasPlanningInput = {
        image: { width: request.image.width, height: request.image.height },
        ...(planningAnalysis === undefined ? {} : { analysis: planningAnalysis }),
        crop,
        candidates: sizes,
        occupancyMode,
        shapeRefinementIterations,
        identitySeed: generationId,
        ...(request.options.beadDiameterMm === undefined
          ? {}
          : { beadDiameterMm: request.options.beadDiameterMm }),
      } as const
      const canvasPlans = shapeVariants.size === 0
        ? planCanvases(canvasPlanningInput)
        : planCanvasesWithShapeVariants(canvasPlanningInput, shapeVariants)
      return {
        occupancyMode,
        usesSubjectShape,
        canvasPlansBySize: new Map(canvasPlans.map((plan) => [
          `${plan.size.width}x${plan.size.height}`,
          plan,
        ])),
      }
    })
    canvasPlanningMs = Math.max(0, performance.now() - canvasPlanningStartedAt)
    const resizeMethod = resolveResizeMethod(request.options, baseline)
    const distanceMethod = resolveDistanceMethod(request.options, baseline)
    const candidates: PatternCandidate[] = []
    const candidateGenerationStartedAt = performance.now()
    for (const size of sizes) {
      for (const occupancy of occupancyVariants) {
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
            shapeRasterization: occupancy.usesSubjectShape
              ? shapeVariants.get(`${size.width}x${size.height}`)
              : undefined,
            occupancyMode: occupancy.occupancyMode,
            canvasPlan: occupancy.canvasPlansBySize.get(`${size.width}x${size.height}`)!,
          }, generationId, this.version, this.#clock))
        }
      }
    }
    candidateGenerationMs = Math.max(0, performance.now() - candidateGenerationStartedAt)
    candidates.sort((first, second) => Number(second.valid) - Number(first.valid)
      || second.score.total - first.score.total
      || first.id.localeCompare(second.id))
    const maximumCandidates = Math.max(1, Math.floor(request.options.maxCandidates ?? 5))
    const ranked = candidates.slice(0, maximumCandidates)
    const validCandidates = ranked.filter((candidate) => candidate.valid)
    const rejectedCandidates = ranked.filter((candidate) => candidate.valid === false)
    const recommended = validCandidates[0]
    const evaluation = evaluateCandidates(ranked)
    const timing = (): GenerationTiming => {
      const phaseTotal = shapeModelMs + shapePlanningMs + canvasPlanningMs + candidateGenerationMs
      return {
        coreTotalMs: Math.max(phaseTotal, performance.now() - generationStartedAt),
        shapeModelMs,
        shapePlanningMs,
        canvasPlanningMs,
        candidateGenerationMs,
      }
    }
    if (recommended !== undefined) {
      return {
        status: 'success',
        generationId,
        timing: timing(),
        pattern: recommended.pattern,
        materialCounts: recommended.materialCounts,
        metrics: recommended.metrics,
        recommended,
        alternatives: ranked.filter((candidate) => candidate.id !== recommended.id),
        rejectedCandidates,
        evaluation,
      }
    }
    const bestEffort = ranked[0]
    if (bestEffort !== undefined) {
      return {
        status: 'best-effort',
        generationId,
        timing: timing(),
        bestEffort,
        alternatives: ranked.slice(1),
        rejectedCandidates,
        evaluation,
      }
    }
    return {
      status: 'no-valid-candidate',
      generationId,
      timing: timing(),
      alternatives: [],
      rejectedCandidates: [],
      evaluation,
    }
  }

  async adapt(request: PatternAdaptationRequest): Promise<PatternAdaptationResult> {
    return adaptPattern(request, this.version, this.#clock())
  }
}
