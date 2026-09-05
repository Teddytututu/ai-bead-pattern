import {
  inferPetAnalysis,
  resolvedSubjectMask,
  type CropRect,
  type EvidenceProvenance,
  type ImageAnalysis,
  type ImageLandmark,
  type ImageType,
  type PixelImage,
  type SemanticRegion,
} from '@ai-bead-pattern/pattern-core'

import { fuseImageAnalyses } from './analysis-fusion.js'

const geometryVersion = 'pet-face-v3-animalpose-schema'
const geometryProvenance: readonly EvidenceProvenance[] = [{
  origin: 'heuristic',
  provider: 'pet-geometry',
  version: geometryVersion,
}]
const faceCarrierRoles = new Set(['eye-center', 'nose-tip', 'mouth-corner'])

function petInstanceIds(analysis: ImageAnalysis): readonly string[] {
  const ids = new Set<string>()
  const collect = (id: string) => {
    const match = /^(pet-\d+):/.exec(id)
    const instanceId = match?.[1]
    if (instanceId !== undefined) ids.add(instanceId)
  }
  for (const landmark of analysis.landmarks ?? []) collect(landmark.id)
  for (const region of analysis.semanticRegions ?? []) collect(region.id)
  return [...ids].sort()
}

function petEvidencePresent(analysis: ImageAnalysis, imageTypeHint: ImageType | undefined): boolean {
  if (imageTypeHint === 'pet' || analysis.imageType === 'pet') return true
  if ((analysis.landmarks ?? []).some((landmark) => /^pet-\d+:/.test(landmark.id))) return true
  return (analysis.semanticRegions ?? []).some((region) =>
    /^pet-\d+:subject$/.test(region.id)
      || /^(cat|dog|pet|rabbit|animal)$/i.test(region.label.trim()),
  )
}

function subjectRegions(analysis: ImageAnalysis): readonly SemanticRegion[] {
  const instanceRegions = (analysis.semanticRegions ?? []).filter((region) =>
    /^pet-\d+:subject$/.test(region.id),
  )
  if (instanceRegions.length > 0) return instanceRegions
  const semanticSubject = (analysis.semanticRegions ?? []).find((region) =>
    region.id === 'subject' || region.label.trim().toLowerCase() === 'subject',
  )
  if (semanticSubject !== undefined) return [semanticSubject]
  const mask = resolvedSubjectMask(analysis)
  if (mask === undefined) return []
  const provenance = analysis.subjectMaskEvidence?.provenance ?? analysis.provenance
  return [{
    id: 'subject',
    label: 'subject',
    mask,
    confidence: analysis.subjectMaskEvidence?.confidence ?? analysis.confidence ?? 0.5,
    importance: 0.9,
    ...(provenance === undefined ? {} : { provenance }),
  }]
}

function instancePrefix(region: SemanticRegion): string {
  return region.id.endsWith(':subject') ? region.id.slice(0, -'subject'.length) : ''
}

function prefixedLandmark(landmark: ImageLandmark, prefix: string): ImageLandmark {
  const featureRegionId = landmark.featureRegionId === undefined
    ? undefined
    : `${prefix}${landmark.featureRegionId}`
  const carrierRegionId = landmark.carrierRegionId === undefined
    ? undefined
    : `${prefix}${landmark.carrierRegionId}`
  return {
    ...landmark,
    id: `${prefix}${landmark.id}`,
    ...(landmark.symmetryGroup === undefined
      ? {}
      : { symmetryGroup: `${prefix}${landmark.symmetryGroup}` }),
    ...(featureRegionId === undefined ? {} : { featureRegionId }),
    ...(carrierRegionId === undefined ? {} : { carrierRegionId }),
  }
}

