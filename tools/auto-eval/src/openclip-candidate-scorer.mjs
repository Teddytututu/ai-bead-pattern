import {
  HttpVisionProvider,
  modelManifest,
} from '@ai-bead-pattern/ai-gateway'

export const OPENCLIP_FEATURE_NAMES = Object.freeze([
  'semanticRetention',
  'classDistributionRetention',
  'petBirdMargin',
])

export const OPENCLIP_EVALUATION_SOURCE_WEIGHTS = Object.freeze({
  rule: 0.7,
  neural: 0.3,
  humanPreference: 0,
})

export const OPENCLIP_VIEW_WEIGHTS = Object.freeze({
  global: 0.2,
  'subject-mask': 0.3,
  'face-mask': 0.5,
  'head-landmarks': 0.85,
})

export const OPENCLIP_PROVIDER_ID = 'openclip-vit-b32-pair-local'
export const OPENCLIP_MODEL_ID = 'mlfoundations/open_clip/ViT-B-32/laion2b_s34b_b79k'

const pinnedManifest = modelManifest(OPENCLIP_PROVIDER_ID)

function viewKind(id) {
  const separator = id.lastIndexOf(':')
  return separator < 0 ? id : id.slice(separator + 1)
}

function viewWeight(id) {
  return OPENCLIP_VIEW_WEIGHTS[viewKind(id)]
}

function supportedView(id) {
  return Object.hasOwn(OPENCLIP_VIEW_WEIGHTS, viewKind(id))
}

function criticalViewPriority(id) {
  const kind = viewKind(id)
  if (kind === 'head-landmarks') return 3
  if (kind === 'face-mask') return 2
  if (kind === 'subject-mask') return 1
  return 0
}

function viewScope(id) {
  const separator = id.lastIndexOf(':')
  return separator < 0 ? 'global' : id.slice(0, separator)
}

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

function bounded(value, label, minimum, maximum) {
  const parsed = finite(value, label)
  if (parsed < minimum || parsed > maximum) {
    throw new RangeError(`${label} must stay within ${minimum}..${maximum}`)
  }
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
    throw new RangeError('OpenCLIP warnings must be a bounded array')
  }
  return value.map((entry, index) => text(entry, `OpenCLIP warning ${index}`).slice(0, 300))
}

export function normalizeOpenClipCandidateScore(value, expectedCandidateId) {
  const result = object(value, 'OpenCLIP provider result')
  if (text(result.providerId, 'OpenCLIP provider id') !== OPENCLIP_PROVIDER_ID) {
    throw new RangeError('OpenCLIP provider identity differs from the pinned manifest')
  }
  const model = object(result.model, 'OpenCLIP model identity')
  if (sameIdentity(model) === false) {
    throw new RangeError('OpenCLIP model identity differs from the pinned manifest')
  }
  const capabilities = result.capabilities
  if (Array.isArray(capabilities) === false
    || capabilities.includes('embedding') === false
    || capabilities.includes('preference-scoring') === false) {
    throw new RangeError('OpenCLIP result must include embedding and preference-scoring capabilities')
  }
  const preference = object(result.preferenceFeatures, 'OpenCLIP preference features')
  if (preference.modelId !== pinnedManifest.modelId) {
    throw new RangeError('OpenCLIP preference feature model identity differs from the pinned manifest')
  }
  if (preference.scope !== 'pair') {
    throw new RangeError('OpenCLIP preference features must use pair scope')
  }
  if (text(preference.candidateId, 'OpenCLIP candidate identity') !== expectedCandidateId) {
    throw new RangeError('OpenCLIP candidate identity differs from the request')
  }
  if (Array.isArray(preference.names) === false
    || preference.names.length !== OPENCLIP_FEATURE_NAMES.length
    || preference.names.some((name, index) => name !== OPENCLIP_FEATURE_NAMES[index])) {
    throw new RangeError('OpenCLIP feature names differ from the pinned contract')
  }
  if (preference.values === undefined || preference.values.length !== OPENCLIP_FEATURE_NAMES.length) {
    throw new RangeError('OpenCLIP feature values differ from the pinned contract')
  }
  const semanticRetention = bounded(preference.values[0], 'OpenCLIP semantic retention', 0, 1)
  const classDistributionRetention = bounded(
    preference.values[1],
    'OpenCLIP class distribution retention',
    0,
    1,
  )
  const petBirdMargin = bounded(preference.values[2], 'OpenCLIP pet-bird margin', -1, 1)
  const confidence = Math.min(
    bounded(result.confidence, 'OpenCLIP result confidence', 0, 1),
    bounded(preference.confidence, 'OpenCLIP feature confidence', 0, 1),
  )
  return {
    providerId: OPENCLIP_PROVIDER_ID,
    model: {
      modelId: pinnedManifest.modelId,
      modelVersion: pinnedManifest.modelVersion,
      sourceRevision: pinnedManifest.sourceRevision,
      weightSource: pinnedManifest.weightSource,
      weightRevision: pinnedManifest.weightRevision,
      license: pinnedManifest.license.spdx,
      documentationUrl: pinnedManifest.documentationUrl,
    },
    features: {
      semanticRetention,
      classDistributionRetention,
      petBirdMargin,
    },
    confidence,
    elapsedMs: Math.max(0, finite(result.elapsedMs, 'OpenCLIP elapsed time')),
    scope: 'pair',
    candidateId: expectedCandidateId,
    warnings: normalizedWarnings(result.warnings),
  }
}

