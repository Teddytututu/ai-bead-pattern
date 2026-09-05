import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import {
  composeCandidateEvaluationV2,
  createPatternAlgorithm,
  inferPetInstances,
  planPetCompositionVariants,
} from '@ai-bead-pattern/pattern-core'
import {
  AIProviderRegistry,
  CompositeImageAnalyzer,
  HttpVisionProvider,
  fuseImageAnalyses,
  modelManifest,
} from '@ai-bead-pattern/ai-gateway'
import sharp from 'sharp'

import { preferenceCandidateFromPattern } from './candidate-features.mjs'
import {
  DINOV2_MODEL_ID,
  DINOV2_PROVIDER_ID,
  createDinoV2CandidateScorer,
  dinoV2NeuralFeature,
  scoreDinoV2Candidate,
} from './dinov2-candidate-scorer.mjs'
import { toGenerationOptions } from './iteration.mjs'
import {
  OPENCLIP_MODEL_ID,
  OPENCLIP_PROVIDER_ID,
  createOpenClipCandidateScorer,
  openClipNeuralFeature,
  scoreOpenClipCandidateViews,
} from './openclip-candidate-scorer.mjs'
import { createOpenClipScoringViews } from './openclip-views.mjs'
import { renderBatchSheet, renderPattern, renderSampleSheet } from './render.mjs'

function subjectKind(category) {
  if (category === 'portrait') return 'person'
  if (category === 'pet') return 'pet'
  if (category === 'landscape' || category === 'scene') return 'scene'
  return 'object'
}

function imageType(category) {
  if (category === 'portrait') return 'portrait'
  if (category === 'pet') return 'pet'
  if (category === 'illustration') return 'illustration'
  if (category === 'landscape' || category === 'scene') return 'landscape'
  return 'general'
}

const petAnalysisProviderIds = Object.freeze([
  'grounded-sam2-local',
  'mmpose-animal-local',
])

const petAnalysisCapabilities = Object.freeze([
  'subject-segmentation',
  'edge-thin-structure',
  'keypoints',
])

function configuredPetAnalyzer(options) {
  if (options.petAnalyzer !== undefined) return options.petAnalyzer
  const groundedConfigured = options.groundedSam2Endpoint !== undefined
  const mmposeConfigured = options.mmposeEndpoint !== undefined
  if (groundedConfigured !== mmposeConfigured) {
    throw new RangeError('Grounded-SAM2 and MMPose endpoints must be configured together')
  }
  if (groundedConfigured === false) return undefined
  const registry = new AIProviderRegistry()
  registry.register(new HttpVisionProvider({
    manifest: modelManifest('grounded-sam2-local'),
    endpoint: options.groundedSam2Endpoint,
    ...(options.groundedSam2TimeoutMs === undefined ? {} : { timeoutMs: options.groundedSam2TimeoutMs }),
  }), 20)
  registry.register(new HttpVisionProvider({
    manifest: modelManifest('mmpose-animal-local'),
    endpoint: options.mmposeEndpoint,
    ...(options.mmposeTimeoutMs === undefined ? {} : { timeoutMs: options.mmposeTimeoutMs }),
  }), 10)
  return new CompositeImageAnalyzer(registry)
}

function boundedProviderMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 500) || 'Pet analysis failed'
}

function failedPetAnalysisContributions(error, elapsedMs) {
  const message = boundedProviderMessage(error)
  return petAnalysisProviderIds.map((providerId) => {
    const manifest = modelManifest(providerId)
    return {
      providerId,
      modelId: manifest.modelId,
      capabilities: manifest.capabilities,
      status: 'failed',
      elapsedMs,
      message,
    }
  })
}

function modelPreferredPetAnalysis(baseline, modelAnalysis) {
  const fused = fuseImageAnalyses([baseline, modelAnalysis])
  if (modelAnalysis.suggestedCrop === undefined) return fused
  return {
    ...fused,
    suggestedCrop: modelAnalysis.suggestedCrop,
    suggestedCropConfidence: modelAnalysis.suggestedCropConfidence,
    suggestedCropSource: modelAnalysis.suggestedCropSource,
  }
}

function contributionWithManifest(contribution) {
  const manifest = modelManifest(contribution.providerId)
  return {
    ...contribution,
    manifest: {
      providerId: manifest.providerId,
      modelId: manifest.modelId,
      modelVersion: manifest.modelVersion,
      sourceRevision: manifest.sourceRevision,
      weightSource: manifest.weightSource,
      weightRevision: manifest.weightRevision,
      license: manifest.license,
      ...(manifest.weightLicense === undefined ? {} : { weightLicense: manifest.weightLicense }),
      documentationUrl: manifest.documentationUrl,
    },
  }
}

