import { rgbDistance, rgbToLab, type PreparedColor } from '../color.js'
import { applyArtDirectionImportance, enforceTileSeams, planPixelArtDirection } from '../art-direction.js'
import { normalizeEvidenceProvenance, subjectMaskTrust } from '../analysis-evidence.js'
import { countIsolatedCells, countThinStripes, optimizeGrid } from '../grid.js'
import { identityAppearanceSimilarity } from '../identity-similarity.js'
import { applyStyle, resizePixels, samplePixelsAtSourceMapping, type ResizedPixels } from '../image.js'
import { optimizePaletteAssignments } from '../palette-optimization.js'
import { refineGridClusters } from '../grid-refinement.js'
import { resolveFeatureColors, buildStructurePlan, buildValuePlan, buildPalettePlan, quantizePalette, enforcePaletteInventory, styleColorLimit, type ResolvedFeaturePlacement, type ResolvedOccupancyMode, type PaletteDistanceMatrixCache } from '../planning/index.js'
import type { CanvasPlan, StructurePlan } from '../contracts.js'
import { type ShapeRasterization } from '../shape.js'
import {
  assessPetInstanceIntegrity,
  evaluatePetPoseStructure,
  PetPoseProjectionCache,
} from '../pet-pose.js'
import { designRegionValues, type SourceGuidance } from '../structure.js'
import type { BaselineMode, ColorDistanceMethod, CropRect, GridSize, ImageLandmark, PatternCandidate, PatternCell, PatternGenerationRequest, PatternMetadata, PatternStyle, ResizeMethod } from '../types.js'
import { gridRegionIds, buildImportanceWeights, hasDetailedColorEvidence, semanticMaterialMap, paletteColorsInStock } from './evidence.js'
import { planFeaturePlacements, plannedFeatureConstraints, protectedCells } from '../planning/index.js'
import { preferredFeaturePaletteColorIds, materialCounts, boundaryAgreement, referenceMetrics, finalMeanColorDistance, valueOrderAccuracy, paletteRoleConsistency, featureVisibility, scoreCandidate } from './evaluation.js'
import { stableSerialize, stableHash } from './identity.js'

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export interface CandidateContext {
  request: PatternGenerationRequest
  crop: CropRect
  size: GridSize
  style: PatternStyle
  baseline: BaselineMode
  resizeMethod: ResizeMethod
  distanceMethod: ColorDistanceMethod
  preparedPalette: readonly PreparedColor[]
  sourceGuidance: SourceGuidance
  preserveThinStructures: boolean
  shapeRasterization: ShapeRasterization | undefined
  occupancyMode: ResolvedOccupancyMode
  canvasPlan: CanvasPlan
  petPoseProjectionCache: PetPoseProjectionCache
  distanceMatrixCache: PaletteDistanceMatrixCache
  structurePlanCache: Map<string, StructurePlan | undefined>
  resizedPixelCache: Map<string, { resized: ResizedPixels; rawResized: ResizedPixels }>
}

function metadata(
  request: PatternGenerationRequest,
  version: string,
  style: PatternStyle,
  baseline: BaselineMode,
  totalBeads: number,
  generatedAt: number,
): PatternMetadata {
  const evidence = request.analysis
  const provenance = [
    ...(evidence?.provenance ?? []),
    ...(evidence?.subjectMaskEvidence?.provenance ?? []),
    ...(evidence?.semanticRegions ?? []).flatMap((region) => region.provenance ?? []),
    ...(evidence?.landmarks ?? []).flatMap((landmark) => landmark.provenance ?? []),
  ]
  const modelProvenance = normalizeEvidenceProvenance(provenance)
    .filter((entry) => entry.origin === 'model')
  const modelEntry = modelProvenance[0]
  const modelEvidence = modelProvenance.length > 0
    || Object.keys(evidence?.modelVersions ?? {}).length > 0
    || evidence?.subjectMaskEvidence?.source === 'ai'
    || evidence?.subjectMaskEvidence?.source === 'ai+manual'
  const result: PatternMetadata = {
    sourceWidth: request.image.width,
    sourceHeight: request.image.height,
    totalBeads,
    generatedAt,
    algorithmVersion: version,
    aiEnhanced: modelEvidence,
    style,
    baseline,
    engine: 'baseline',
    outlineMode: request.options.structure?.outlineMode
      ?? ((request.options.structure?.valueLevels ?? 3) === 4 ? 'selective' : 'off'),
  }
  if (modelEntry?.provider !== undefined) result.aiProvider = modelEntry.provider
  if (modelEntry?.model !== undefined) result.aiModel = modelEntry.model
  if (result.aiProvider === undefined || result.aiModel === undefined) {
    const [name, version] = Object.entries(evidence?.modelVersions ?? {})[0] ?? []
    if (result.aiProvider === undefined && name !== undefined) result.aiProvider = name
    if (result.aiModel === undefined && version !== undefined) result.aiModel = version
  }
  if (request.options.beadDiameterMm !== undefined) {
    result.beadDiameterMm = request.options.beadDiameterMm
  }
  return result
}