function unionCrop(crops: readonly CropRect[], image: PixelImage): CropRect | undefined {
  if (crops.length === 0) return undefined
  const left = Math.max(0, Math.min(...crops.map((crop) => crop.x)))
  const top = Math.max(0, Math.min(...crops.map((crop) => crop.y)))
  const right = Math.min(image.width, Math.max(...crops.map((crop) => crop.x + crop.width)))
  const bottom = Math.min(image.height, Math.max(...crops.map((crop) => crop.y + crop.height)))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function bindFacialLandmarksToFaceRegions(analysis: ImageAnalysis): ImageAnalysis {
  const faceRegionIds = new Set(
    (analysis.semanticRegions ?? [])
      .map((region) => region.id)
      .filter((id) => id === 'pet-face' || /^pet-\d+:pet-face$/.test(id)),
  )
  if (faceRegionIds.size === 0 || analysis.landmarks === undefined) return analysis
  const landmarks = analysis.landmarks.map((landmark) => {
    if (landmark.structuralRole === undefined || faceCarrierRoles.has(landmark.structuralRole) === false) {
      return landmark
    }
    const instancePrefix = /^pet-\d+:/.exec(landmark.id)?.[0] ?? ''
    const faceRegionId = `${instancePrefix}pet-face`
    if (faceRegionIds.has(faceRegionId) === false) return landmark
    return {
      ...landmark,
      carrierRegionId: faceRegionId,
      featureRegionId: faceRegionId,
    }
  })
  return { ...analysis, landmarks }
}

export function enrichPetGeometryAnalysis(
  image: PixelImage,
  analysis: ImageAnalysis,
  imageTypeHint?: ImageType,
): ImageAnalysis {
  if (petEvidencePresent(analysis, imageTypeHint) === false) return analysis
  const geometryAnalyses: ImageAnalysis[] = []
  const crops: CropRect[] = []
  const instances = petInstanceIds(analysis)
  const regions = subjectRegions(analysis)
  const onlyRegion = regions[0]
  const usesAggregateSubject = regions.length === 1
    && onlyRegion !== undefined
    && instancePrefix(onlyRegion) === ''
  if (usesAggregateSubject && instances.length > 1) return analysis
  for (const region of regions) {
    const inferred = inferPetAnalysis(image, region.mask)
    if (inferred === undefined) continue
    const prefix = instancePrefix(region)
      || (usesAggregateSubject && instances.length === 1 ? `${instances[0]}:` : '')
    const confidence = Math.min(region.confidence, inferred.confidence)
    crops.push(inferred.suggestedCrop)
    geometryAnalyses.push({
      imageType: 'pet',
      landmarks: inferred.landmarks.map((landmark) => prefixedLandmark(landmark, prefix)),
      semanticRegions: [
        {
          id: `${prefix}pet-face`,
          label: 'pet face',
          mask: inferred.faceMask,
          confidence,
          importance: 1,
          provenance: geometryProvenance,
        },
        ...inferred.bodyRegions.map((bodyRegion) => ({
          ...bodyRegion,
          id: `${prefix}${bodyRegion.id}`,
        })),
      ],
      confidence,
      modelVersions: { petGeometry: `pet-geometry/${geometryVersion}` },
      provenance: geometryProvenance,
    })
  }
  if (geometryAnalyses.length === 0) return analysis
  const inferredCrop = analysis.suggestedCrop === undefined ? unionCrop(crops, image) : undefined
  const cropAnalysis: ImageAnalysis | undefined = inferredCrop === undefined
    ? undefined
    : {
      suggestedCrop: inferredCrop,
      suggestedCropConfidence: Math.min(...geometryAnalyses.map((entry) => entry.confidence ?? 0.5)),
      suggestedCropSource: 'automatic',
      imageType: 'pet',
      provenance: geometryProvenance,
    }
  return bindFacialLandmarksToFaceRegions(fuseImageAnalyses([
    analysis,
    ...geometryAnalyses,
    ...(cropAnalysis === undefined ? [] : [cropAnalysis]),
  ]))
}
