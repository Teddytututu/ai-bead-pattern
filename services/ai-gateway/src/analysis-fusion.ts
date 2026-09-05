import {
  normalizeEvidenceProvenance,
  numericArrayFingerprintSync,
  type EvidenceOrigin,
  type EvidenceProvenance,
  type ImageAnalysis,
  type ImageLandmark,
  type ImportanceMap,
  type SemanticRegion,
  type SubjectMaskEvidence,
  type SubjectMaskSource,
} from '@ai-bead-pattern/pattern-core'

const subjectSourcePriority: Readonly<Record<SubjectMaskSource, number>> = {
  manual: 6,
  'ai+manual': 5,
  ai: 4,
  alpha: 3,
  heuristic: 2,
  fused: 1,
  legacy: 0,
}

const evidenceOriginPriority: Readonly<Record<EvidenceOrigin, number>> = {
  manual: 5,
  fused: 4,
  model: 3,
  source: 2,
  heuristic: 1,
}

const imageTypePriority = {
  portrait: 5,
  pet: 4,
  illustration: 3,
  landscape: 2,
  general: 1,
} as const

function canonicalKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (ArrayBuffer.isView(value)) {
    const values = value as unknown as ArrayLike<number>
    return `numeric:${values.length}:${numericArrayFingerprintSync(values)}`
  }
  if (Array.isArray(value)) return `[${value.map(canonicalKey).join(',')}]`
  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([first], [second]) => first.localeCompare(second))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalKey(entry)}`).join(',')}}`
}

function stableHash(value: unknown): string {
  const input = canonicalKey(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, '0')
}

function normalizeSubjectEvidence(evidence: SubjectMaskEvidence): SubjectMaskEvidence {
  const provenance = normalizeEvidenceProvenance(evidence.provenance)
  return {
    ...evidence,
    ...(provenance.length === 0 ? {} : { provenance }),
  }
}

function subjectPriority(evidence: SubjectMaskEvidence): readonly [number, number, number] {
  return [
    evidence.userConfirmed === true ? 1 : 0,
    evidence.confidence * subjectSourceReliability[evidence.source],
    subjectSourcePriority[evidence.source],
  ]
}

function subjectIsPreferred(candidate: SubjectMaskEvidence, current: SubjectMaskEvidence): boolean {
  const candidatePriority = subjectPriority(candidate)
  const currentPriority = subjectPriority(current)
  for (let index = 0; index < candidatePriority.length; index += 1) {
    if (candidatePriority[index] !== currentPriority[index]) {
      return candidatePriority[index]! > currentPriority[index]!
    }
  }
  return canonicalKey(candidate) < canonicalKey(current)
}

function selectedSubjectMask(analyses: readonly ImageAnalysis[]): SubjectMaskEvidence | undefined {
  const evidence: SubjectMaskEvidence[] = []
  for (const analysis of analyses) {
    if (analysis.subjectMaskEvidence !== undefined) {
      evidence.push(normalizeSubjectEvidence(analysis.subjectMaskEvidence))
      continue
    }
    if (analysis.subjectMask === undefined) continue
    evidence.push(normalizeSubjectEvidence({
      mask: analysis.subjectMask,
      confidence: analysis.confidence ?? 1,
      source: 'legacy',
      revision: `legacy:${stableHash(analysis.subjectMask)}`,
      provenance: [
        ...(analysis.provenance ?? []),
        { origin: 'source', provider: 'legacy-subject-mask', version: 'compat-v1' },
      ],
    }))
  }
  return evidence.reduce<SubjectMaskEvidence | undefined>((selected, candidate) =>
    selected === undefined || subjectIsPreferred(candidate, selected) ? candidate : selected,
  undefined)
}

function provenancePriority(provenance: readonly EvidenceProvenance[] | undefined): number {
  return Math.max(0, ...(provenance ?? []).map((entry) => evidenceOriginPriority[entry.origin]))
}

function provenanceReliability(provenance: readonly EvidenceProvenance[] | undefined): number {
  if (provenance === undefined || provenance.length === 0) return 1
  return Math.max(...provenance.map((entry) => evidenceOriginReliability[entry.origin]))
}

function calibratedConfidence(
  confidence: number,
  provenance: readonly EvidenceProvenance[] | undefined,
  observationState?: ImageLandmark['observationState'],
): number {
  const stateReliability = observationState === 'missing'
    ? 0.35
    : observationState === 'inferred'
      ? 0.75
      : 1
  return confidence * provenanceReliability(provenance) * stateReliability
}

function candidateObservationState(value: unknown): ImageLandmark['observationState'] | undefined {
  if (value !== null && typeof value === 'object' && 'observationState' in value) {
    const state = (value as { observationState?: unknown }).observationState
    if (state === 'observed' || state === 'inferred' || state === 'missing') return state
  }
  return undefined
}

