import type { CanvasFit } from './image.js'
import type { CropRect, ImageLandmark } from './types.js'

export function landmarkSourceRadiusPx(landmark: ImageLandmark): number {
  return Math.max(0, landmark.sourceRadiusPx ?? landmark.radius ?? 1)
}

export function landmarkGridRadiusCells(
  landmark: ImageLandmark,
  crop: CropRect,
  fit: CanvasFit,
): number {
  if (landmark.gridRadiusCells !== undefined) {
    return Math.max(0, Math.round(landmark.gridRadiusCells))
  }
  if (landmark.sourceRadiusPx === undefined && landmark.radius === undefined) return 0
  const scale = Math.max(fit.width / crop.width, fit.height / crop.height)
  return Math.max(0, Math.round(landmarkSourceRadiusPx(landmark) * scale))
}

export function landmarkEffectiveConfidence(
  landmark: ImageLandmark,
  analysisConfidence = 1,
): number {
  return Math.min(1, Math.max(0, landmark.confidence * analysisConfidence))
}