function analysisDiagnostics(analysis, route, providerContributions, instanceProposalCount = 0) {
  return {
    route,
    providerContributions: providerContributions.map(contributionWithManifest),
    instanceProposalCount,
    landmarkIds: (analysis.landmarks ?? []).map((landmark) => landmark.id).sort(),
    semanticRegionIds: (analysis.semanticRegions ?? []).map((region) => region.id).sort(),
    modelVersions: analysis.modelVersions ?? {},
    ...(analysis.suggestedCrop === undefined ? {} : { suggestedCrop: analysis.suggestedCrop }),
  }
}

export async function resolvePetSampleAnalysis({
  image,
  baselineAnalysis,
  analyzer,
  sourceId,
  signal,
}) {
  if (analyzer === undefined) {
    return {
      analysis: baselineAnalysis,
      diagnostics: analysisDiagnostics(baselineAnalysis, 'deterministic-baseline', []),
    }
  }
  const startedAt = performance.now()
  try {
    const result = await analyzer.analyze({
      image,
      capabilities: petAnalysisCapabilities,
      providerIds: petAnalysisProviderIds,
      route: 'neural-analysis',
      failureMode: 'best-effort',
      imageTypeHint: 'pet',
      prompt: 'cat. dog. rabbit. pet. animal.',
      sourceId,
      signal,
    })
    const analysis = modelPreferredPetAnalysis(baselineAnalysis, result.analysis)
    return {
      analysis,
      diagnostics: analysisDiagnostics(
        analysis,
        result.route,
        result.contributions,
        result.instanceProposals.length,
      ),
    }
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason
    const elapsedMs = Math.max(0, performance.now() - startedAt)
    return {
      analysis: baselineAnalysis,
      diagnostics: analysisDiagnostics(
        baselineAnalysis,
        'deterministic-baseline',
        failedPetAnalysisContributions(error, elapsedMs),
      ),
    }
  }
}

async function rgbaImage(path) {
  const { data, info } = await sharp(path).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) }
}

async function maskImage(path, width, height) {
  const { data, info } = await sharp(path).resize(width, height, { fit: 'fill' }).greyscale().raw()
    .toBuffer({ resolveWithObject: true })
  if (info.width !== width || info.height !== height) throw new RangeError('Mask dimensions must match the source image')
  return { width, height, values: Float32Array.from(data, (value) => value / 255) }
}

function candidateOccupancyMask(candidate) {
  const width = candidate.pattern.width
  const height = candidate.pattern.height
  const values = new Float32Array(width * height)
  for (const cell of candidate.pattern.cells) values[cell.y * width + cell.x] = 1
  return { width, height, values }
}

const headLandmarkKinds = new Set(['eye', 'ear', 'nose', 'mouth', 'face-contour'])
const headStructuralRoles = new Set([
  'eye-center', 'ear-tip', 'ear-root', 'nose-tip', 'mouth-corner', 'upper-jaw', 'lower-jaw',
])

function projectedCandidateHeadLandmarks(candidate, sourceLandmarks, candidateImage) {
  const crop = candidate.canvasPlan?.crop
  if (crop === undefined || sourceLandmarks === undefined) return []
  const gridWidth = candidate.pattern.width
  const gridHeight = candidate.pattern.height
  const scale = Math.min(gridWidth / crop.width, gridHeight / crop.height)
  const fitWidth = Math.max(1, Math.min(gridWidth, Math.round(crop.width * scale)))
  const fitHeight = Math.max(1, Math.min(gridHeight, Math.round(crop.height * scale)))
  const fitX = Math.floor((gridWidth - fitWidth) / 2)
  const fitY = Math.floor((gridHeight - fitHeight) / 2)
  const placementById = new Map((candidate.featurePlacements ?? [])
    .map((placement) => [placement.featureId, placement]))
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value))
  return sourceLandmarks.flatMap((landmark) => {
    if (headLandmarkKinds.has(landmark.kind) === false
      && headStructuralRoles.has(landmark.structuralRole) === false) return []
    if (landmark.observationState === 'missing'
      || landmark.x < crop.x || landmark.y < crop.y
      || landmark.x >= crop.x + crop.width || landmark.y >= crop.y + crop.height) return []
    const placement = placementById.get(landmark.id)
    const gridX = placement?.center[0] ?? clamp(
      fitX + Math.floor((landmark.x - crop.x) / crop.width * fitWidth),
      fitX,
      fitX + fitWidth - 1,
    )
    const gridY = placement?.center[1] ?? clamp(
      fitY + Math.floor((landmark.y - crop.y) / crop.height * fitHeight),
      fitY,
      fitY + fitHeight - 1,
    )
    return [{
      ...landmark,
      x: clamp((gridX + 0.5) * candidateImage.width / gridWidth, 0, candidateImage.width - 1),
      y: clamp((gridY + 0.5) * candidateImage.height / gridHeight, 0, candidateImage.height - 1),
      confidence: Math.min(landmark.confidence, placement?.score ?? landmark.confidence),
      observationState: placement === undefined ? 'inferred' : landmark.observationState,
    }]
  })
}

