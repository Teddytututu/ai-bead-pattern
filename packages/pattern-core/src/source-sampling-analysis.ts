import type { ImageAnalysis, ImageLandmark } from './types.js'

function isFacialPart(label: string): boolean {
  const words = label.replace(/[_-]+/g, ' ')
  return /\b(eyes?|iris(?:es)?|pupils?|eyebrows?|eyelids?|eyelashes|nose|nostrils?|mouth|lips?|muzzle|jaws?)\b|眼|眉|鼻|嘴|唇|口鼻|颌|颚/i.test(words)
}

function isFacialLandmark(landmark: ImageLandmark): boolean {
  return landmark.kind === 'eye' || landmark.kind === 'nose' || landmark.kind === 'mouth'
    || landmark.structuralRole === 'eye-center' || landmark.structuralRole === 'nose-tip'
    || landmark.structuralRole === 'mouth-corner' || landmark.structuralRole === 'upper-jaw'
    || landmark.structuralRole === 'lower-jaw' || isFacialPart(landmark.id)
}

/** Keep silhouette/body guidance; facial pixels use the ordinary sampling and cleanup stages. */
export function sourceSamplingAnalysis(analysis: ImageAnalysis | undefined): ImageAnalysis | undefined {
  if (analysis === undefined) return undefined
  const excludedRegions = new Set((analysis.semanticRegions ?? [])
    .filter(region => isFacialPart(`${region.id} ${region.label}`))
    .map(region => region.id))
  const landmarks = analysis.landmarks?.filter(landmark => !isFacialLandmark(landmark))
    .map(landmark => {
      const copy = { ...landmark }
      if (copy.featureRegionId !== undefined && excludedRegions.has(copy.featureRegionId)) delete copy.featureRegionId
      if (copy.carrierRegionId !== undefined && excludedRegions.has(copy.carrierRegionId)) delete copy.carrierRegionId
      return copy
    })
  return {
    ...analysis,
    ...(analysis.semanticRegions === undefined ? {} : {
      semanticRegions: analysis.semanticRegions.filter(region => !excludedRegions.has(region.id)),
    }),
    ...(landmarks === undefined ? {} : { landmarks }),
  }
}
