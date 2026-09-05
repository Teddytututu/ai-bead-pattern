import { colorDistance, rgbToLab, type PreparedColor } from '../color.js'
import { gridCellForSourcePoint, resizePixels, type CanvasFit } from '../image.js'
import { landmarkEffectiveConfidence, landmarkGridRadiusCells } from '../landmarks.js'
import { type ResolvedFeaturePlacement } from '../planning/index.js'
import type { PalettePlan, ValuePlan, ValueRole } from '../contracts.js'
import type { CandidateScore, CropRect, ImageAnalysis, LandmarkKind, Lab, MaterialCount, PatternGenerationRequest, PatternStyle, RGB } from '../types.js'

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function materialCounts(
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

export function finalMeanColorDistance(
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

export function valueOrderAccuracy(
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

export function paletteRoleConsistency(
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

export function boundaryAgreement(
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

export function referenceMetrics(
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

export function preferredFeaturePaletteColorIds(
  request: PatternGenerationRequest,
  colors: readonly PreparedColor[],
): ReadonlyMap<string, string> {
  const kindOrder = new Map<LandmarkKind, number>([
    ['eye', 0],
    ['nose', 1],
    ['mouth', 2],
    ['identity-mark', 3],
  ])
  const landmarks = [...(request.analysis?.landmarks ?? [])]
    .filter((landmark) => landmark.priority === 'hard'
      && landmarkEffectiveConfidence(landmark) >= 0.5
      && kindOrder.has(landmark.kind))
    .sort((first, second) => kindOrder.get(first.kind)! - kindOrder.get(second.kind)!)
  const preferred = new Map<string, string>()
  for (const landmark of landmarks) {
    const sourceLab = rgbToLab(sourceRgbAt(request, landmark.x, landmark.y))
    const nearest = [...colors].sort((first, second) =>
      colorDistance(sourceLab, first.lab, 'delta-e-2000')
        - colorDistance(sourceLab, second.lab, 'delta-e-2000')
      || first.id.localeCompare(second.id))[0]
    if (nearest !== undefined) preferred.set(landmark.id, nearest.id)
  }
  return preferred
}

export function featureVisibility(
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
  featurePlacements: readonly ResolvedFeaturePlacement[],
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
  const placementByFeatureId = new Map(featurePlacements.map((placement) => [
    placement.featureId,
    placement,
  ]))
  const evaluated = landmarks.map((landmark) => {
    const profile = featureProfiles[landmark.kind]
    const effectiveConfidence = landmarkEffectiveConfidence(landmark)
    const placement = placementByFeatureId.get(landmark.id)
    const templateAware = placement !== undefined && landmark.carrierRegionId !== undefined
    const [centerX, centerY] = (templateAware ? placement?.center : undefined)
      ?? gridCellForSourcePoint(crop, fit, landmark.x, landmark.y)
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
    const ringCellSet = new Set<number>()
    if (templateAware && placement !== undefined) {
      for (const index of placement.occupiedCells) {
        if (activeMask[index] !== 1) continue
        regionCells.push(index)
        matchingCells.add(index)
        const x = index % width
        for (const neighbor of [index - width, index + width, x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1]) {
          if (neighbor >= 0 && neighbor < activeMask.length
            && activeMask[neighbor] === 1
            && placement.occupiedCells.includes(neighbor) === false) ringCellSet.add(neighbor)
        }
      }
    } else {
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
          } else ringCellSet.add(index)
        }
      }
    }
    const ringCells = [...ringCellSet]
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
    const minimumCells = templateAware === false
      ? radius === 0 ? 1 : Math.max(2, Math.ceil(regionCells.length * 0.4))
      : Math.max(1, placement.occupiedCells.length)
    const coverage = clamp(matchingCells.size / minimumCells, 0, 1)
    const purity = matchingCells.size / Math.max(1, regionCells.length)
    const connectionSeed = matchingCells.has(center) ? center : matchingCells.values().next().value ?? center
    const connectivity = connectedFeatureRatio(matchingCells, connectionSeed, width)
    const featureColors = templateAware
      ? [...new Set(regionCells.map((index) => colorIds[index]!))]
        .flatMap((id) => colorsById.get(id) ?? [])
      : [color]
    const contrast = neighborCells.length === 0 ? 0 : neighborCells.reduce((sum, index) => {
      const neighbor = colorsById.get(colorIds[index]!)
      return sum + (neighbor === undefined ? 0 : Math.max(
        0,
        ...featureColors.map((featureColor) => colorDistance(
          featureColor.lab,
          neighbor.lab,
          'delta-e-2000',
        )),
      ))
    }, 0) / neighborCells.length
    const contrastScore = clamp(contrast / 24, 0, 1)
    const featureColorIds = new Set(featureColors.map((featureColor) => featureColor.id))
    const boundaryScore = ringCells.length === 0 ? 0 : ringCells.reduce(
      (sum, index) => sum + Number(featureColorIds.has(colorIds[index]!) === false),
      0,
    ) / ringCells.length
    const sourceLab = rgbToLab(sourceRgbAt(request, landmark.x, landmark.y))
    const sourceMatch = templateAware
      ? Math.max(0, ...featureColors.map((featureColor) =>
        1 / (1 + colorDistance(sourceLab, featureColor.lab, 'delta-e-2000') / 15)))
      : 1 / (1 + colorDistance(sourceLab, color.lab, 'delta-e-2000') / 15)
    const rejectionReasons: string[] = []
    if (landmark.priority === 'hard' && effectiveConfidence >= 0.5) {
      if (coverage < profile.minimumCoverage || purity < profile.minimumPurity) {
        rejectionReasons.push('hard-feature-area')
      }
      if (connectivity < profile.minimumConnectivity) rejectionReasons.push('hard-feature-fragmented')
      if (contrastScore < profile.minimumContrast) rejectionReasons.push('hard-feature-low-contrast')
      if (boundaryScore < profile.minimumBoundary) rejectionReasons.push('hard-feature-boundary')
      if (profile.metric !== 'geometry' && profile.metric !== 'contour' && sourceMatch < 0.35) {
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

export function scoreCandidate(
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
  identityAppearance: number,
  hardFeatureCompleteness: number,
  valueOrderAccuracy: number,
  fragmentedArcSegments: number,
  smallComponents: number,
  singleCellBands: number,
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
  const silhouette = clamp(structure * 0.82 + canvasFit * 0.18, 0, 1)
  const identity = feature.confidence > 0
    ? clamp(
      featureProtection * 0.45
        + hardFeatureCompleteness * 0.25
        + identityAppearance * 0.3,
      0,
      1,
    )
    : clamp(identityAppearance * 0.7 + 0.15, 0, 1)
  const valueHierarchy = clamp(valueOrderAccuracy, 0, 1)
  const pixelClusters = clamp(1 - (
    isolatedCells * 2 + thinStripes + fragmentedArcSegments + smallComponents * 2 + singleCellBands
  ) / Math.max(1, totalCells), 0, 1)
  const craftCost = 1 - craftEase
  const styleBias: Record<PatternStyle, number> = {
    faithful: 0.015,
    cute: 0,
    simple: 0.01,
    'high-contrast': 0.005,
    soft: 0,
  }
  const identityWeight = 0.22 + 0.1 * feature.confidence
  const colorWeight = style === 'faithful' ? 0.12 : 0.09
  const craftWeight = style === 'simple' ? 0.1 : 0.07
  const totalWeight = 0.25 + identityWeight + 0.15 + 0.13 + colorWeight + craftWeight + 0.06
  const weightedTotal = silhouette * 0.25
    + identity * identityWeight
    + valueHierarchy * 0.15
    + pixelClusters * 0.13
    + colorFidelity * colorWeight
    + craftEase * craftWeight
    + canvasFit * 0.06
  const total = clamp(weightedTotal / totalWeight + styleBias[style], 0, 1)
  return {
    total,
    silhouette,
    identity,
    identityAppearance,
    valueHierarchy,
    pixelClusters,
    craftCost,
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
