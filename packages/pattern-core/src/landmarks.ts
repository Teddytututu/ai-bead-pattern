import type { FeatureShape } from './types.js'
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

export function validateFeatureShape(shape: FeatureShape | undefined): void {
  if (shape === undefined) return
  if (!shape || typeof shape !== 'object' || !Number.isFinite(shape.widthPx) || !Number.isFinite(shape.heightPx)
    || shape.widthPx <= 0 || shape.heightPx <= 0 || shape.widthPx > 2048 || shape.heightPx > 2048
    || (shape.angleDegrees !== undefined && (!Number.isFinite(shape.angleDegrees) || Math.abs(shape.angleDegrees) > 180))
    || (shape.expression !== undefined && !['neutral', 'open', 'closed', 'smile'].includes(shape.expression))
    || (shape.anchors !== undefined && (!Array.isArray(shape.anchors) || shape.anchors.length > 16
      || shape.anchors.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))))) throw new RangeError('Invalid feature shape evidence')
}
export function projectFeatureShape(shape: FeatureShape, scaleX: number, scaleY: number, offsetX = 0, offsetY = 0): FeatureShape {
  validateFeatureShape(shape)
  if (![scaleX, scaleY, offsetX, offsetY].every(Number.isFinite) || scaleX <= 0 || scaleY <= 0) throw new RangeError('Invalid feature projection')
  const angle = (shape.angleDegrees ?? 0) * Math.PI / 180
  return { ...shape,
    widthPx: shape.widthPx * Math.hypot(scaleX * Math.cos(angle), scaleY * Math.sin(angle)),
    heightPx: shape.heightPx * Math.hypot(scaleX * Math.sin(angle), scaleY * Math.cos(angle)),
    angleDegrees: Math.atan2(scaleY * Math.sin(angle), scaleX * Math.cos(angle)) * 180 / Math.PI,
    ...(shape.anchors === undefined ? {} : { anchors: shape.anchors.map(point => ({ x: offsetX + (point.x + 0.5) * scaleX - 0.5, y: offsetY + (point.y + 0.5) * scaleY - 0.5 })) }),
  }
}
