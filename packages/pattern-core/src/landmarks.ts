import type { CanvasFit } from './image.js'
import type {
  CropRect,
  ImageLandmark,
  LandmarkObservationState,
} from './types.js'

export function landmarkObservationState(
  landmark: ImageLandmark,
): LandmarkObservationState {
  if (landmark.observationState !== undefined) return landmark.observationState
  return landmark.confidence < 0.2 ? 'missing' : 'observed'
}

export function landmarkEvidenceReliability(
  landmark: ImageLandmark,
): number {
  const confidence = Math.min(1, Math.max(0, landmark.confidence))
  const state = landmarkObservationState(landmark)
  if (state === 'missing') return 0
  return state === 'inferred' ? confidence * 0.65 : confidence
}

export function landmarkMayEditOccupancy(
  landmark: ImageLandmark,
): boolean {
  return landmarkObservationState(landmark) === 'observed'
    && landmark.affectsOccupancy === true
}

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
): number {
  return landmarkObservationState(landmark) === 'missing'
    ? 0
    : Math.min(1, Math.max(0, landmark.confidence))
}
