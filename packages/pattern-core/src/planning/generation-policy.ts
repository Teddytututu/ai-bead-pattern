import { resolvedSubjectMask, subjectMaskTrust } from '../analysis-evidence.js'
import { shapeRasterizationThreshold } from '../shape.js'
import type {
  BaselineMode,
  ColorDistanceMethod,
  CropRect,
  GridSize,
  ImageAnalysis,
  PatternGenerationRequest,
  PatternOptions,
  PatternStyle,
  ResizeMethod,
} from '../types.js'
import type { OccupancyMode } from '../contracts.js'

export type ResolvedOccupancyMode = Extract<OccupancyMode, 'full-frame' | 'subject-shape'>

export const defaultStyles: readonly PatternStyle[] = ['faithful', 'simple', 'high-contrast']

export function resolveSizes(options: PatternOptions): readonly GridSize[] {
  if (options.canvas?.mode === 'fixed') return [options.canvas.size]
  if (options.canvas?.mode === 'auto') {
    const unique = new Map<string, GridSize>()
    for (const size of options.canvas.candidates) unique.set(`${size.width}x${size.height}`, size)
    if (unique.size === 0) throw new RangeError('Automatic canvas requires at least one candidate')
    return [...unique.values()].sort(
      (first, second) => first.width * first.height - second.width * second.height
        || first.width - second.width || first.height - second.height,
    )
  }
  if (options.width !== undefined && options.height !== undefined) {
    return [{ width: options.width, height: options.height }]
  }
  throw new RangeError('Canvas options or legacy width and height are required')
}

export function resolveStyles(options: PatternOptions, baseline: BaselineMode): readonly PatternStyle[] {
  if (baseline !== 'mvp') return ['faithful']
  const styles = options.styles ?? defaultStyles
  if (styles.length === 0) throw new RangeError('At least one style is required')
  return [...new Set(styles)]
}

export function resolveResizeMethod(
  options: PatternOptions,
  baseline: BaselineMode,
  analysis?: ImageAnalysis,
  preserveThinStructures = false,
): ResizeMethod {
  if (baseline === 'a0') return 'nearest'
  if (baseline === 'a1') return 'area'
  if (options.resizeMethod !== undefined) return options.resizeMethod
  if (preserveThinStructures) return 'area'
  const learnedEvidence = analysis?.subjectMaskEvidence?.source === 'ai'
    || analysis?.subjectMaskEvidence?.source === 'ai+manual'
    || analysis?.subjectMaskEvidence?.source === 'fused'
    || (analysis?.provenance ?? []).some((entry) => entry.origin === 'model')
  return learnedEvidence ? 'cell-aware' : 'area'
}

export function resolveDistanceMethod(options: PatternOptions, baseline: BaselineMode): ColorDistanceMethod {
  if (baseline === 'a0') return 'delta-e-76'
  return options.colorDistanceMethod ?? 'delta-e-2000'
}

export function resolveOccupancyModes(
  request: PatternGenerationRequest,
  baseline: BaselineMode,
): readonly ResolvedOccupancyMode[] {
  if (baseline !== 'mvp' || resolvedSubjectMask(request.analysis) === undefined) return ['full-frame']
  const mode = request.options.structure?.occupancyMode ?? 'auto'
  if (mode === 'full-frame') return ['full-frame']
  if (mode === 'subject-shape') return ['subject-shape']
  return hasConfidentSubjectMask(request.analysis) ? ['full-frame', 'subject-shape'] : ['full-frame']
}

export function hasConfidentSubjectMask(analysis: ImageAnalysis | undefined): boolean {
  const mask = resolvedSubjectMask(analysis)
  return mask !== undefined
    && subjectMaskTrust(analysis) >= 0.5
    && mask.values.some((value) => value >= shapeRasterizationThreshold)
}

export function withoutSubjectMask(analysis: ImageAnalysis | undefined): ImageAnalysis | undefined {
  if (analysis === undefined || resolvedSubjectMask(analysis) === undefined) return analysis
  const copy: ImageAnalysis = { ...analysis }
  delete copy.subjectMask
  delete copy.subjectMaskEvidence
  return copy
}

export function styleColorLimit(style: PatternStyle, maximum: number): number {
  const factor: Record<PatternStyle, number> = {
    faithful: 1,
    cute: 0.9,
    simple: 0.65,
    'high-contrast': 0.85,
    soft: 0.8,
  }
  return Math.max(1, Math.round(maximum * factor[style]))
}

export function resolvedCrop(request: PatternGenerationRequest): CropRect | undefined {
  const analysis = request.analysis
  const crop = analysis?.suggestedCrop
  if (analysis === undefined || crop === undefined) return undefined
  if (analysis.suggestedCropSource === 'manual') return crop
  const hasAutomaticMetadata = analysis.suggestedCropSource === 'automatic'
    || analysis.suggestedCropConfidence !== undefined
  if (hasAutomaticMetadata === false) return crop
  return (analysis.suggestedCropConfidence ?? 0) >= 0.5 ? crop : undefined
}