const facePlacementKinds = new Set(['eye', 'nose', 'mouth', 'ear'])

function scopedFacePlacements(candidate, instanceId) {
  return (candidate.featurePlacements ?? [])
    .filter((placement) => facePlacementKinds.has(placement.kind))
    .filter((placement) => instanceId === undefined
      || placement.featureId.startsWith(`${instanceId}:`))
}

function placementFaceMask(candidate, occupancy, instanceId) {
  const cells = scopedFacePlacements(candidate, instanceId)
    .flatMap((placement) => placement.occupiedCells)
  if (cells.length === 0) return undefined
  const xs = cells.map((cell) => cell % occupancy.width)
  const ys = cells.map((cell) => Math.floor(cell / occupancy.width))
  const padding = Math.max(2, Math.round(Math.max(occupancy.width, occupancy.height) * 0.04))
  const minimumX = Math.max(0, Math.min(...xs) - padding)
  const maximumX = Math.min(occupancy.width - 1, Math.max(...xs) + padding)
  const minimumY = Math.max(0, Math.min(...ys) - padding)
  const maximumY = Math.min(occupancy.height - 1, Math.max(...ys) + padding)
  const values = new Float32Array(occupancy.values.length)
  for (let y = minimumY; y <= maximumY; y += 1) for (let x = minimumX; x <= maximumX; x += 1) {
    const index = y * occupancy.width + x
    values[index] = occupancy.values[index]
  }
  return { width: occupancy.width, height: occupancy.height, values }
}

function projectedFaceMask(candidate, sourceFaceMask, occupancy, instanceId) {
  if (sourceFaceMask === undefined) return undefined
  const mapping = candidate.structurePlan?.sourceMapping
  if (mapping === undefined || mapping.length !== occupancy.values.length * 2) {
    return placementFaceMask(candidate, occupancy, instanceId)
  }
  const values = new Float32Array(occupancy.values.length)
  for (let index = 0; index < values.length; index += 1) {
    if (occupancy.values[index] < 0.5) continue
    const sourceX = mapping[index * 2]
    const sourceY = mapping[index * 2 + 1]
    if (Number.isFinite(sourceX) === false || Number.isFinite(sourceY) === false) continue
    const x = Math.max(0, Math.min(sourceFaceMask.width - 1, Math.round(sourceX)))
    const y = Math.max(0, Math.min(sourceFaceMask.height - 1, Math.round(sourceY)))
    values[index] = sourceFaceMask.values[y * sourceFaceMask.width + x] ?? 0
  }
  if (values.some((value) => value >= 0.2)) return {
    width: occupancy.width,
    height: occupancy.height,
    values,
  }
  return placementFaceMask(candidate, occupancy, instanceId)
}

function instanceFaceConfidence(candidate, instanceId) {
  const scores = scopedFacePlacements(candidate, instanceId)
    .filter((placement) => Number.isFinite(placement.score))
    .map((placement) => Math.max(0, Math.min(1, placement.score)))
  if (scores.length === 0) return candidate.metrics.featureVisibilityConfidence
  return scores.reduce((sum, score) => sum + score, 0) / scores.length
}

function instanceFaceRegions(analysis) {
  return (analysis.semanticRegions ?? []).flatMap((region) => {
    const suffix = ':pet-face'
    if (region.id.endsWith(suffix) === false) return []
    return [{ instanceId: region.id.slice(0, -suffix.length), faceRegion: region }]
  })
}

function observedHeadLandmarks(landmarks) {
  return (landmarks ?? []).filter((landmark) => landmark.observationState !== 'missing'
    && (headLandmarkKinds.has(landmark.kind) || headStructuralRoles.has(landmark.structuralRole)))
}

function usableHeadLandmarks(landmarks) {
  if (landmarks.length < 2) return false
  const xs = landmarks.map((landmark) => landmark.x)
  const ys = landmarks.map((landmark) => landmark.y)
  return Math.max(...xs) - Math.min(...xs) > 1e-6
    || Math.max(...ys) - Math.min(...ys) > 1e-6
}

