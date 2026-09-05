import type {
  BinaryMask,
  CropRect,
  EvidenceProvenance,
  ImageAnalysis,
  ImportanceMap,
  SemanticRegion,
} from '../types.js'

export type PetCompositionStrategy = 'group' | 'instance-focus'

export interface PetCompositionVariant {
  id: string
  strategy: PetCompositionStrategy
  instanceIds: readonly string[]
  analysis: ImageAnalysis
  crop: CropRect
  subjectCoverage: number
  relativeScaleGain: number
}

export interface PetCompositionPlanningInput {
  image: { width: number; height: number }
  analysis: ImageAnalysis
  targetAspectRatio?: number
  paddingRatio?: number
  maximumFocusVariants?: number
}

interface PetInstanceRegion {
  instanceId: string
  region: SemanticRegion
}

const plannerVersion = 'pet-composition-v1-instance-focus'
const instanceSubjectPattern = /^(pet-\d+):subject$/

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function validateMask(mask: BinaryMask, width: number, height: number): void {
  if (mask.width !== width || mask.height !== height || mask.values.length !== width * height) {
    throw new RangeError('Pet instance mask must align with the source image')
  }
  if (mask.values.some((value) => Number.isFinite(value) === false || value < 0 || value > 1)) {
    throw new RangeError('Pet instance mask values must stay within 0..1')
  }
}

function validateInput(input: PetCompositionPlanningInput): void {
  if (Number.isInteger(input.image.width) === false || input.image.width <= 0
    || Number.isInteger(input.image.height) === false || input.image.height <= 0) {
    throw new RangeError('Pet composition image dimensions must be positive integers')
  }
  if (input.targetAspectRatio !== undefined
    && (Number.isFinite(input.targetAspectRatio) === false || input.targetAspectRatio <= 0)) {
    throw new RangeError('Pet composition target aspect ratio must be positive')
  }
  if (input.paddingRatio !== undefined
    && (Number.isFinite(input.paddingRatio) === false
      || input.paddingRatio < 0 || input.paddingRatio > 0.5)) {
    throw new RangeError('Pet composition padding ratio must stay within 0..0.5')
  }
  if (input.maximumFocusVariants !== undefined
    && (Number.isInteger(input.maximumFocusVariants) === false
      || input.maximumFocusVariants < 0 || input.maximumFocusVariants > 16)) {
    throw new RangeError('Pet composition focus variant count must stay within 0..16')
  }
  for (const region of input.analysis.semanticRegions ?? []) {
    if (instanceSubjectPattern.test(region.id)) {
      validateMask(region.mask, input.image.width, input.image.height)
    }
  }
}