function mergeById<T extends {
  id: string
  confidence: number
  provenance?: readonly EvidenceProvenance[]
}>(groups: readonly (readonly T[] | undefined)[]): readonly T[] {
  const selected = new Map<string, T>()
  for (const group of groups) {
    for (const rawCandidate of group ?? []) {
      const provenance = normalizeEvidenceProvenance(rawCandidate.provenance)
      const candidate = {
        ...rawCandidate,
        ...(provenance.length === 0 ? {} : { provenance }),
      }
      const current = selected.get(candidate.id)
      const candidateConfidence = calibratedConfidence(
        candidate.confidence,
        candidate.provenance,
        candidateObservationState(candidate),
      )
      const currentConfidence = current === undefined
        ? Number.NEGATIVE_INFINITY
        : calibratedConfidence(
          current.confidence,
          current.provenance,
          candidateObservationState(current),
        )
      const preferred = current === undefined
        || candidateConfidence > currentConfidence
        || (candidateConfidence === currentConfidence
          && (provenancePriority(candidate.provenance) > provenancePriority(current.provenance)
            || (provenancePriority(candidate.provenance) === provenancePriority(current.provenance)
              && canonicalKey(candidate) < canonicalKey(current))))
      if (preferred) selected.set(candidate.id, candidate)
    }
  }
  return [...selected.values()].sort((first, second) => first.id.localeCompare(second.id))
}

const subjectSourceReliability: Readonly<Record<SubjectMaskSource, number>> = {
  manual: 1,
  'ai+manual': 0.98,
  ai: 0.95,
  fused: 0.94,
  alpha: 0.9,
  heuristic: 0.65,
  legacy: 0.55,
}

const evidenceOriginReliability: Readonly<Record<EvidenceOrigin, number>> = {
  manual: 1,
  fused: 0.98,
  model: 0.95,
  source: 0.9,
  heuristic: 0.65,
}

function landmarkInstanceId(landmark: ImageLandmark): string | undefined {
  const separator = landmark.id.indexOf(':')
  return separator > 0 ? landmark.id.slice(0, separator) : undefined
}

function reconcileLandmarkRegions(
  landmarks: readonly ImageLandmark[],
  regions: readonly SemanticRegion[],
): readonly ImageLandmark[] {
  const regionIds = new Set(regions.map((region) => region.id))
  return landmarks.map((landmark) => {
    const {
      featureRegionId,
      carrierRegionId,
      ...base
    } = landmark
    const instanceId = landmarkInstanceId(landmark)
    const resolvedFeatureRegionId = featureRegionId !== undefined && regionIds.has(featureRegionId)
      ? featureRegionId
      : undefined
    const resolvedCarrierRegionId = carrierRegionId !== undefined && regionIds.has(carrierRegionId)
      ? carrierRegionId
      : instanceId !== undefined && regionIds.has(`${instanceId}:subject`)
        ? `${instanceId}:subject`
        : instanceId === undefined && regionIds.has('subject')
          ? 'subject'
          : undefined
    return {
      ...base,
      ...(resolvedFeatureRegionId === undefined ? {} : { featureRegionId: resolvedFeatureRegionId }),
      ...(resolvedCarrierRegionId === undefined ? {} : { carrierRegionId: resolvedCarrierRegionId }),
    }
  })
}