export function generateCandidate(
  context: CandidateContext,
  generationId: string,
  version: string,
  clock: () => number,
): PatternCandidate {
  const startedAt = performance.now()
  const { request, crop, size, style, baseline, resizeMethod, distanceMethod } = context
  const structureOptions = request.options.structure ?? {}
  const focusLandmarks = (request.analysis?.landmarks ?? [])
    .filter((landmark) => landmark.confidence >= 0.5)
  const focus = focusLandmarks.length === 0
    ? undefined
    : [
      focusLandmarks.reduce((sum, landmark) => sum + landmark.x, 0)
        / focusLandmarks.length / request.image.width,
      focusLandmarks.reduce((sum, landmark) => sum + landmark.y, 0)
        / focusLandmarks.length / request.image.height,
    ] as const
  const resolvedFocus = request.options.artDirection?.focus ?? focus
  const artDirection = planPixelArtDirection({
    width: size.width,
    height: size.height,
    style,
    imageType: request.analysis?.imageType ?? request.options.imageType ?? 'general',
    subjectOccupancy: context.canvasPlan.subjectCoverage,
    semanticLabels: (request.analysis?.semanticRegions ?? []).flatMap((region) => [region.id, region.label]),
    ...(resolvedFocus === undefined
      ? {}
      : { focus: resolvedFocus }),
    ...(request.options.artDirection?.lightDirection === undefined
      ? {} : { lightDirection: request.options.artDirection.lightDirection }),
    ...(request.options.artDirection?.depthRange === undefined
      ? {} : { depthRange: request.options.artDirection.depthRange }),
    ...(request.options.artDirection?.mode === undefined
      ? {} : { mode: request.options.artDirection.mode }),
    ...(request.options.artDirection?.tileEdges === undefined
      ? {} : { tileEdges: request.options.artDirection.tileEdges }),
    ...(request.options.artDirection?.frame === undefined
      ? {} : { frame: request.options.artDirection.frame }),
    ...(request.options.beadDiameterMm === undefined
      ? {} : { beadDiameterMm: request.options.beadDiameterMm }),
  })
  const resizedCacheKey = `${size.width}x${size.height}:${baseline}:${resizeMethod}:${context.preserveThinStructures ? 'thin' : 'standard'}`
  const resizedPair = context.resizedPixelCache.get(resizedCacheKey) ?? (() => {
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
        preserveThinStructures: context.preserveThinStructures,
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
    const pair = { resized, rawResized }
    context.resizedPixelCache.set(resizedCacheKey, pair)
    return pair
  })()
  const { resized, rawResized } = resizedPair
  const shapeRasterization = context.shapeRasterization
  const activeMask = shapeRasterization?.activeMask ?? resized.activeMask
  const regionIds = gridRegionIds(
    request.analysis,
    crop,
    size.width,
    size.height,
    resized.fit,
    activeMask,
  )
  const baseWeights = buildImportanceWeights(
    request.analysis,
    context.sourceGuidance,
    crop,
    size.width,
    size.height,
    resized.fit,
    activeMask,
  )
  const semanticLabels = new Map((request.analysis?.semanticRegions ?? []).map((region) => [
    region.id,
    `${region.id} ${region.label}`,
  ]))
  const explicitArtDirection = request.options.artDirection !== undefined
  const importanceExecution = explicitArtDirection
    ? applyArtDirectionImportance({
      plan: artDirection,
      width: size.width,
      height: size.height,
      activeMask,
      baseImportance: baseWeights,
      semanticLabelsByCell: regionIds.map((regionId) =>
        regionId === undefined ? undefined : semanticLabels.get(regionId) ?? regionId),
    })
    : {
      importance: baseWeights,
      summary: {
        changedCells: 0,
        backgroundCompressedCells: 0,
        focusEnhancedCells: 0,
        maximumFocusBoost: 0,
        layerCells: { background: 0, middle: 0, foreground: 0 },
      },
    }
  const weights = [...importanceExecution.importance]
  const thinDetailCells = new Set<number>()
  if (context.preserveThinStructures) {
    const background = request.options.backgroundRgb ?? [255, 255, 255]
    for (let index = 0; index < resized.pixels.length; index += 1) {
      if (activeMask[index] === 1 && rgbDistance(resized.pixels[index]!, background) >= 48) {
        weights[index] = Math.max(weights[index] ?? 1, 3.5)
        thinDetailCells.add(index)
      }
    }
  }
  const sourceLabs = rawResized.pixels.map(rgbToLab)
  const valueLevels = structureOptions.valueLevels
    ?? artDirection.generation.valueLevels
  const featurePlacements = baseline === 'mvp'
    ? planFeaturePlacements(request.analysis, context.canvasPlan, activeMask, regionIds)
    : []
  const hardFeatureIds = new Set((request.analysis?.landmarks ?? [])
    .filter((landmark) => landmark.priority === 'hard'
      && (landmark.kind === 'eye' || landmark.kind === 'mouth' || landmark.kind === 'nose'
        || landmark.kind === 'ear' || landmark.kind === 'identity-mark' || landmark.kind === 'custom'))
    .map((landmark) => landmark.id))
  const placedFeatureIds = new Set(featurePlacements.map((placement) => placement.featureId))
  const hardFeatureCompleteness = hardFeatureIds.size === 0
    ? 1
    : [...hardFeatureIds].filter((featureId) => placedFeatureIds.has(featureId)).length / hardFeatureIds.size
  const featureCellOwners = new Map<number, number>()
  for (const placement of featurePlacements) {
    for (const cell of placement.occupiedCells) {
      featureCellOwners.set(cell, (featureCellOwners.get(cell) ?? 0) + 1)
    }
  }
  const featureCollisionCount = [...featureCellOwners.values()].filter((owners) => owners > 1).length
  const landmarkById = new Map((request.analysis?.landmarks ?? []).map((landmark) => [landmark.id, landmark]))
  const symmetryGroups = new Map<string, ResolvedFeaturePlacement[]>()
  for (const placement of featurePlacements) {
    const groupId = landmarkById.get(placement.featureId)?.symmetryGroup
    if (groupId === undefined) continue
    const group = symmetryGroups.get(groupId) ?? []
    group.push(placement)
    symmetryGroups.set(groupId, group)
  }
  const symmetryErrors = [...symmetryGroups.values()].flatMap((group) => {
    if (group.length !== 2) return []
    const ordered = [...group].sort((first, second) => first.center[0] - second.center[0])
    return [clamp((Math.abs(ordered[0]!.shift[0] + ordered[1]!.shift[0])
      + Math.abs(ordered[0]!.shift[1] - ordered[1]!.shift[1])) / 4, 0, 1)]
  })
  const featureSymmetryError = symmetryErrors.length === 0
    ? 0
    : symmetryErrors.reduce((sum, value) => sum + value, 0) / symmetryErrors.length
  const structurePlanKey = stableHash(stableSerialize({
    generationId,
    size,
    style,
    baseline,
    occupancyMode: context.occupancyMode,
    shape: shapeRasterization === undefined ? 'full' : 'shape',
    resizeMethod,
    preserveThinStructures: context.preserveThinStructures,
    structure: structureOptions,
    artDirection: {
      profile: artDirection.profile.id,
      generation: artDirection.generation,
      lightDirection: artDirection.lightDirection,
      depthOfFieldStrength: artDirection.scene.depthOfFieldStrength,
    },
    evidence: {
      modelVersions: request.analysis?.modelVersions,
      subjectRevision: request.analysis?.subjectMaskEvidence?.revision,
      provenance: normalizeEvidenceProvenance(request.analysis?.provenance),
    },
  }))
  const structurePlan = baseline === 'mvp'
    ? context.structurePlanCache.has(structurePlanKey)
      ? context.structurePlanCache.get(structurePlanKey)
      : (() => {
        const plan = buildStructurePlan({
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
        context.structurePlanCache.set(structurePlanKey, plan)
        return plan
      })()
    : undefined
  const structurePlanningActive = baseline === 'mvp'
    && structurePlan !== undefined
    && context.preserveThinStructures === false
    && regionIds.some((regionId) => regionId !== undefined)
  const colorPlanningActive = structurePlanningActive
    && hasDetailedColorEvidence(request.analysis, featurePlacements)
  const structureMappingActive = structurePlanningActive
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
      colorPlanningActive ? regionIds : undefined,
    )
    : styledPixels
  const valuePlanning = colorPlanningActive && structurePlan !== undefined
    ? buildValuePlan({
      structurePlan,
      pixelLabs: pixels.map(rgbToLab),
      activeMask,
      levels: valueLevels,
      ...(structureOptions.outlineMode === undefined
        ? {} : { outlineMode: structureOptions.outlineMode }),
      minimumSemanticGaps: {
        eyeSkin: 16 * clamp(structureOptions.valueOrderStrength ?? 1, 0.25, 2),
        faceHair: 10 * clamp(structureOptions.valueOrderStrength ?? 1, 0.25, 2),
        subjectBackground: 12 * clamp(structureOptions.valueOrderStrength ?? 1, 0.25, 2),
      },
      lighting: {
        direction: artDirection.lightDirection,
        intensity: clamp(0.55 + artDirection.profile.edgeRhythm * 0.3, 0.55, 0.85),
        ambientLight: clamp(0.16 + (1 - artDirection.outline.shadowOpacity) * 0.35, 0.16, 0.36),
      },
      materialByRegionId: semanticMaterialMap(request.analysis),
    })
    : undefined
  const pixelLabs = valuePlanning?.plannedLabs ?? pixels.map(rgbToLab)
  const availablePalette = paletteColorsInStock(request.palette, context.preparedPalette)
  const styleMaximumColors = styleColorLimit(
    style,
    Math.min(request.options.maxColors, availablePalette.length),
  )
  const maximumColors = Math.max(1, Math.min(
    styleMaximumColors,
    Math.round(Math.min(request.options.maxColors, availablePalette.length)
      * artDirection.generation.maxColorFactor),
  ))
  const preferredFeatureColors = preferredFeaturePaletteColorIds(request, availablePalette)
  const requiredFeatureColors = [...new Set(preferredFeatureColors.values())].slice(0, maximumColors)
  const palettePlanning = colorPlanningActive && structurePlan !== undefined
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
      requiredColorIds: requiredFeatureColors,
      ...(request.palette.inventory === undefined
        ? {}
        : { inventory: request.palette.inventory }),
      ...(request.palette.substituteColorIds === undefined
        ? {}
        : { substituteColorIds: request.palette.substituteColorIds }),
    })
    : undefined
  const selectedPaletteIds = new Set(palettePlanning?.plan.selectedColorIds ?? [])
  const quantized = palettePlanning === undefined
    ? quantizePalette({
      pixels,
      pixelLabs,
      weights,
      colors: context.preparedPalette,
      maximumColors,
      baseline,
      distanceMethod,
      activeMask,
      requiredColorIds: requiredFeatureColors,
      ...(request.palette.inventory === undefined ? {} : { inventory: request.palette.inventory }),
      distanceMatrixCache: context.distanceMatrixCache,
    })
    : undefined
  const selectedPalette = quantized?.selectedColors
    ?? context.preparedPalette.filter((color) => selectedPaletteIds.has(color.id))
  const selectedFeatureColorIds = new Set(selectedPalette.map((color) => color.id))
  const assigned = palettePlanning === undefined
    ? { colorIds: quantized!.colorIds }
    : { colorIds: palettePlanning.colorIds }
  const landmarkProtected = protectedCells(
    request.analysis,
    crop,
    size.width,
    size.height,
    resized.fit,
    activeMask,
  )
  const outlineRoleIds = new Set(valuePlanning?.plan.roles
    .filter((role) => role.kind === 'outline')
    .map((role) => role.id) ?? [])
  const plannedOutlineCells = valuePlanning?.roleIdsByCell.flatMap((roleId, cell) =>
    roleId !== undefined && outlineRoleIds.has(roleId) ? [cell] : []) ?? []
  const protectedSet = new Set([
    ...landmarkProtected,
    ...(shapeRasterization?.protectedCells ?? []),
    ...thinDetailCells,
    ...featurePlacements.flatMap((placement) => placement.occupiedCells),
    ...plannedOutlineCells,
  ])
  const semanticFeatureIds = new Set((request.analysis?.landmarks ?? [])
    .filter((landmark) => landmark.carrierRegionId !== undefined)
    .map((landmark) => landmark.id))
  const colorPlacements = featurePlacements.filter((placement) =>
    semanticFeatureIds.has(placement.featureId))
  const colorPlacementIds = new Set(colorPlacements.map((placement) => placement.featureId))
  const selectedFeaturePreferences = new Map([...preferredFeatureColors].filter(([featureId, colorId]) =>
    colorPlacementIds.has(featureId) && selectedFeatureColorIds.has(colorId)))
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
      preferredColorIdsByFeature: selectedFeaturePreferences,
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
      coherence: Math.max(0, request.options.optimization?.paletteCoherence
        ?? artDirection.generation.paletteCoherence),
      edgeProtection: clamp(request.options.optimization?.edgeProtection
        ?? artDirection.generation.edgeProtection, 0, 1),
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
      isolatedPixelPenalty: request.options.optimization?.isolatedPixelPenalty
        ?? artDirection.generation.isolatedPixelPenalty,
      stripePenalty: request.options.optimization?.stripePenalty
        ?? artDirection.generation.stripePenalty,
      aliasPenalty: request.options.optimization?.aliasPenalty
        ?? artDirection.generation.aliasPenalty,
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
  const gridRefinementActive = baseline === 'mvp'
    && structurePlan !== undefined
    && context.preserveThinStructures === false
    && (structurePlanningActive || request.options.optimization?.refinementMode === 'quality')
  const refinementBudgets = explicitArtDirection
    && request.options.optimization?.refinementMode === 'quality'
    ? {
      transitionCells: artDirection.transitionBudget,
      ditherPatterns: Math.round(size.width * size.height * artDirection.dither.patternDensity),
      maximumColorSwitches: artDirection.dither.maximumColorSwitches,
      localNoiseCells: artDirection.dither.localNoiseBudget,
    }
    : undefined
  const gridRefinement = gridRefinementActive
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
      ...(refinementBudgets === undefined ? {} : { budgets: refinementBudgets }),
    })
    : undefined
  const preSeamColorIds = gridRefinement?.colorIds ?? optimization.colorIds
  const tileSeams = explicitArtDirection && request.options.artDirection?.mode === 'tile'
    && request.options.artDirection.tileEdges !== undefined
    ? enforceTileSeams({
      colorIds: preSeamColorIds,
      width: size.width,
      height: size.height,
      activeMask,
      protectedCells: protectedSet,
      tileEdges: request.options.artDirection.tileEdges,
    })
    : undefined
  const preInventoryColorIds = tileSeams?.colorIds ?? preSeamColorIds
  const inventoryRepair = enforcePaletteInventory({
    colorIds: preInventoryColorIds,
    width: size.width,
    colors: selectedPalette,
    pixelLabs,
    activeMask,
    importance: weights,
    protectedCells: protectedSet,
    ...(request.palette.inventory === undefined ? {} : { inventory: request.palette.inventory }),
    ...(request.palette.substituteColorIds === undefined
      ? {}
      : { substituteColorIds: request.palette.substituteColorIds }),
  })
  const finalColorIds = inventoryRepair.colorIds
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
    featurePlacements,
  )
  const colorsByIdForIdentity = new Map(selectedPalette.map((color) => [color.id, color.rgb]))
  const identityAppearance = identityAppearanceSimilarity(
    rawResized.pixels,
    finalColorIds.map((colorId, index) => colorsByIdForIdentity.get(colorId) ?? rawResized.pixels[index]!),
    activeMask,
    size.width,
    size.height,
  )
  const petPose = evaluatePetPoseStructure({
    analysis: request.analysis,
    crop,
    fit: resized.fit,
    width: size.width,
    height: size.height,
    activeMask,
    projectionCache: context.petPoseProjectionCache,
  })
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
    identityAppearance,
    petPose,
    hardFeatureCompleteness,
    finalValueOrderAccuracy,
    gridRefinement?.diagnosticsAfter.fragmentedArcSegments ?? 0,
    gridRefinement?.diagnosticsAfter.smallComponents ?? 0,
    gridRefinement?.diagnosticsAfter.singleCellBands ?? 0,
    shapeRasterization?.diagnostics,
  )
  if (context.occupancyMode === 'full-frame' && subjectMaskTrust(request.analysis) >= 0.75) {
    score.total = clamp(score.total - 0.14, 0, 1)
  }
  const identityCritical = (request.analysis?.imageType ?? request.options.imageType) === 'pet'
    && visibility.confidence >= 0.45
  const petInstanceIntegrity = assessPetInstanceIntegrity(petPose)
  const appliesPetPoseGate = petPose.available && petPose.confidence >= 0.45
  const poseValid = appliesPetPoseGate === false || petPose.score >= 0.4
  const requiredEarSpanCells = size.width >= 64 ? 4 : size.width >= 48 ? 3 : 2
  const requiredMuzzleSeparationCells = size.width >= 48 ? 2 : 1
  const maximumFrontVerticalRunRatio = size.width >= 64
    ? 0.35
    : size.width >= 48 ? 0.45 : size.width >= 32 ? 0.55 : 0.72
  const earValid = appliesPetPoseGate === false
    || (petPose.earConnected
      && petPose.earSpanCells >= requiredEarSpanCells
      && petPose.earStructure >= 0.55)
  const muzzleValid = appliesPetPoseGate === false
    || (petPose.muzzleStructure >= 0.55
      && petPose.muzzleSeparationCells >= requiredMuzzleSeparationCells)
  const frontColumnValid = appliesPetPoseGate === false
    || petPose.frontVerticalRunRatio <= maximumFrontVerticalRunRatio
  const semanticIdentityValid = (
    identityCritical === false
      || (score.identity >= 0.38
        && hardFeatureCompleteness >= 0.6
        && poseValid
        && earValid
        && muzzleValid
        && frontColumnValid)
  )
  const identityValid = petInstanceIntegrity.valid && semanticIdentityValid
  const rejectionReasons = [...new Set([
    ...context.canvasPlan.rejectionReasons,
    ...visibility.rejectionReasons,
    ...(identityValid ? [] : ['pet-identity-low-similarity']),
    ...(poseValid ? [] : ['pet-pose-structure']),
    ...(earValid ? [] : ['pet-ear-disconnected']),
    ...(muzzleValid ? [] : ['pet-muzzle-collapsed']),
    ...(frontColumnValid ? [] : ['pet-front-column']),
    ...petInstanceIntegrity.rejectionReasons,
    ...(inventoryRepair.valid ? [] : ['palette-inventory-insufficient']),
  ])].sort()
  const artDirectionExecution = {
    enabled: explicitArtDirection,
    importance: importanceExecution.summary,
    ...(refinementBudgets === undefined || gridRefinement === undefined
      ? {}
      : {
        refinement: {
          ...refinementBudgets,
          violationsBefore: gridRefinement.budgetViolationsBefore.total,
          violationsAfter: gridRefinement.budgetViolationsAfter.total,
        },
      }),
    ...(tileSeams === undefined ? {} : { tile: tileSeams.summary }),
    ...(explicitArtDirection && artDirection.animation !== undefined
      ? {
        animation: {
          sharedGridId: artDirection.animation.sharedGridId,
          sharedPaletteId: artDirection.animation.sharedPaletteId,
          keyFrameScore: artDirection.animation.keyFrameScore,
        },
      }
      : {}),
  }
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
    artDirection: artDirection.profile.id,
    ...(explicitArtDirection ? { artDirectionExecution } : {}),
    structure: request.options.structure ?? {},
    optimization: request.options.optimization ?? {},
  })
  const variantId = stableHash(variantIdentity)
  return {
    id: `${generationId}-${variantId}`,
    generationId,
    variantId,
    style,
    valid: context.canvasPlan.feasible && visibility.valid && identityValid && inventoryRepair.valid,
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
      hardFeatureCompleteness,
      featureCollisionCount,
      featureSymmetryError,
      petPoseAvailable: petPose.available,
      petPoseScore: petPose.score,
      petPoseConfidence: petPose.confidence,
      petLandmarkCoverage: petPose.landmarkCoverage,
      petSkeletonContinuity: petPose.skeletonContinuity,
      petTorsoAxisAgreement: petPose.torsoAxisAgreement,
      petBoneRatio: petPose.boneRatio,
      petGroundContact: petPose.groundContact,
      petNegativeSpace: petPose.negativeSpace,
      petTailPathQuality: petPose.tailPathQuality,
      petBoundaryRhythm: petPose.boundaryRhythm,
      petEarStructure: petPose.earStructure,
      petEarSpanCells: petPose.earSpanCells,
      petEarConnected: petPose.earConnected,
      petMuzzleStructure: petPose.muzzleStructure,
      petMuzzleSeparationCells: petPose.muzzleSeparationCells,
      petFrontVerticalRunRatio: petPose.frontVerticalRunRatio,
      petFrontChestScore: petPose.frontChestScore,
      petInstanceCount: petPose.instanceCount,
      petSubjectComponentRecall: petPose.subjectComponentRecall,
      petWeakestInstanceIdentityCompleteness: petPose.weakestInstanceIdentityCompleteness,
      petCrossInstanceCollisionRate: petPose.crossInstanceCollisionRate,
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
      shapeTopologyCenterlinePrecision: shapeRasterization?.diagnostics.topologyCenterlinePrecision ?? 1,
      shapeTopologyCenterlineRecall: shapeRasterization?.diagnostics.topologyCenterlineRecall ?? 1,
      shapeTopologyClDice: shapeRasterization?.diagnostics.topologyClDice ?? 1,
      shapeTopologyWeightedClDice: shapeRasterization?.diagnostics.topologyWeightedClDice ?? 1,
      shapeTopologyEndpointF1: shapeRasterization?.diagnostics.topologyEndpointF1 ?? 1,
      shapeTopologyJunctionF1: shapeRasterization?.diagnostics.topologyJunctionF1 ?? 1,
      shapeTopologyBranchCountAgreement: shapeRasterization?.diagnostics.topologyBranchCountAgreement ?? 1,
      shapeTopologyCycleCountAgreement: shapeRasterization?.diagnostics.topologyCycleCountAgreement ?? 1,
      shapeTopologyComponentCountAgreement: shapeRasterization?.diagnostics.topologyComponentCountAgreement ?? 1,
      shapeTopologyScore: shapeRasterization?.diagnostics.topologyScore ?? 1,
      orthogonalBridgeCells: shapeRasterization?.diagnostics.orthogonalBridgeCells ?? 0,
      fragileOrthogonalBridgeCells: shapeRasterization?.diagnostics.fragileOrthogonalBridgeCells ?? 0,
      craftComponentsBeforeBridging: shapeRasterization?.diagnostics.craftComponentsBeforeBridging ?? 0,
      craftComponentsAfterBridging: shapeRasterization?.diagnostics.craftComponentsAfterBridging ?? 0,
      shapeMeanBoundaryDistance: shapeRasterization?.diagnostics.meanBoundaryDistance ?? 0,
      referenceShapeComponents: shapeRasterization?.diagnostics.referenceComponents ?? 0,
      targetShapeComponents: shapeRasterization?.diagnostics.targetComponents ?? 0,
      referenceShapeHoles: shapeRasterization?.diagnostics.referenceHoles ?? 0,
      targetShapeHoles: shapeRasterization?.diagnostics.targetHoles ?? 0,
      shapeEdits: shapeRasterization?.diagnostics.shapeEdits ?? 0,
      artDirectionImportanceChanges: importanceExecution.summary.changedCells,
      artDirectionBackgroundCompressedCells: importanceExecution.summary.backgroundCompressedCells,
      artDirectionBudgetViolations: gridRefinement?.budgetViolationsAfter.total ?? 0,
      transitionCells: gridRefinement?.diagnosticsAfter.transitionCells ?? 0,
      colorSwitches: gridRefinement?.diagnosticsAfter.colorSwitches ?? 0,
      localNoiseCells: gridRefinement?.diagnosticsAfter.localNoiseCells ?? 0,
      ditherPatterns: gridRefinement?.diagnosticsAfter.ditherPatterns ?? 0,
      tileSeamMismatches: tileSeams?.summary.mismatchesAfter ?? 0,
      tileSeamEdits: tileSeams?.summary.seamEdits ?? 0,
    },
    score,
    canvasPlan: context.canvasPlan,
    artDirection,
    artDirectionExecution,
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
          diagnosticsBefore: gridRefinement.diagnosticsBefore,
          diagnosticsAfter: gridRefinement.diagnosticsAfter,
          ...(gridRefinement.budgets === undefined ? {} : { budgets: gridRefinement.budgets }),
          budgetViolationsBefore: gridRefinement.budgetViolationsBefore,
          budgetViolationsAfter: gridRefinement.budgetViolationsAfter,
        },
      }),
    edits: [
      ...featureColors.edits,
      ...paletteEdits,
      ...optimization.edits,
      ...(gridRefinement?.edits ?? []),
      ...(tileSeams?.edits ?? []),
      ...inventoryRepair.edits,
    ],
  }
}