export function openClipNeuralFeature(score, subjectKind) {
  const normalized = normalizeOpenClipCandidateScore({
    providerId: score.providerId,
    model: score.model,
    capabilities: ['embedding', 'preference-scoring'],
    confidence: score.confidence,
    elapsedMs: score.elapsedMs,
    preferenceFeatures: {
      modelId: score.model.modelId,
      names: [...OPENCLIP_FEATURE_NAMES],
      values: Float32Array.from([
        score.features.semanticRetention,
        score.features.classDistributionRetention,
        score.features.petBirdMargin,
      ]),
      confidence: score.confidence,
      scope: score.scope,
      candidateId: score.candidateId,
    },
    warnings: score.warnings,
  }, score.candidateId)
  const calibrated = (value) => 0.5 + (value - 0.5) * normalized.confidence
  const names = ['semanticRetention', 'classDistributionRetention']
  const values = [
    calibrated(normalized.features.semanticRetention),
    calibrated(normalized.features.classDistributionRetention),
  ]
  if (subjectKind === 'pet') {
    names.push('petClassMargin')
    values.push(calibrated((normalized.features.petBirdMargin + 1) / 2))
  }
  return {
    providerId: normalized.providerId,
    modelId: normalized.model.modelId,
    candidateId: normalized.candidateId,
    names,
    values,
    confidence: normalized.confidence,
  }
}

function boundedMessage(error) {
  const value = error instanceof Error ? error.message : String(error)
  return value.replace(/\s+/g, ' ').trim().slice(0, 300) || 'OpenCLIP scoring failed'
}

export async function scoreOpenClipCandidate({ scorer, request }) {
  if (scorer === undefined) return {}
  const startedAt = performance.now()
  try {
    const result = await scorer.scorePair(request)
    return { score: normalizeOpenClipCandidateScore(result, request.candidateId) }
  } catch (error) {
    return {
      warning: {
        providerId: OPENCLIP_PROVIDER_ID,
        candidateId: request.candidateId,
        elapsedMs: Math.max(0, performance.now() - startedAt),
        message: boundedMessage(error),
      },
    }
  }
}

function scoringViews(request, views) {
  if (views === undefined) {
    return [{
      id: 'global',
      referenceImage: request.referenceImage,
      candidateImage: request.candidateImage,
    }]
  }
  if (Array.isArray(views) === false || views.length === 0) {
    throw new RangeError('OpenCLIP scoring views must contain at least one view')
  }
  const ids = new Set()
  for (const view of views) {
    if (supportedView(view.id) === false || ids.has(view.id)) {
      throw new RangeError('OpenCLIP scoring view identities must be unique and supported')
    }
    if (view.confidence !== undefined) bounded(view.confidence, `OpenCLIP ${view.id} view confidence`, 0, 1)
    if (view.evidenceConfidence !== undefined) {
      bounded(view.evidenceConfidence, `OpenCLIP ${view.id} evidence confidence`, 0, 1)
    }
    if (view.geometry?.retention !== undefined) {
      bounded(view.geometry.retention, `OpenCLIP ${view.id} geometry retention`, 0, 1)
    }
    ids.add(view.id)
  }
  const totalWeight = views.reduce(
    (sum, view) => sum + viewWeight(view.id)
      * (view.evidenceConfidence ?? view.confidence ?? 1),
    0,
  )
  if (totalWeight <= 0) {
    throw new RangeError('OpenCLIP scoring views require positive evidence confidence')
  }
  return views
}

