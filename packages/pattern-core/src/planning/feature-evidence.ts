import type { FeatureOverride, FeatureShape, ImageLandmark, PatternGenerationRequest } from '../types.js'
import { featureTemplateLibrary } from './feature-template-library.js'

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
export function validateFeatureOverrides(overrides: readonly FeatureOverride[] | undefined, width: number, height: number): void {
  if (overrides === undefined) return
  if (!Array.isArray(overrides) || overrides.length > 32) throw new RangeError('At most 32 manual feature overrides are supported')
  const ids = new Set<string>()
  for (const entry of overrides) {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 128 || ids.has(entry.id)
      || !['eye', 'mouth', 'nose'].includes(entry.kind)
      || !Number.isFinite(entry.x) || !Number.isFinite(entry.y) || entry.x < 0 || entry.y < 0 || entry.x >= width || entry.y >= height
      || (entry.hidden !== undefined && typeof entry.hidden !== 'boolean') || (entry.locked !== undefined && typeof entry.locked !== 'boolean')) throw new RangeError('Invalid manual feature override')
    ids.add(entry.id)
    for (const label of [entry.instanceId, entry.featureGroupId]) if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 128)) throw new RangeError('Invalid manual feature group')
    if (entry.templateId !== undefined && !featureTemplateLibrary.some(template => template.id === entry.templateId && template.kind === entry.kind)) throw new RangeError('Manual template must match the feature kind')
    validateFeatureShape(entry.shape)
  }
}
export function featureFaceGroup(landmark: ImageLandmark): string {
  return `${landmark.instanceId ?? landmark.carrierRegionId ?? 'unscoped'}|${landmark.featureGroupId ?? 'face'}`
}
/** Merge legacy mouth anchors into one component, then apply explicit user corrections. */
export function prepareFeatureEvidence(request: PatternGenerationRequest): PatternGenerationRequest {
  validateFeatureOverrides(request.options.featureOverrides, request.image.width, request.image.height)
  const landmarks = [...(request.analysis?.landmarks ?? [])]
  const corners = landmarks.filter(landmark => landmark.kind === 'mouth' && /mouth-(left|right)$/.test(landmark.id))
  let normalized = landmarks.filter(landmark => !corners.includes(landmark))
  for (const group of new Set(corners.map(featureFaceGroup))) {
    const points = corners.filter(landmark => featureFaceGroup(landmark) === group)
    const existing = normalized.find(landmark => landmark.kind === 'mouth' && featureFaceGroup(landmark) === group)
    if (existing !== undefined) {
      const width = points.length > 1 ? Math.hypot(points[1]!.x - points[0]!.x, points[1]!.y - points[0]!.y) : 2
      const angleDegrees = points.length > 1 ? Math.atan2(points[1]!.y - points[0]!.y, points[1]!.x - points[0]!.x) * 180 / Math.PI : 0
      const updated = { ...existing, featureShape: existing.featureShape ?? { widthPx: Math.max(1, width), heightPx: Math.max(1, width * 0.25), angleDegrees, anchors: points.map(({ x, y }) => ({ x, y })) } }
      normalized = normalized.map(landmark => landmark === existing ? updated : landmark)
    } else if (points.length >= 2) {
      const first = points[0]!, second = points[1]!
      normalized.push({ ...first, id: first.id.replace(/mouth-(left|right)$/, 'mouth-center'), x: (first.x + second.x) / 2, y: (first.y + second.y) / 2,
        featureShape: { widthPx: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)), heightPx: 1,
          angleDegrees: Math.atan2(second.y - first.y, second.x - first.x) * 180 / Math.PI, anchors: points.map(({ x, y }) => ({ x, y })) } })
    } else normalized.push(...points)
  }
  for (const override of request.options.featureOverrides ?? []) {
    const old = normalized.find(landmark => landmark.id === override.id)
    const landmark: ImageLandmark = { ...old, id: override.id, kind: override.kind, x: override.x, y: override.y, confidence: 1, priority: 'hard',
      affectsOccupancy: false, observationState: override.hidden ? 'missing' : 'observed', placementLocked: override.locked ?? true,
      provenance: [{ origin: 'manual', provider: 'feature-editor', version: '1' }],
      ...(override.instanceId === undefined ? {} : { instanceId: override.instanceId }),
      ...(override.featureGroupId === undefined ? {} : { featureGroupId: override.featureGroupId }),
      ...(override.templateId === undefined ? {} : { templateId: override.templateId }),
      ...(override.shape === undefined ? {} : { featureShape: override.shape }),
    }
    normalized = [...normalized.filter(entry => entry.id !== override.id), landmark]
  }
  if (!landmarks.length && !normalized.length) return request
  return { ...request, analysis: { ...request.analysis, landmarks: normalized } }
}
