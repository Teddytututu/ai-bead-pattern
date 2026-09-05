import { prepareColors } from './color.js'
import { adaptPattern } from './adaptation.js'
import { resolvedSubjectMask, subjectMaskTrust } from './analysis-evidence.js'
import { normalizeCrop } from './image.js'
import { planCanvases, planCanvasesWithShapeVariants, hasConfidentSubjectMask, resolveDistanceMethod, resolveOccupancyModes, resolveResizeMethod, resolveSizes, resolveStyles, resolvedCrop, withoutSubjectMask } from './planning/index.js'
import { buildSourceShapeModel, type ShapeRasterization } from './shape.js'
import { ShapeVariantCache } from './planning/shape-variant-cache.js'
import { buildSourceGuidance } from './structure.js'
import type { AlgorithmEngine, CandidateEvaluation, GenerationTiming, PatternCandidate, PatternGenerationRequest, PatternGenerationResult, PatternAdaptationRequest, PatternAdaptationResult } from './types.js'
import { validateRequest } from './generation/validation.js'
import { shouldPreserveThinAlphaStructures } from './generation/evidence.js'
import { generationFingerprint } from './generation/identity.js'
import { generateCandidate } from './generation/candidate.js'
import { PetPoseProjectionCache } from './pet-pose.js'
import type { PaletteDistanceMatrixCache } from './planning/palette-quantizer.js'

function evaluateCandidates(candidates: readonly PatternCandidate[]): CandidateEvaluation {
  return {
    rankedCandidateIds: candidates.map((candidate) => candidate.id),
    scores: Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate.score])),
  }
}

/** Yield between heavyweight candidates in both Node and browser runtimes. */
export function yieldToRuntime(): Promise<void> {
  const runtime = globalThis as typeof globalThis & {
    setTimeout?: (callback: () => void, delay?: number) => unknown
  }
  if (typeof runtime.setTimeout === 'function') {
    return new Promise((resolve) => {
      runtime.setTimeout!(resolve, 0)
    })
  }
  return Promise.resolve()
}

export function resolveShapeRefinementIterations(
  sourceArea: number,
  canvasCount: number,
  requested: number | undefined,
): number {
  return requested ?? (sourceArea > 512 * 512 && canvasCount > 1 ? 1 : 2)
}

export class DeterministicPatternAlgorithm {
  readonly version: string
  readonly engine: AlgorithmEngine
  readonly #clock: () => number

  constructor(config: { version?: string; clock?: () => number }) {
    this.engine = 'baseline'
    this.version = config.version ?? '0.7.0-preference-learning'
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
    const preserveThinStructures = shouldPreserveThinAlphaStructures(request.image, request.analysis)
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
    const requestedShapeRefinementIterations = request.options.structure?.shapeRefinementIterations
    // Explicit budgets always win. The adaptive default keeps multi-canvas large
    // uploads responsive while retaining one refinement pass for boundary quality.
    const shapeRefinementIterations = resolveShapeRefinementIterations(
      request.image.width * request.image.height,
      sizes.length,
      requestedShapeRefinementIterations,
    )
    const shapeVariants = new Map<string, ShapeRasterization>()
    const shapePlanningStartedAt = performance.now()
    if (shapeCache !== undefined) {
      for (const size of sizes) {
        const shape = shapeCache.get({
          crop,
          size,
          refinementIterations: shapeRefinementIterations,
          preserveThinStructures,
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
    const resizeMethod = resolveResizeMethod(
      request.options,
      baseline,
      request.analysis,
      preserveThinStructures,
    )
    const distanceMethod = resolveDistanceMethod(request.options, baseline)
    const candidates: PatternCandidate[] = []
    const petPoseProjectionCache = new PetPoseProjectionCache()
    const distanceMatrixCache: PaletteDistanceMatrixCache = new Map()
    const structurePlanCache = new Map()
    const resizedPixelCache = new Map()
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
            preserveThinStructures,
            shapeRasterization: occupancy.usesSubjectShape
              ? shapeVariants.get(`${size.width}x${size.height}`)
              : undefined,
            occupancyMode: occupancy.occupancyMode,
            canvasPlan: occupancy.canvasPlansBySize.get(`${size.width}x${size.height}`)!,
            petPoseProjectionCache,
            distanceMatrixCache,
            structurePlanCache,
            resizedPixelCache,
          }, generationId, this.version, this.#clock))
          // Give the runtime a collection point between heavyweight candidate
          // passes so large uploads keep a bounded live heap.
          await yieldToRuntime()
        }
      }
    }
    candidateGenerationMs = Math.max(0, performance.now() - candidateGenerationStartedAt)
    const preferSubjectShape = request.options.structure?.occupancyMode === 'auto'
      && hasConfidentSubjectMask(request.analysis)
    candidates.sort((first, second) => Number(second.valid) - Number(first.valid)
      || (preferSubjectShape
        ? Number(second.canvasPlan?.occupancyMode === 'subject-shape')
          - Number(first.canvasPlan?.occupancyMode === 'subject-shape')
        : 0)
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

export { arrayFingerprint } from './generation/identity.js'