export function createCandidateOpenClipViewPlan({
  referenceImage,
  candidateImage,
  analysis,
  candidate,
}) {
  const candidateSubjectMask = candidateOccupancyMask(candidate)
  const referenceSubjectMask = analysis.subjectMaskEvidence?.mask ?? analysis.subjectMask
  const petInstances = instanceFaceRegions(analysis)
  const multiplePetInstances = petInstances.length > 1
  const aggregateFaceRegion = (analysis.semanticRegions ?? []).find((region) => region.id === 'pet-face')
    ?? (petInstances.length === 1 ? petInstances[0].faceRegion : undefined)
  const aggregateFaceMask = aggregateFaceRegion?.mask
  const aggregateCandidateFaceMask = projectedFaceMask(candidate, aggregateFaceMask, candidateSubjectMask)
  const sourceHeadLandmarks = observedHeadLandmarks(analysis.landmarks)
  const sourceHeadEvidenceAvailable = usableHeadLandmarks(sourceHeadLandmarks)
  const candidateHeadLandmarks = projectedCandidateHeadLandmarks(
    candidate,
    sourceHeadLandmarks,
    candidateImage,
  )
  const baseViews = createOpenClipScoringViews({
    referenceImage,
    candidateImage,
    ...(candidate.canvasPlan?.crop === undefined ? {} : { referenceCrop: candidate.canvasPlan.crop }),
    referenceSubjectMask,
    candidateSubjectMask,
    referenceSubjectConfidence: analysis.subjectMaskEvidence?.confidence,
    candidateSubjectConfidence: 1,
    ...(multiplePetInstances || aggregateFaceMask === undefined || aggregateCandidateFaceMask === undefined ? {} : {
      referenceFaceMask: aggregateFaceMask,
      candidateFaceMask: aggregateCandidateFaceMask,
      referenceFaceConfidence: aggregateFaceRegion.confidence,
      candidateFaceConfidence: candidate.metrics.featureVisibilityConfidence,
    }),
    ...(multiplePetInstances || sourceHeadEvidenceAvailable === false || candidateHeadLandmarks.length === 0 ? {} : {
      referenceHeadLandmarks: sourceHeadLandmarks,
      candidateHeadLandmarks,
    }),
  })
  const plannedViewIds = [
    'global',
    ...(referenceSubjectMask === undefined ? [] : ['subject-mask']),
    ...(multiplePetInstances || aggregateFaceMask === undefined ? [] : ['face-mask']),
    ...(multiplePetInstances || sourceHeadEvidenceAvailable === false ? [] : ['head-landmarks']),
  ]
  if (multiplePetInstances === false) return { views: baseViews, plannedViewIds }

  const instanceViews = []
  for (const { instanceId, faceRegion } of petInstances) {
    const subjectRegion = (analysis.semanticRegions ?? [])
      .find((region) => region.id === `${instanceId}:subject`)
    const sourceLandmarks = sourceHeadLandmarks.filter(
      (landmark) => landmark.id.startsWith(`${instanceId}:`),
    )
    const sourceLandmarkEvidenceAvailable = usableHeadLandmarks(sourceLandmarks)
    const projectedLandmarks = projectedCandidateHeadLandmarks(
      candidate,
      sourceLandmarks,
      candidateImage,
    )
    const candidateInstanceSubjectMask = projectedFaceMask(
      candidate,
      subjectRegion?.mask,
      candidateSubjectMask,
      instanceId,
    )
    const candidateInstanceFaceMask = projectedFaceMask(
      candidate,
      faceRegion.mask,
      candidateSubjectMask,
      instanceId,
    )
    const scoped = createOpenClipScoringViews({
      referenceImage,
      candidateImage,
      ...(candidate.canvasPlan?.crop === undefined ? {} : { referenceCrop: candidate.canvasPlan.crop }),
      viewIdPrefix: instanceId,
      includeGlobal: false,
      ...(subjectRegion === undefined || candidateInstanceSubjectMask === undefined ? {} : {
        referenceSubjectMask: subjectRegion.mask,
        candidateSubjectMask: candidateInstanceSubjectMask,
        referenceSubjectConfidence: subjectRegion.confidence,
        candidateSubjectConfidence: 1,
      }),
      ...(candidateInstanceFaceMask === undefined ? {} : {
        referenceFaceMask: faceRegion.mask,
        candidateFaceMask: candidateInstanceFaceMask,
        referenceFaceConfidence: faceRegion.confidence,
        candidateFaceConfidence: instanceFaceConfidence(candidate, instanceId),
      }),
      ...(sourceLandmarkEvidenceAvailable === false || projectedLandmarks.length === 0 ? {} : {
        referenceHeadLandmarks: sourceLandmarks,
        candidateHeadLandmarks: projectedLandmarks,
      }),
    })
    instanceViews.push(...scoped)
    if (subjectRegion !== undefined) plannedViewIds.push(`${instanceId}:subject-mask`)
    plannedViewIds.push(`${instanceId}:face-mask`)
    if (sourceLandmarkEvidenceAvailable) plannedViewIds.push(`${instanceId}:head-landmarks`)
  }
  return { views: [...baseViews, ...instanceViews], plannedViewIds }
}