function plannedViews(selectedViews, plannedViewIds) {
  const selectedIds = selectedViews.map((view) => view.id)
  if (plannedViewIds === undefined) return selectedIds
  if (Array.isArray(plannedViewIds) === false || plannedViewIds.length === 0) {
    throw new RangeError('OpenCLIP planned views must contain at least one view')
  }
  const ids = new Set()
  for (const id of plannedViewIds) {
    if (supportedView(id) === false || ids.has(id)) {
      throw new RangeError('OpenCLIP planned view identities must be unique and supported')
    }
    ids.add(id)
  }
  if (selectedIds.some((id) => ids.has(id) === false)) {
    throw new RangeError('OpenCLIP selected views must belong to the planned view set')
  }
  return [...plannedViewIds]
}

function viewEvidenceConfidence(view) {
  return view.evidenceConfidence ?? view.confidence ?? 1
}

function criticalPenalty(weightedMean, criticalValue, evidenceConfidence, strength = 0.25) {
  return Math.max(0, weightedMean - criticalValue) * strength * evidenceConfidence
}

function aggregateViewScores(scores, candidateId, plannedViewIds, selectedViewIds) {
  const effectiveWeight = (entry) => viewWeight(entry.id)
    * viewEvidenceConfidence(entry.view)
  const totalWeight = scores.reduce((sum, entry) => sum + effectiveWeight(entry), 0)
  const weighted = (selector) => scores.reduce(
    (sum, entry) => sum + selector(entry) * effectiveWeight(entry) / totalWeight,
    0,
  )
  const adjustedSemantic = (entry) => entry.score.features.semanticRetention
    * (0.35 + 0.65 * (entry.view.geometry?.retention ?? 1))
  const first = scores[0].score
  const views = Object.fromEntries(scores.map((entry) => {
    const weight = effectiveWeight(entry) / totalWeight
    return [entry.id, {
      weight,
      features: entry.score.features,
      confidence: entry.score.confidence,
      evidenceConfidence: viewEvidenceConfidence(entry.view),
      elapsedMs: entry.score.elapsedMs,
      adjustedSemanticRetention: adjustedSemantic(entry),
      ...(entry.view.geometry === undefined ? {} : { geometry: entry.view.geometry }),
    }]
  }))
  const weightedSemantic = weighted(adjustedSemantic)
  const criticalByScope = new Map()
  for (const entry of scores) {
    const priority = criticalViewPriority(entry.id)
    if (priority === 0) continue
    const scope = viewScope(entry.id)
    const current = criticalByScope.get(scope)
    if (current === undefined || priority > current.priority) {
      criticalByScope.set(scope, { priority, entries: [entry] })
    } else if (priority === current.priority) {
      current.entries.push(entry)
    }
  }
  const criticalEntries = [...criticalByScope.values()].flatMap((group) => group.entries)
  const selectedCriticalScopes = new Set(selectedViewIds
    .filter((id) => criticalViewPriority(id) > 0)
    .map((id) => viewScope(id)))
  const missingCriticalScopes = new Set(plannedViewIds
    .filter((id) => criticalViewPriority(id) > 0)
    .map((id) => viewScope(id))
    .filter((scope) => selectedCriticalScopes.has(scope) === false))
  const criticalFor = (selector, missingValue) => {
    const lowest = criticalEntries.reduce((current, entry) => (
      current === undefined || selector(entry) < selector(current) ? entry : current
    ), undefined)
    if (missingCriticalScopes.size > 0
      && (lowest === undefined || missingValue < selector(lowest))) {
      return { value: missingValue, evidenceConfidence: 1, missing: true }
    }
    if (lowest === undefined) return undefined
    return {
      value: selector(lowest),
      evidenceConfidence: viewEvidenceConfidence(lowest.view),
      missing: false,
    }
  }
  const aggregateFeature = (selector, missingValue) => {
    const weightedMean = weighted(selector)
    const critical = criticalFor(selector, missingValue)
    if (critical === undefined) return weightedMean
    return weightedMean - criticalPenalty(
      weightedMean,
      critical.value,
      critical.evidenceConfidence,
      critical.missing ? 1 : 0.25,
    )
  }
  const semanticCritical = criticalFor(adjustedSemantic, 0)
  const semanticRetention = semanticCritical === undefined
    ? weightedSemantic
    : weightedSemantic - criticalPenalty(
      weightedSemantic,
      semanticCritical.value,
      semanticCritical.evidenceConfidence,
      semanticCritical.missing ? 1 : 0.25,
    )
  const succeededViewIds = scores.map((entry) => entry.id)
  const succeeded = new Set(succeededViewIds)
  const missingViewIds = plannedViewIds.filter((id) => succeeded.has(id) === false)
  const missingCriticalViewIds = missingViewIds.filter((id) => criticalViewPriority(id) > 0)
  const plannedWeight = plannedViewIds.reduce((sum, id) => sum + viewWeight(id), 0)
  const succeededWeight = succeededViewIds.reduce((sum, id) => sum + viewWeight(id), 0)
  const coverageRatio = succeededWeight / plannedWeight
  const coverageWarnings = missingViewIds.length === 0
    ? []
    : [`[coverage] missing ${missingViewIds.join(', ')}`]
  return {
    ...first,
    features: {
      semanticRetention,
      classDistributionRetention: aggregateFeature(
        (entry) => entry.score.features.classDistributionRetention,
        0,
      ),
      petBirdMargin: aggregateFeature((entry) => entry.score.features.petBirdMargin, -1),
    },
    confidence: weighted((entry) => entry.score.confidence) * coverageRatio,
    elapsedMs: scores.reduce((sum, entry) => sum + entry.score.elapsedMs, 0),
    candidateId,
    views,
    coverage: {
      plannedViewIds,
      succeededViewIds,
      missingViewIds,
      missingCriticalViewIds,
      plannedWeight,
      succeededWeight,
      ratio: coverageRatio,
    },
    warnings: [
      ...scores.flatMap((entry) => entry.score.warnings.map((warning) => `[${entry.id}] ${warning}`)),
      ...coverageWarnings,
    ],
  }
}