function normalizeCrop(crop: CropRect, width: number, height: number): CropRect {
  const left = clamp(crop.x, 0, width - 1)
  const top = clamp(crop.y, 0, height - 1)
  const right = clamp(crop.x + crop.width, left + 1, width)
  const bottom = clamp(crop.y + crop.height, top + 1, height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function maskBounds(mask: BinaryMask): CropRect | undefined {
  let left = mask.width
  let top = mask.height
  let right = -1
  let bottom = -1
  for (let index = 0; index < mask.values.length; index += 1) {
    if ((mask.values[index] ?? 0) < 0.2) continue
    const x = index % mask.width
    const y = Math.floor(index / mask.width)
    left = Math.min(left, x)
    top = Math.min(top, y)
    right = Math.max(right, x)
    bottom = Math.max(bottom, y)
  }
  return right < left || bottom < top
    ? undefined
    : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

function unionBounds(first: CropRect, second: CropRect): CropRect {
  const left = Math.min(first.x, second.x)
  const top = Math.min(first.y, second.y)
  const right = Math.max(first.x + first.width, second.x + second.width)
  const bottom = Math.max(first.y + first.height, second.y + second.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function instanceBounds(
  input: PetCompositionPlanningInput,
  instance: PetInstanceRegion,
): CropRect | undefined {
  let bounds = maskBounds(instance.region.mask)
  for (const landmark of input.analysis.landmarks ?? []) {
    if (landmark.id.startsWith(`${instance.instanceId}:`) === false
      || landmark.observationState === 'missing') continue
    const radius = Math.max(1, landmark.sourceRadiusPx ?? landmark.radius ?? 1)
    const pointBounds = {
      x: landmark.x - radius,
      y: landmark.y - radius,
      width: radius * 2,
      height: radius * 2,
    }
    bounds = bounds === undefined ? pointBounds : unionBounds(bounds, pointBounds)
  }
  return bounds === undefined
    ? undefined
    : normalizeCrop(bounds, input.image.width, input.image.height)
}

function placedInterval(
  minimum: number,
  maximum: number,
  desiredSize: number,
  limit: number,
): readonly [number, number] {
  const requiredSize = Math.max(1, maximum - minimum)
  const size = Math.min(limit, Math.max(requiredSize, desiredSize))
  const center = (minimum + maximum) * 0.5
  const start = clamp(center - size * 0.5, 0, limit - size)
  return [start, size]
}

function paddedAspectCrop(
  bounds: CropRect,
  image: { width: number; height: number },
  aspectRatio: number,
  paddingRatio: number,
): CropRect {
  const padding = Math.max(2, Math.max(bounds.width, bounds.height) * paddingRatio)
  let desiredWidth = bounds.width + padding * 2
  let desiredHeight = bounds.height + padding * 2
  if (desiredWidth / desiredHeight < aspectRatio) desiredWidth = desiredHeight * aspectRatio
  else desiredHeight = desiredWidth / aspectRatio
  const [x, width] = placedInterval(bounds.x, bounds.x + bounds.width, desiredWidth, image.width)
  const [y, height] = placedInterval(bounds.y, bounds.y + bounds.height, desiredHeight, image.height)
  return { x, y, width, height }
}

function subjectArea(mask: BinaryMask): number {
  let area = 0
  for (const value of mask.values) area += value >= 0.2 ? 1 : 0
  return area
}

function coverage(mask: BinaryMask | undefined, crop: CropRect): number {
  if (mask === undefined) return 0
  return clamp(subjectArea(mask) / Math.max(1, crop.width * crop.height), 0, 1)
}

function normalizedFitScale(crop: CropRect, targetAspectRatio: number): number {
  return Math.min(targetAspectRatio / crop.width, 1 / crop.height)
}

function maskedImportanceMap(
  importanceMap: ImportanceMap | undefined,
  mask: BinaryMask,
): ImportanceMap | undefined {
  if (importanceMap === undefined) return undefined
  validateMask(mask, importanceMap.width, importanceMap.height)
  return {
    width: importanceMap.width,
    height: importanceMap.height,
    weights: Float32Array.from(importanceMap.weights, (weight, index) =>
      weight * (mask.values[index] ?? 0)),
  }
}

function focusProvenance(instanceId: string): EvidenceProvenance {
  return {
    origin: 'fused',
    provider: 'pattern-core/pet-composition',
    version: `${plannerVersion}:${instanceId}`,
  }
}

function focusedAnalysis(
  input: PetCompositionPlanningInput,
  instance: PetInstanceRegion,
  crop: CropRect,
): ImageAnalysis {
  const provenance = focusProvenance(instance.instanceId)
  const evidence = input.analysis.subjectMaskEvidence
  const importanceMap = maskedImportanceMap(input.analysis.importanceMap, instance.region.mask)
  const semanticRegions = (input.analysis.semanticRegions ?? [])
    .filter((region) => region.id.startsWith(`${instance.instanceId}:`))
  return {
    ...input.analysis,
    subjectMask: instance.region.mask,
    subjectMaskEvidence: evidence === undefined
      ? {
        mask: instance.region.mask,
        confidence: instance.region.confidence,
        source: 'fused',
        revision: `${plannerVersion}:${instance.instanceId}`,
        provenance: [...(instance.region.provenance ?? []), provenance],
      }
      : {
        ...evidence,
        mask: instance.region.mask,
        confidence: Math.min(evidence.confidence, instance.region.confidence),
        revision: `${evidence.revision}:focus:${instance.instanceId}`,
        provenance: [...(evidence.provenance ?? []), provenance],
      },
    semanticRegions: [
      {
        id: 'subject',
        label: 'focused pet subject',
        mask: instance.region.mask,
        confidence: instance.region.confidence,
        importance: 1,
        provenance: [...(instance.region.provenance ?? []), provenance],
      },
      ...semanticRegions,
    ],
    landmarks: (input.analysis.landmarks ?? [])
      .filter((landmark) => landmark.id.startsWith(`${instance.instanceId}:`)),
    ...(importanceMap === undefined ? {} : { importanceMap }),
    suggestedCrop: crop,
    suggestedCropConfidence: Math.min(1, Math.max(
      instance.region.confidence,
      input.analysis.suggestedCropConfidence ?? 0,
    )),
    suggestedCropSource: 'automatic',
    confidence: Math.min(input.analysis.confidence ?? 1, instance.region.confidence),
    modelVersions: {
      ...(input.analysis.modelVersions ?? {}),
      petComposition: plannerVersion,
      petCompositionInstance: instance.instanceId,
    },
    provenance: [...(input.analysis.provenance ?? []), provenance],
  }
}

function petInstances(analysis: ImageAnalysis): readonly PetInstanceRegion[] {
  return (analysis.semanticRegions ?? []).flatMap((region): readonly PetInstanceRegion[] => {
    const match = instanceSubjectPattern.exec(region.id)
    return match === null ? [] : [{ instanceId: match[1]!, region }]
  }).sort((first, second) => first.instanceId.localeCompare(second.instanceId, undefined, { numeric: true }))
}

export function planPetCompositionVariants(
  input: PetCompositionPlanningInput,
): readonly PetCompositionVariant[] {
  validateInput(input)
  const targetAspectRatio = input.targetAspectRatio ?? 1
  const paddingRatio = input.paddingRatio ?? 0.08
  const maximumFocusVariants = input.maximumFocusVariants ?? 8
  const instances = petInstances(input.analysis)
  const groupMask = input.analysis.subjectMaskEvidence?.mask ?? input.analysis.subjectMask
  const inferredGroupBounds = groupMask === undefined ? undefined : maskBounds(groupMask)
  const groupCrop = normalizeCrop(
    input.analysis.suggestedCrop
      ?? inferredGroupBounds
      ?? { x: 0, y: 0, width: input.image.width, height: input.image.height },
    input.image.width,
    input.image.height,
  )
  const groupScale = normalizedFitScale(groupCrop, targetAspectRatio)
  const group: PetCompositionVariant = {
    id: 'pet-group',
    strategy: 'group',
    instanceIds: instances.map((instance) => instance.instanceId),
    analysis: input.analysis,
    crop: groupCrop,
    subjectCoverage: coverage(groupMask, groupCrop),
    relativeScaleGain: 1,
  }
  if (instances.length < 2 || maximumFocusVariants === 0) return [group]

  const focused = instances.slice(0, maximumFocusVariants).flatMap((instance): readonly PetCompositionVariant[] => {
    const bounds = instanceBounds(input, instance)
    if (bounds === undefined) return []
    const crop = paddedAspectCrop(
      bounds,
      input.image,
      targetAspectRatio,
      paddingRatio,
    )
    return [{
      id: `pet-focus-${instance.instanceId}`,
      strategy: 'instance-focus',
      instanceIds: [instance.instanceId],
      analysis: focusedAnalysis(input, instance, crop),
      crop,
      subjectCoverage: coverage(instance.region.mask, crop),
      relativeScaleGain: normalizedFitScale(crop, targetAspectRatio) / groupScale,
    }]
  })
  return [group, ...focused]
}