const evaluationProviders = Object.freeze([
  {
    providerId: DINOV2_PROVIDER_ID,
    modelId: DINOV2_MODEL_ID,
    evaluationKey: 'dinoV2Evaluation',
  },
  {
    providerId: OPENCLIP_PROVIDER_ID,
    modelId: OPENCLIP_MODEL_ID,
    evaluationKey: 'openClipEvaluation',
  },
])

export const AUTO_EVAL_EVALUATION_SOURCE_WEIGHTS = Object.freeze({
  rule: 0.4,
  neural: 0.6,
  humanPreference: 0,
})

function providerContributions(candidateEntries, warnings) {
  return evaluationProviders.flatMap((provider) => {
    const used = candidateEntries
      .map((candidate) => candidate[provider.evaluationKey])
      .filter((entry) => entry !== undefined)
    const failed = warnings.filter((warning) => warning.providerId === provider.providerId)
    if (used.length > 0) {
      return [{
        providerId: provider.providerId,
        modelId: used[0].model.modelId,
        capabilities: ['embedding', 'preference-scoring'],
        status: 'used',
        confidence: used.reduce((sum, entry) => sum + entry.confidence, 0) / used.length,
        elapsedMs: used.reduce((sum, entry) => sum + entry.elapsedMs, 0)
          + failed.reduce((sum, entry) => sum + entry.elapsedMs, 0),
        ...(failed.length === 0 ? {} : { message: `${failed.length} candidate scoring requests failed` }),
      }]
    }
    if (failed.length === 0) return []
    return [{
      providerId: provider.providerId,
      modelId: provider.modelId,
      capabilities: ['embedding', 'preference-scoring'],
      status: 'failed',
      elapsedMs: failed.reduce((sum, entry) => sum + entry.elapsedMs, 0),
      message: failed[0].message,
    }]
  })
}

export function composeAutoEvalCandidateEvaluation(
  candidateEntries,
  warnings,
  analysisProviderContributions = [],
) {
  return composeCandidateEvaluationV2({
    scores: Object.fromEntries(candidateEntries.map((candidate) => [candidate.id, candidate.score])),
    candidateValidity: Object.fromEntries(candidateEntries.map((candidate) => [candidate.id, candidate.valid])),
    neuralPreferenceFeatures: candidateEntries.flatMap((candidate) =>
      candidate.preferenceFeatures
        ?? (candidate.neuralPreferenceFeatures === undefined ? [] : [candidate.neuralPreferenceFeatures])),
    providerContributions: [
      ...analysisProviderContributions,
      ...providerContributions(candidateEntries, warnings),
    ],
    sourceWeights: AUTO_EVAL_EVALUATION_SOURCE_WEIGHTS,
  })
}

function baseOptions(category) {
  return {
    canvas: { mode: 'fixed', size: { width: 48, height: 48 } },
    maxColors: 12,
    maxCandidates: 1,
    imageType: imageType(category),
    resizeMethod: 'cell-aware',
    colorDistanceMethod: 'delta-e-2000',
    baseline: 'mvp',
    structure: {
      importanceStrength: 1,
      edgeStrength: 1,
      valueOrderStrength: 1,
      valueLevels: 3,
      occupancyMode: 'subject-shape',
      shapeRefinementIterations: 2,
    },
    optimization: {
      minRegionSize: 2,
      isolatedPixelPenalty: 1,
      edgeProtection: 0.72,
      stripePenalty: 1,
      paletteCoherence: 1.1,
      localSearchIterations: 3,
      aliasPenalty: 1,
      refinementMode: 'quality',
    },
  }
}

const evaluationCanvasSizes = Object.freeze([32, 48, 64])