export async function scoreOpenClipCandidateViews({ scorer, request, views, plannedViewIds }) {
  if (scorer === undefined) return {}
  const selectedViews = scoringViews(request, views)
  const planned = plannedViews(selectedViews, plannedViewIds)
  const outcomes = new Array(selectedViews.length)
  let nextView = 0
  const worker = async () => {
    while (request.signal?.aborted !== true) {
      const index = nextView
      if (index >= selectedViews.length) return
      nextView += 1
      const view = selectedViews[index]
      outcomes[index] = await scoreOpenClipCandidate({
        scorer,
        request: {
          ...request,
          referenceImage: view.referenceImage,
          candidateImage: view.candidateImage,
          viewId: view.id,
        },
      })
    }
  }
  const concurrency = Math.min(4, selectedViews.length)
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  const scores = []
  const warnings = []
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome === undefined) continue
    const view = selectedViews[index]
    if (outcome.score !== undefined) scores.push({ id: view.id, score: outcome.score, view })
    if (outcome.warning !== undefined) warnings.push({ ...outcome.warning, viewId: view.id })
  }
  if (scores.length === 0) return {
    ...(warnings.length === 0 ? {} : { warning: warnings[0], warnings }),
  }
  return {
    score: aggregateViewScores(
      scores,
      request.candidateId,
      planned,
      selectedViews.map((view) => view.id),
    ),
    ...(warnings.length === 0 ? {} : { warning: warnings[0], warnings }),
  }
}

export function createOpenClipCandidateScorer(options) {
  const provider = new HttpVisionProvider({
    manifest: pinnedManifest,
    endpoint: options.endpoint,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  return {
    providerId: OPENCLIP_PROVIDER_ID,
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
