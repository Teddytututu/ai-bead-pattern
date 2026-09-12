import { type PreparedColor } from '../color.js'
import { resolvedSubjectMask, subjectMaskTrust } from '../analysis-evidence.js'
import { gridCellForSourcePoint, sourcePointForGridCell, type CanvasFit } from '../image.js'
import { landmarkEffectiveConfidence, landmarkGridRadiusCells } from '../landmarks.js'
import { type MaterialValueKind, type ResolvedFeaturePlacement } from '../planning/index.js'
import { type SourceGuidance } from '../structure.js'
import type { CropRect, ImageAnalysis, MaterialPalette, PatternGenerationRequest } from '../types.js'

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function buildImportanceWeights(
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

export function gridRegionIds(
  analysis: ImageAnalysis | undefined,
  crop: CropRect,
  width: number,
  height: number,
  fit: CanvasFit,
  activeMask: Uint8Array,
): readonly (string | undefined)[] {
  const ids: Array<string | undefined> = new Array(width * height)
  const regions = analysis?.semanticRegions ?? []
  const fallbackRegions = regions.filter((region) =>
    region.id.trim().toLowerCase() === 'subject'
      || region.label.trim().toLowerCase() === 'subject')
  const specificRegions = regions.filter((region) => fallbackRegions.includes(region) === false)
  const referencedRegionIds = new Set((analysis?.landmarks ?? []).flatMap((landmark) => [
    landmark.featureRegionId,
    landmark.carrierRegionId,
  ]).filter((regionId): regionId is string => regionId !== undefined))
  const subjectMask = resolvedSubjectMask(analysis)
  const structuralFallbackEnabled = analysis?.subjectMaskEvidence !== undefined
  const trustedSubjectMask = structuralFallbackEnabled
    && subjectMask !== undefined
    && subjectMaskTrust(analysis) >= 0.5
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      if (activeMask[index] !== 1) continue
      const sourcePoint = sourcePointForGridCell(crop, fit, x, y)
      if (sourcePoint === undefined) continue
      const sourceX = clamp(Math.round(sourcePoint[0]), 0, (subjectMask?.width ?? regions[0]?.mask.width ?? 1) - 1)
      const sourceY = clamp(Math.round(sourcePoint[1]), 0, (subjectMask?.height ?? regions[0]?.mask.height ?? 1) - 1)
      let bestScore = 0.2
      for (const region of specificRegions) {
        const localSupport = region.mask.values[sourceY * region.mask.width + sourceX] ?? 0
        const score = localSupport * (0.5 + 0.5 * region.confidence)
        const currentRegionId = ids[index]
        const explicitCarrierWinsTie = score === bestScore
          && referencedRegionIds.has(region.id)
          && (currentRegionId === undefined || referencedRegionIds.has(currentRegionId) === false)
        if (score > bestScore || explicitCarrierWinsTie) {
          bestScore = score
          ids[index] = region.id
        }
      }
      if (ids[index] !== undefined) continue
      bestScore = 0.4
      for (const region of fallbackRegions) {
        const score = (region.mask.values[sourceY * region.mask.width + sourceX] ?? 0)
          * region.confidence
        if (score > bestScore) {
          bestScore = score
          ids[index] = region.id
        }
      }
      if (ids[index] !== undefined) continue
      if (trustedSubjectMask && subjectMask !== undefined) {
        ids[index] = (subjectMask.values[sourceY * subjectMask.width + sourceX] ?? 0) >= 0.5
          ? 'subject'
          : 'background'
      } else if (structuralFallbackEnabled) {
        ids[index] = 'image'
      }
    }
  }
  return ids
}

export function hasDetailedColorEvidence(
  analysis: ImageAnalysis | undefined,
  featurePlacements: readonly ResolvedFeaturePlacement[],
): boolean {
  if (featurePlacements.length > 0) return true
  return (analysis?.semanticRegions ?? []).some((region) => {
    const id = region.id.trim().toLowerCase()
    const label = region.label.trim().toLowerCase()
    return id !== 'subject' && label !== 'subject'
  })
}