function recipes(category, learnedModel) {
  const baseline = baseOptions(category)
  const adaptive = learnedModel === undefined ? {
    ...structuredClone(baseline),
    structure: { ...baseline.structure, importanceStrength: 1.55, edgeStrength: 1.5 },
    optimization: { ...baseline.optimization, edgeProtection: 0.9 },
  } : toGenerationOptions(learnedModel, baseline)
  const variants = [
    { id: 'A-baseline', options: { ...structuredClone(baseline), styles: ['faithful'] } },
    { id: learnedModel === undefined ? 'B-identity' : 'B-learned', options: { ...adaptive, styles: ['faithful'] } },
    { id: 'C-clean', options: {
      ...structuredClone(baseline), styles: ['simple'], maxColors: 9,
      optimization: {
        ...baseline.optimization, isolatedPixelPenalty: 1.65, stripePenalty: 1.55,
        paletteCoherence: 1.35, localSearchIterations: 6,
      },
    } },
    { id: 'D-contrast', options: {
      ...structuredClone(baseline), styles: ['high-contrast'], maxColors: 10,
      structure: { ...baseline.structure, importanceStrength: 1.3, edgeStrength: 1.4 },
    } },
  ]
  return variants.flatMap((variant) => evaluationCanvasSizes.map((size) => ({
    id: `${variant.id}-${size}`,
    options: {
      ...structuredClone(variant.options),
      canvas: { mode: 'fixed', size: { width: size, height: size } },
    },
  })))
}

function compositionSummary(composition) {
  return {
    id: composition.id,
    strategy: composition.strategy,
    instanceIds: composition.instanceIds,
    crop: composition.crop,
    subjectCoverage: composition.subjectCoverage,
    relativeScaleGain: composition.relativeScaleGain,
  }
}

function identityFocusRecipe(recipe) {
  return /^B-(?:identity|learned)-(?:48|64)$/.test(recipe.id)
}

export function planAutoEvalCandidateInputs({ category, image, analysis, learnedModel }) {
  const recipeVariants = recipes(category, learnedModel)
  if (category !== 'pet') {
    return recipeVariants.map((recipe) => ({
      ...recipe,
      analysis,
    }))
  }
  const compositions = planPetCompositionVariants({ image, analysis })
  return compositions.flatMap((composition) => {
    const selectedRecipes = composition.strategy === 'group'
      ? recipeVariants
      : recipeVariants.filter(identityFocusRecipe)
    return selectedRecipes.map((recipe) => ({
      ...recipe,
      id: `${recipe.id}--${composition.id}`,
      analysis: composition.analysis,
      composition: compositionSummary(composition),
    }))
  })
}

function unionMasks(masks) {
  const first = masks[0]
  if (first === undefined) return undefined
  const values = new Float32Array(first.values.length)
  for (const mask of masks) {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = Math.max(values[index] ?? 0, mask.values[index] ?? 0)
    }
  }
  return { width: first.width, height: first.height, values }
}

export function mergeAnalysis(image, mask, metadata, category) {
  const petGroup = category === 'pet' ? inferPetInstances(image, mask) : undefined
  const subjectMask = petGroup?.subjectMask ?? mask
  const evidence = {
    mask: subjectMask,
    confidence: metadata.evidence.confidence,
    source: metadata.evidence.source,
    revision: metadata.evidence.revision,
    provenance: metadata.evidence.provenance,
  }
  const petFaces = petGroup?.instances.map((instance) => instance.faceMask) ?? []
  const aggregatePetFace = unionMasks(petFaces)
  const semanticRegions = [{
    id: 'subject',
    label: 'subject',
    mask: subjectMask,
    confidence: metadata.evidence.confidence,
    importance: 0.9,
    provenance: metadata.evidence.provenance,
  }, ...(petGroup === undefined || aggregatePetFace === undefined ? [] : [{
    id: 'pet-face',
    label: 'pet faces',
    mask: aggregatePetFace,
    confidence: petGroup.confidence,
    importance: 1,
    provenance: [{ origin: 'heuristic', provider: 'pet-geometry', version: 'pet-face-v2' }],
  }, ...petGroup.instances.flatMap((instance) => [{
    id: `${instance.instanceId}:subject`,
    label: 'pet instance',
    mask: instance.instanceMask,
    confidence: instance.confidence,
    importance: 0.95,
    provenance: [{ origin: 'heuristic', provider: 'pet-components', version: 'significant-components-v1' }],
  }, {
    id: `${instance.instanceId}:pet-face`,
    label: 'pet face',
    mask: instance.faceMask,
    confidence: instance.confidence,
    importance: 1,
    provenance: [{ origin: 'heuristic', provider: 'pet-geometry', version: 'pet-face-v3' }],
  }, ...instance.bodyRegions])])]
  return {
    subjectMask,
    subjectMaskEvidence: evidence,
    ...(petGroup === undefined ? {} : {
      landmarks: petGroup.instances.flatMap((instance) => instance.landmarks),
      suggestedCrop: petGroup.suggestedCrop,
      suggestedCropConfidence: petGroup.confidence,
      suggestedCropSource: 'automatic',
    }),
    semanticRegions,
    imageType: imageType(category),
    confidence: petGroup?.confidence ?? metadata.evidence.confidence,
    modelVersions: {
      ...(metadata.modelVersions ?? {}),
      ...(petGroup === undefined ? {} : {
        petAnalysis: 'pattern-core/pet-analysis-v3-ap10k',
        petInstances: String(petGroup.instances.length),
        petHeadPose: petGroup.instances.map((instance) => instance.headPose).join(','),
      }),
    },
    provenance: metadata.evidence.provenance,
  }
}

