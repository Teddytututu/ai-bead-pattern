import {
  HttpVisionProvider,
  modelManifest,
} from '@ai-bead-pattern/ai-gateway'

export const DINOV2_PROVIDER_ID = 'dinov2-vits14-pair-local'
export const DINOV2_MODEL_ID = 'facebook/dinov2-small'
export const DINOV2_VIEWS = Object.freeze(['global', 'subject', 'head', 'critical-local'])
export const DINOV2_METRICS = Object.freeze([
  'identitySimilarity',
  'patchCorrespondence',
  'criticalPatchRetention',
  'regionalCoverage',
])
export const DINOV2_FEATURE_NAMES = Object.freeze(DINOV2_VIEWS.flatMap((view) =>
  DINOV2_METRICS.map((metric) => `${view}.${metric}`)))

const pinnedManifest = modelManifest(DINOV2_PROVIDER_ID)

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value
}

function text(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function finite(value, label) {
  if (typeof value !== 'number' || Number.isFinite(value) === false) {
    throw new TypeError(`${label} must be finite`)
  }
  return value
}

function unit(value, label) {
  const parsed = finite(value, label)
  if (parsed < 0 || parsed > 1) throw new RangeError(`${label} must stay within 0..1`)
  return parsed
}

function sameIdentity(model) {
  return model.modelId === pinnedManifest.modelId
    && model.modelVersion === pinnedManifest.modelVersion
    && model.sourceRevision === pinnedManifest.sourceRevision
    && model.weightRevision === pinnedManifest.weightRevision
}

function normalizedWarnings(value) {
  if (value === undefined) return []
  if (Array.isArray(value) === false || value.length > 20) {
    throw new RangeError('DINOv2 warnings must be a bounded array')
  }
  return value.map((entry, index) => text(entry, `DINOv2 warning ${index}`).slice(0, 300))
}

function featureValues(value) {
  if (Array.isArray(value) === false && ArrayBuffer.isView(value) === false) {
    throw new TypeError('DINOv2 feature values must be an array')
  }
  const values = Array.from(value)
  if (values.length !== DINOV2_FEATURE_NAMES.length) {
    throw new RangeError('DINOv2 feature values differ from the pinned contract')
  }
  return values.map((entry, index) => unit(entry, `DINOv2 feature value ${index}`))
}

function regionalComparisons(value, names, values) {
  if (Array.isArray(value) === false || value.length !== DINOV2_VIEWS.length) {
    throw new RangeError('DINOv2 preference evidence must contain all four regional views')
  }
  const byView = new Map()
  for (const [index, raw] of value.entries()) {
    const comparison = object(raw, `DINOv2 regional comparison ${index}`)
    const view = text(comparison.view, `DINOv2 regional comparison ${index} view`)
    if (DINOV2_VIEWS.includes(view) === false || byView.has(view)) {
      throw new RangeError('DINOv2 regional views must be unique and pinned')
    }
    const normalized = {
      view,
      identitySimilarity: unit(comparison.identitySimilarity, `DINOv2 ${view} identity similarity`),
      patchCorrespondence: unit(comparison.patchCorrespondence, `DINOv2 ${view} patch correspondence`),
      criticalPatchRetention: unit(
        comparison.criticalPatchRetention,
        `DINOv2 ${view} critical patch retention`,
      ),
      regionalCoverage: unit(comparison.regionalCoverage, `DINOv2 ${view} regional coverage`),
      confidence: unit(comparison.confidence, `DINOv2 ${view} confidence`),
    }
    for (const metric of DINOV2_METRICS) {
      const featureIndex = names.indexOf(`${view}.${metric}`)
      if (featureIndex < 0 || Math.abs(values[featureIndex] - normalized[metric]) > 1e-5) {
        throw new RangeError('DINOv2 regional evidence differs from flat feature values')
      }
    }
    byView.set(view, normalized)
  }
  return DINOV2_VIEWS.map((view) => byView.get(view))
}

export function normalizeDinoV2CandidateScore(value, expectedCandidateId) {
  const result = object(value, 'DINOv2 provider result')
  if (text(result.providerId, 'DINOv2 provider id') !== DINOV2_PROVIDER_ID) {
    throw new RangeError('DINOv2 provider identity differs from the pinned manifest')
  }
  const model = object(result.model, 'DINOv2 model identity')
  if (sameIdentity(model) === false) {
    throw new RangeError('DINOv2 model identity differs from the pinned manifest')
  }
  if (Array.isArray(result.capabilities) === false
    || result.capabilities.includes('embedding') === false
    || result.capabilities.includes('preference-scoring') === false) {
    throw new RangeError('DINOv2 result must include embedding and preference-scoring capabilities')
  }
  const preference = object(result.preferenceFeatures, 'DINOv2 preference features')
  if (preference.modelId !== pinnedManifest.modelId) {
    throw new RangeError('DINOv2 preference feature model identity differs from the pinned manifest')
  }
  if (preference.scope !== 'pair') {
    throw new RangeError('DINOv2 preference features must use pair scope')
  }
  if (text(preference.candidateId, 'DINOv2 candidate identity') !== expectedCandidateId) {
    throw new RangeError('DINOv2 candidate identity differs from the request')
  }
  if (Array.isArray(preference.names) === false
    || preference.names.length !== DINOV2_FEATURE_NAMES.length
    || preference.names.some((name, index) => name !== DINOV2_FEATURE_NAMES[index])) {
    throw new RangeError('DINOv2 feature names differ from the pinned contract')
  }
  const names = [...preference.names]
  const values = featureValues(preference.values)
  const comparisons = regionalComparisons(preference.regionalComparisons, names, values)
  const confidence = Math.min(
    unit(result.confidence, 'DINOv2 result confidence'),
    unit(preference.confidence, 'DINOv2 feature confidence'),
  )
  return {
    providerId: DINOV2_PROVIDER_ID,
    model: {
      modelId: pinnedManifest.modelId,
      modelVersion: pinnedManifest.modelVersion,
      sourceRevision: pinnedManifest.sourceRevision,
      weightSource: pinnedManifest.weightSource,
      weightRevision: pinnedManifest.weightRevision,
      license: pinnedManifest.license.spdx,
      documentationUrl: pinnedManifest.documentationUrl,
    },
    names,
    values,
    regionalComparisons: comparisons,
    confidence,
    elapsedMs: Math.max(0, finite(result.elapsedMs, 'DINOv2 elapsed time')),
    scope: 'pair',
    candidateId: expectedCandidateId,
    warnings: normalizedWarnings(result.warnings),
  }
}

export function dinoV2NeuralFeature(score) {
  const normalized = normalizeDinoV2CandidateScore({
    providerId: score.providerId,
    model: score.model,
    capabilities: ['embedding', 'preference-scoring'],
    confidence: score.confidence,
    elapsedMs: score.elapsedMs,
    preferenceFeatures: {
      modelId: score.model.modelId,
      names: score.names,
      values: score.values,
      confidence: score.confidence,
      scope: score.scope,
      candidateId: score.candidateId,
      regionalComparisons: score.regionalComparisons,
    },
    warnings: score.warnings,
  }, score.candidateId)
  return {
    providerId: normalized.providerId,
    modelId: normalized.model.modelId,
    candidateId: normalized.candidateId,
    names: normalized.names,
    values: normalized.values,
    confidence: normalized.confidence,
  }
}

function boundedMessage(error) {
  const value = error instanceof Error ? error.message : String(error)
  return value.replace(/\s+/g, ' ').trim().slice(0, 300) || 'DINOv2 scoring failed'
}

export async function scoreDinoV2Candidate({ scorer, request }) {
  if (scorer === undefined) return {}
  const startedAt = performance.now()
  try {
    const result = await scorer.scorePair(request)
    return { score: normalizeDinoV2CandidateScore(result, request.candidateId) }
  } catch (error) {
    return {
      warning: {
        providerId: DINOV2_PROVIDER_ID,
        candidateId: request.candidateId,
        elapsedMs: Math.max(0, performance.now() - startedAt),
        message: boundedMessage(error),
      },
    }
  }
}

export function createDinoV2CandidateScorer(options) {
  const provider = new HttpVisionProvider({
    manifest: pinnedManifest,
    endpoint: options.endpoint,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  return {
    providerId: DINOV2_PROVIDER_ID,
    manifest: pinnedManifest,
    scorePair(request) {
      return provider.analyze({
        image: request.candidateImage,
        referenceImage: request.referenceImage,
        capabilities: ['embedding', 'preference-scoring'],
        imageTypeHint: request.imageTypeHint,
        sourceId: request.sourceId,
        candidateId: request.candidateId,
        targetGrid: request.targetGrid,
        paletteId: request.paletteId,
        styleId: request.styleId,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
    },
  }
}