function evidenceConfidence(
  subject: SubjectMaskEvidence | undefined,
  landmarks: readonly ImageLandmark[],
  regions: readonly SemanticRegion[],
  analyses: readonly ImageAnalysis[],
): number | undefined {
  const values = [
    ...(subject === undefined ? [] : [subject.confidence]),
    ...landmarks.map((landmark) => landmark.confidence),
    ...regions.map((region) => region.confidence),
  ]
  if (values.length === 0) {
    values.push(...analyses.flatMap((analysis) =>
      analysis.confidence === undefined ? [] : [analysis.confidence],
    ))
  }
  if (values.length === 0) return undefined
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function collectedProvenance(
  analyses: readonly ImageAnalysis[],
  subject: SubjectMaskEvidence | undefined,
  landmarks: readonly ImageLandmark[],
  regions: readonly SemanticRegion[],
): readonly EvidenceProvenance[] {
  return normalizeEvidenceProvenance([
    ...(subject?.provenance ?? []),
    ...landmarks.flatMap((landmark) => landmark.provenance ?? []),
    ...regions.flatMap((region) => region.provenance ?? []),
    ...analyses.flatMap((analysis) => analysis.provenance ?? []),
  ])
}

function selectedCrop(
  analyses: readonly ImageAnalysis[],
  source: 'manual' | 'automatic',
): ImageAnalysis | undefined {
  return analyses
    .filter((analysis) => analysis.suggestedCrop !== undefined
      && analysis.suggestedCropSource === source)
    .sort((first, second) =>
      (second.suggestedCropConfidence ?? 0) - (first.suggestedCropConfidence ?? 0)
        || canonicalKey(first.suggestedCrop).localeCompare(canonicalKey(second.suggestedCrop)),
    )[0]
}

function fusedImportanceMap(analyses: readonly ImageAnalysis[]): ImportanceMap | undefined {
  const sources = analyses.filter((analysis) => analysis.importanceMap !== undefined)
  if (sources.length === 0) return undefined
  const reference = sources[0]!.importanceMap!
  if (Number.isInteger(reference.width) === false || reference.width <= 0
    || Number.isInteger(reference.height) === false || reference.height <= 0
    || reference.weights.length !== reference.width * reference.height) {
    throw new RangeError('Importance map dimensions and weights must align')
  }
  if (sources.length === 1) {
    const weights = Float32Array.from(reference.weights)
    for (const value of weights) {
      if (Number.isFinite(value) === false || value < 0 || value > 1) {
        throw new RangeError('Importance map weights must stay within 0..1')
      }
    }
    return { width: reference.width, height: reference.height, weights }
  }
  const weights = new Float32Array(reference.weights.length)
  for (const analysis of sources) {
    const map = analysis.importanceMap!
    if (map.width !== reference.width || map.height !== reference.height
      || map.weights.length !== weights.length) {
      throw new RangeError('Importance map dimensions must match during fusion')
    }
    const sourceWeight = Math.min(1, Math.max(0, analysis.confidence ?? 1))
      * provenanceReliability(analysis.provenance)
    for (let index = 0; index < weights.length; index += 1) {
      const value = map.weights[index]!
      if (Number.isFinite(value) === false || value < 0 || value > 1) {
        throw new RangeError('Importance map weights must stay within 0..1')
      }
      weights[index] = Math.max(weights[index]!, value * sourceWeight)
    }
  }
  return { width: reference.width, height: reference.height, weights }
}

function selectedImageType(analyses: readonly ImageAnalysis[]): ImageAnalysis | undefined {
  return analyses
    .filter((analysis) => analysis.imageType !== undefined)
    .sort((first, second) =>
      imageTypePriority[second.imageType!] - imageTypePriority[first.imageType!],
    )[0]
}

function mergedModelVersions(analyses: readonly ImageAnalysis[]): Readonly<Record<string, string>> {
  const values = new Map<string, Set<string>>()
  for (const analysis of analyses) {
    for (const [name, version] of Object.entries(analysis.modelVersions ?? {})) {
      const versions = values.get(name) ?? new Set<string>()
      versions.add(version)
      values.set(name, versions)
    }
  }
  return Object.fromEntries([...values.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([name, versions]) => [name, [...versions].sort().join(' + ')]))
}

export function fuseImageAnalyses(analyses: readonly ImageAnalysis[]): ImageAnalysis {
  const subject = selectedSubjectMask(analyses)
  const semanticRegions = mergeById(analyses.map((analysis) => analysis.semanticRegions))
  const landmarks = reconcileLandmarkRegions(
    mergeById(analyses.map((analysis) => analysis.landmarks)),
    semanticRegions,
  )
  const cropSource = selectedCrop(analyses, 'manual') ?? selectedCrop(analyses, 'automatic')
  const importanceMap = fusedImportanceMap(analyses)
  const imageTypeSource = selectedImageType(analyses)
  const modelVersions = mergedModelVersions(analyses)
  const provenance = collectedProvenance(analyses, subject, landmarks, semanticRegions)
  const confidence = evidenceConfidence(subject, landmarks, semanticRegions, analyses)

  return {
    ...(subject === undefined ? {} : { subjectMaskEvidence: subject, subjectMask: subject.mask }),
    ...(semanticRegions.length === 0 ? {} : { semanticRegions }),
    ...(landmarks.length === 0 ? {} : { landmarks }),
    ...(importanceMap === undefined ? {} : { importanceMap }),
    ...(cropSource?.suggestedCrop === undefined ? {} : {
      suggestedCrop: cropSource.suggestedCrop,
      suggestedCropConfidence: cropSource.suggestedCropConfidence,
      suggestedCropSource: cropSource.suggestedCropSource,
    }),
    ...(imageTypeSource?.imageType === undefined ? {} : { imageType: imageTypeSource.imageType }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(Object.keys(modelVersions).length === 0 ? {} : { modelVersions }),
    ...(provenance.length === 0 ? {} : { provenance }),
  }
}