function semanticMaterialKind(value: string): MaterialValueKind | undefined {
  const normalized = value.trim().toLowerCase()
  if (/metal|steel|iron|silver|gold|chrome|金属|钢|铁/.test(normalized)) return 'metal'
  if (/glass|crystal|玻璃|水晶/.test(normalized)) return 'glass'
  if (/water|ocean|sea|river|lake|水|海|河|湖/.test(normalized)) return 'water'
  if (/wood|timber|tree|木|树/.test(normalized)) return 'wood'
  if (/stone|rock|concrete|石|岩|混凝土/.test(normalized)) return 'stone'
  if (/soil|earth|ground|dirt|土壤|泥土|地面/.test(normalized)) return 'soil'
  if (/fabric|cloth|textile|clothes|shirt|dress|布|衣/.test(normalized)) return 'fabric'
  if (/hair|fur|mane|发|毛/.test(normalized)) return 'hair'
  if (/skin|face|head|皮肤|脸|面/.test(normalized)) return 'skin'
  return undefined
}

export function semanticMaterialMap(analysis: ImageAnalysis | undefined): Readonly<Record<string, MaterialValueKind>> {
  return Object.fromEntries((analysis?.semanticRegions ?? []).flatMap((region) => {
    const kind = semanticMaterialKind(`${region.id} ${region.label}`)
    return kind === undefined ? [] : [[region.id, kind] as const]
  }))
}

export function paletteColorsInStock(
  palette: MaterialPalette,
  colors: readonly PreparedColor[],
): readonly PreparedColor[] {
  return colors.filter((color) => (palette.inventory?.[color.id] ?? Number.POSITIVE_INFINITY) > 0)
}

export function shouldPreserveThinAlphaStructures(
  image: PatternGenerationRequest['image'],
  analysis: ImageAnalysis | undefined,
): boolean {
  const evidence = analysis?.subjectMaskEvidence
  let sourceHasTransparency = evidence?.source === 'alpha'
  for (let offset = 3; offset < image.data.length && sourceHasTransparency === false; offset += 4) {
    sourceHasTransparency = (image.data[offset] ?? 255) < 250
  }
  if (sourceHasTransparency === false) return false
  let sourceForegroundPixels = 0
  let sourceDarkPixels = 0
  let sourceLightPixels = 0
  let sourceChromaticPixels = 0
  for (let index = 0; index < image.width * image.height; index += 1) {
    const offset = index * 4
    const alpha = (image.data[offset + 3] ?? 255) / 255
    if (alpha < 0.2) continue
    const red = image.data[offset] ?? 0
    const green = image.data[offset + 1] ?? 0
    const blue = image.data[offset + 2] ?? 0
    const lightness = red * 0.2126 + green * 0.7152 + blue * 0.0722
    sourceForegroundPixels += 1
    if (lightness <= 96) sourceDarkPixels += 1
    if (lightness >= 224) sourceLightPixels += 1
    if (Math.max(red, green, blue) - Math.min(red, green, blue) >= 32) {
      sourceChromaticPixels += 1
    }
  }
  const mask = resolvedSubjectMask(analysis)
  if (mask === undefined) return false
  const transparentLineArt = sourceForegroundPixels > 0
    && sourceChromaticPixels / sourceForegroundPixels <= 0.12
    && sourceDarkPixels / sourceForegroundPixels >= 0.003
    && sourceDarkPixels / sourceForegroundPixels <= 0.35
    && sourceLightPixels / sourceForegroundPixels >= 0.45
  if (transparentLineArt) return true
  const total = mask.width * mask.height
  let foregroundMass = 0
  let foregroundPixels = 0
  let boundaryPixels = 0
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      const index = y * mask.width + x
      const value = clamp(mask.values[index] ?? 0, 0, 1)
      foregroundMass += value
      if (value < 0.2) continue
      foregroundPixels += 1
      const boundary = x === 0 || y === 0 || x === mask.width - 1 || y === mask.height - 1
        || (mask.values[index - 1] ?? 0) < 0.2
        || (mask.values[index + 1] ?? 0) < 0.2
        || (mask.values[index - mask.width] ?? 0) < 0.2
        || (mask.values[index + mask.width] ?? 0) < 0.2
      if (boundary) boundaryPixels += 1
    }
  }
  if (foregroundPixels === 0) return false
  const foregroundRatio = foregroundMass / Math.max(1, total)
  const boundaryRatio = boundaryPixels / foregroundPixels
  return foregroundRatio <= 0.08 || (foregroundRatio <= 0.18 && boundaryRatio >= 0.45)
}