export async function generateCandidateBatch(options) {
  const manifestPath = resolve(options.manifestPath)
  const sidecarDirectory = resolve(options.sidecarDirectory)
  const outputDirectory = resolve(options.outputDirectory)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const palette = JSON.parse(await readFile(resolve(options.palettePath), 'utf8'))
  const learnedModel = options.modelPath === undefined
    ? undefined
    : JSON.parse(await readFile(resolve(options.modelPath), 'utf8'))
  const openClipScorer = options.openClipScorer ?? (options.openClipEndpoint === undefined
    ? undefined
    : createOpenClipCandidateScorer({
      endpoint: options.openClipEndpoint,
      ...(options.openClipTimeoutMs === undefined ? {} : { timeoutMs: options.openClipTimeoutMs }),
    }))
  const dinoV2Scorer = options.dinoV2Scorer ?? (options.dinoV2Endpoint === undefined
    ? undefined
    : createDinoV2CandidateScorer({
      endpoint: options.dinoV2Endpoint,
      ...(options.dinoV2TimeoutMs === undefined ? {} : { timeoutMs: options.dinoV2TimeoutMs }),
    }))
  const petAnalyzer = configuredPetAnalyzer(options)
  const selected = manifest.samples
    .filter((sample) => options.category === undefined || sample.category === options.category)
    .slice(0, options.limit ?? manifest.samples.length)
  const algorithm = createPatternAlgorithm()
  const generations = []
  const sheetsByCategory = new Map()
  await mkdir(outputDirectory, { recursive: true })
  for (const sample of selected) {
    const metadataPath = join(sidecarDirectory, `${sample.imageId}.analysis.json`)
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    const sourcePath = join(sidecarDirectory, metadata.source.path)
    const maskPath = join(sidecarDirectory, metadata.mask.path)
    const image = await rgbaImage(sourcePath)
    const mask = await maskImage(maskPath, image.width, image.height)
    const baselineAnalysis = mergeAnalysis(image, mask, metadata, sample.category)
    const resolvedAnalysis = sample.category === 'pet'
      ? await resolvePetSampleAnalysis({
        image,
        baselineAnalysis,
        analyzer: petAnalyzer,
        sourceId: sample.imageId,
        signal: options.signal,
      })
      : {
        analysis: baselineAnalysis,
        diagnostics: analysisDiagnostics(baselineAnalysis, 'deterministic-baseline', []),
      }
    const analysis = resolvedAnalysis.analysis
    const sampleDirectory = join(outputDirectory, sample.imageId)
    await mkdir(sampleDirectory, { recursive: true })
    const candidateEntries = []
    const providerWarnings = []
    const candidateInputs = planAutoEvalCandidateInputs({
      category: sample.category,
      image,
      analysis,
      learnedModel,
    })
    for (const recipe of candidateInputs) {
      const candidateAnalysis = recipe.analysis
      const result = await algorithm.generate({
        image,
        palette,
        analysis: candidateAnalysis,
        options: recipe.options,
      })
      const candidate = result.recommended ?? result.bestEffort
      if (candidate === undefined) throw new Error(`Generation produced no candidate for ${sample.imageId}/${recipe.id}`)
      const imagePath = join(sampleDirectory, `${recipe.id}.png`)
      const outlinePath = join(sampleDirectory, `${recipe.id}.outline.png`)
      await renderPattern(candidate, imagePath)
      await renderPattern(candidate, outlinePath, { outline: true })
      const entry = {
        ...preferenceCandidateFromPattern(recipe.id, candidate),
        algorithmCandidateId: candidate.id,
        imagePath,
        outlinePath,
        score: candidate.score,
        metrics: candidate.metrics,
        options: recipe.options,
        ...(recipe.composition === undefined ? {} : { composition: recipe.composition }),
      }
      const candidateImage = openClipScorer === undefined && dinoV2Scorer === undefined
        ? undefined
        : await rgbaImage(imagePath)
      const openClipViewPlan = candidateImage === undefined ? undefined : createCandidateOpenClipViewPlan({
        referenceImage: image,
        candidateImage,
        analysis: candidateAnalysis,
        candidate,
      })
      const views = openClipViewPlan?.views
      const globalView = views?.find((view) => view.id === 'global')
      const request = {
        referenceImage: globalView?.referenceImage ?? image,
        ...(candidateImage === undefined ? {} : {
          candidateImage: globalView?.candidateImage ?? candidateImage,
        }),
        sourceId: sample.imageId,
        candidateId: recipe.id,
        imageTypeHint: imageType(sample.category),
        targetGrid: entry.grid,
        paletteId: entry.paletteId,
        styleId: entry.style,
        signal: options.signal,
      }
      const [dinoV2Scored, openClipScored] = await Promise.all([
        scoreDinoV2Candidate({ scorer: dinoV2Scorer, request }),
        scoreOpenClipCandidateViews({
          scorer: openClipScorer,
          request,
          ...(views === undefined ? {} : { views }),
          plannedViewIds: openClipViewPlan?.plannedViewIds,
        }),
      ])
      const preferenceFeatures = []
      if (dinoV2Scored.score !== undefined) {
        entry.dinoV2Evaluation = dinoV2Scored.score
        preferenceFeatures.push(dinoV2NeuralFeature(dinoV2Scored.score))
      }
      if (openClipScored.score !== undefined) {
        entry.openClipEvaluation = openClipScored.score
        const feature = openClipNeuralFeature(openClipScored.score, subjectKind(sample.category))
        preferenceFeatures.push(feature)
        entry.neuralPreferenceFeatures = feature
      } else if (preferenceFeatures.length > 0) {
        entry.neuralPreferenceFeatures = preferenceFeatures[0]
      }
      if (preferenceFeatures.length > 0) entry.preferenceFeatures = preferenceFeatures
      const scoringWarnings = [
        ...(dinoV2Scored.warning === undefined ? [] : [dinoV2Scored.warning]),
        ...(openClipScored.warnings
          ?? (openClipScored.warning === undefined ? [] : [openClipScored.warning])),
      ]
      for (const warning of scoringWarnings) {
        if (providerWarnings.length < 100) providerWarnings.push(warning)
      }
      candidateEntries.push(entry)
    }
    const evaluation = composeAutoEvalCandidateEvaluation(
      candidateEntries,
      providerWarnings,
      resolvedAnalysis.diagnostics.providerContributions,
    )
    const sheetPath = join(sampleDirectory, 'comparison.png')
    await renderSampleSheet({ sourcePath, imageId: sample.imageId, candidates: candidateEntries, outputPath: sheetPath })
    const categorySheets = sheetsByCategory.get(sample.category) ?? []
    categorySheets.push(sheetPath)
    sheetsByCategory.set(sample.category, categorySheets)
    generations.push({
      generationId: `auto-eval:${manifest.datasetId}:${sample.imageId}`,
      datasetId: manifest.datasetId,
      source: {
        id: sample.imageId,
        groupId: sample.imageId,
        subjectKind: subjectKind(sample.category),
        category: sample.category,
        cohort: sample.cohort,
        failureTags: sample.failureTags,
        imagePath: sourcePath,
      },
      candidates: candidateEntries,
      evaluation,
      diagnostics: {
        analysis: resolvedAnalysis.diagnostics,
        ...(sample.category !== 'pet' ? {} : {
          petCompositions: candidateInputs
            .map((input) => input.composition)
            .filter((composition, index, all) => composition !== undefined
              && all.findIndex((candidate) => candidate?.id === composition.id) === index),
        }),
      },
      ...(providerWarnings.length === 0 ? {} : { providerWarnings }),
      comparisonSheetPath: sheetPath,
    })
  }
  const batchSheets = {}
  for (const [category, paths] of sheetsByCategory) {
    const outputPath = join(outputDirectory, `${category}-comparisons.png`)
    await renderBatchSheet(paths, outputPath)
    batchSheets[category] = outputPath
  }
  const index = {
    schemaVersion: 'auto-eval-candidates-v1',
    datasetId: manifest.datasetId,
    generatedAt: new Date().toISOString(),
    sourceManifest: manifestPath,
    sourceSidecars: sidecarDirectory,
    learnedModelVersion: learnedModel?.version,
    generations,
    batchSheets,
  }
  const indexPath = join(outputDirectory, 'candidate-index.json')
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`)
  return { indexPath, index }
}
