import { resolvedSubjectMask } from '../analysis-evidence.js'
import { resolveOccupancyModes, resolveSizes, resolveStyles } from '../planning/index.js'
import { shapeRasterizationThreshold } from '../shape.js'
import type { EvidenceProvenance, PatternGenerationRequest, RGB } from '../types.js'

const maxImageSide = 2_048

const maxImagePixels = 4_000_000

const maxCanvasSide = 96

const maxCanvasCells = 9_216

const maxPaletteColors = 128

const maxSelectedColors = 48

const maxCanvasCandidates = 12

const maxGeneratedCandidates = 20

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

export function validateRequest(request: PatternGenerationRequest): void {
  validateEnum(request.options.baseline, new Set(['a0', 'a1', 'mvp']), 'baseline')
  validateEnum(request.options.resizeMethod, new Set(['area', 'bilinear', 'nearest', 'cell-aware']), 'resizeMethod')
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
  validateEnum(
    request.options.structure?.outlineMode,
    new Set(['off', 'selective', 'full']),
    'outlineMode',
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
  if (request.palette.inventory !== undefined) {
    if (request.palette.inventory === null || Array.isArray(request.palette.inventory)
      || typeof request.palette.inventory !== 'object') {
      throw new RangeError('Palette inventory must be a color-count record')
    }
    for (const [colorId, quantity] of Object.entries(request.palette.inventory)) {
      if (colorIds.has(colorId) === false || Number.isInteger(quantity) === false || quantity < 0) {
        throw new RangeError('Palette inventory must reference known colors with non-negative integer counts')
      }
    }
    const allColorsBounded = request.palette.colors.every((color) =>
      request.palette.inventory?.[color.id] !== undefined)
    const totalStock = Object.values(request.palette.inventory)
      .reduce((sum, quantity) => sum + quantity, 0)
    if (allColorsBounded && totalStock === 0) {
      throw new RangeError('Palette inventory requires at least one available bead')
    }
  }
  if (request.palette.substituteColorIds !== undefined) {
    if (request.palette.substituteColorIds === null
      || Array.isArray(request.palette.substituteColorIds)
      || typeof request.palette.substituteColorIds !== 'object') {
      throw new RangeError('Palette substitutes must be a color-id record')
    }
    for (const [colorId, substitutes] of Object.entries(request.palette.substituteColorIds)) {
      if (colorIds.has(colorId) === false || Array.isArray(substitutes) === false
        || substitutes.length === 0 || new Set(substitutes).size !== substitutes.length
        || substitutes.includes(colorId)
        || substitutes.some((substitute) => typeof substitute !== 'string'
          || colorIds.has(substitute) === false)) {
        throw new RangeError('Palette substitutes must reference unique known alternative color ids')
      }
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
    if (name === 'occupancyMode' || name === 'outlineMode') continue
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
