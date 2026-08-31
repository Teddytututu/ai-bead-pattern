import type {
  CandidateEvaluationModelIdentity,
  CandidateEvaluationScoreV2,
  CandidateEvaluationSourceWeights,
  CandidateEvaluationV2,
  CandidateEvaluationV2Input,
  CandidateNeuralPreferenceFeatures,
  CandidateProviderContribution,
  CandidateScore,
  SelectedPreferenceRankingInput,
} from './types.js'

const defaultWeights: CandidateEvaluationSourceWeights = {
  rule: 0.55,
  neural: 0.15,
  humanPreference: 0.3,
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || Number.isFinite(value) === false) {
    throw new TypeError(`${label} must be finite`)
  }
  return value
}

function unit(value: unknown, label: string): number {
  const parsed = finite(value, label)
  if (parsed < 0 || parsed > 1) throw new RangeError(`${label} must stay within 0..1`)
  return parsed
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function validateCandidateScore(candidateId: string, score: CandidateScore): void {
  for (const [name, value] of Object.entries(score)) {
    unit(value, `Candidate ${candidateId} score ${name}`)
  }
}

function validateModel(model: CandidateEvaluationModelIdentity): CandidateEvaluationModelIdentity {
  return {
    name: text(model?.name, 'Selected preference model name'),
    version: text(model?.version, 'Selected preference model version'),
  }
}

function validateRanking(
  ranking: SelectedPreferenceRankingInput,
  candidateIds: readonly string[],
): SelectedPreferenceRankingInput {
  const known = new Set(candidateIds)
  if (ranking.rankedCandidateIds.length !== candidateIds.length
    || new Set(ranking.rankedCandidateIds).size !== ranking.rankedCandidateIds.length) {
    throw new RangeError('Selected preference ranking must include every candidate exactly once')
  }
  for (const candidateId of ranking.rankedCandidateIds) {
    if (known.has(candidateId) === false) throw new RangeError('Selected preference ranking references an unknown candidate')
  }
  const scores: Record<string, number> = {}
  for (const candidateId of candidateIds) {
    if (Object.hasOwn(ranking.scores, candidateId) === false) {
      throw new RangeError('Selected preference scores must include every candidate')
    }
    scores[candidateId] = unit(ranking.scores[candidateId], `Selected preference score ${candidateId}`)
  }
  for (const candidateId of Object.keys(ranking.scores)) {
    if (known.has(candidateId) === false) throw new RangeError('Selected preference scores reference an unknown candidate')
  }
  return {
    rankedCandidateIds: [...ranking.rankedCandidateIds],
    scores,
    model: validateModel(ranking.model),
  }
}

function validateFeatures(
  feature: CandidateNeuralPreferenceFeatures,
  knownCandidates: ReadonlySet<string>,
): CandidateNeuralPreferenceFeatures {
  const providerId = text(feature?.providerId, 'Neural preference feature provider')
  const modelId = text(feature?.modelId, 'Neural preference feature model')
  if (feature.names.length === 0 || feature.names.length !== feature.values.length
    || new Set(feature.names).size !== feature.names.length) {
    throw new RangeError('Neural preference feature names and values must align')
  }
  const names = feature.names.map((name) => text(name, 'Neural preference feature name'))
  const values = feature.values.map((value, index) => finite(value, `Neural preference feature value ${index}`))
  const candidateId = feature.candidateId === undefined
    ? undefined
    : text(feature.candidateId, 'Neural preference feature candidate')
  if (candidateId !== undefined && knownCandidates.has(candidateId) === false) {
    throw new RangeError('Neural preference feature references an unknown candidate')
  }
  return {
    providerId,
    modelId,
    ...(candidateId === undefined ? {} : { candidateId }),
    names,
    values,
    confidence: unit(feature.confidence, 'Neural preference feature confidence'),
  }
}

function validateContribution(contribution: CandidateProviderContribution): CandidateProviderContribution {
  const providerId = text(contribution?.providerId, 'Candidate evaluation provider id')
  const modelId = text(contribution?.modelId, 'Candidate evaluation model id')
  if (contribution.status !== 'used' && contribution.status !== 'failed') {
    throw new RangeError('Candidate evaluation provider status is invalid')
  }
  if (contribution.capabilities.length === 0
    || new Set(contribution.capabilities).size !== contribution.capabilities.length) {
    throw new RangeError('Candidate evaluation provider capabilities must be unique and non-empty')
  }
  const capabilities = contribution.capabilities.map((capability) =>
    text(capability, 'Candidate evaluation provider capability'))
  const confidence = contribution.confidence === undefined
    ? undefined
    : unit(contribution.confidence, 'Candidate evaluation provider confidence')
  const elapsedMs = finite(contribution.elapsedMs, 'Candidate evaluation provider elapsed time')
  if (elapsedMs < 0) throw new RangeError('Candidate evaluation provider elapsed time must be non-negative')
  const message = contribution.message === undefined
    ? undefined
    : text(contribution.message, 'Candidate evaluation provider message')
  return {
    providerId,
    modelId,
    capabilities,
    status: contribution.status,
    ...(confidence === undefined ? {} : { confidence }),
    elapsedMs,
    ...(message === undefined ? {} : { message }),
  }
}

function validateWeights(weights: CandidateEvaluationSourceWeights): CandidateEvaluationSourceWeights {
  const result = {
    rule: finite(weights.rule, 'Candidate evaluation rule weight'),
    neural: finite(weights.neural, 'Candidate evaluation neural weight'),
    humanPreference: finite(weights.humanPreference, 'Candidate evaluation human preference weight'),
  }
  if (Object.values(result).some((value) => value < 0)
    || Object.values(result).every((value) => value === 0)) {
    throw new RangeError('Candidate evaluation source weights require a positive non-negative total')
  }
  return result
}

function appliedWeights(
  weights: CandidateEvaluationSourceWeights,
  neuralAvailable: boolean,
  preferenceAvailable: boolean,
): CandidateEvaluationSourceWeights {
  const available = {
    rule: weights.rule,
    neural: neuralAvailable ? weights.neural : 0,
    humanPreference: preferenceAvailable ? weights.humanPreference : 0,
  }
  const total = available.rule + available.neural + available.humanPreference
  if (total <= 0) throw new RangeError('Candidate evaluation requires a positive weight for an available source')
  return {
    rule: available.rule / total,
    neural: available.neural / total,
    humanPreference: available.humanPreference / total,
  }
}

function neuralScore(
  candidateId: string,
  features: readonly CandidateNeuralPreferenceFeatures[],
): number {
  const entries = features.filter((entry) =>
    entry.candidateId === undefined || entry.candidateId === candidateId)
  if (entries.length === 0) return 0.5
  const weighted = entries.reduce((sum, entry) => {
    const mean = entry.values.reduce((featureSum, value) => featureSum + clampUnit(value), 0)
      / entry.values.length
    return sum + mean * entry.confidence
  }, 0)
  const confidence = entries.reduce((sum, entry) => sum + entry.confidence, 0)
  return confidence === 0 ? 0.5 : weighted / confidence
}

function rank(candidateIds: readonly string[], totals: Readonly<Record<string, number>>): readonly string[] {
  return [...candidateIds].sort((first, second) =>
    totals[second]! - totals[first]! || first.localeCompare(second))
}

export function composeCandidateEvaluationV2(
  input: CandidateEvaluationV2Input,
): CandidateEvaluationV2 {
  const candidateIds = Object.keys(input.scores)
  if (candidateIds.length === 0 || candidateIds.some((candidateId) => candidateId.trim().length === 0)) {
    throw new RangeError('Candidate evaluation requires named candidates')
  }
  for (const candidateId of candidateIds) validateCandidateScore(candidateId, input.scores[candidateId]!)
  const knownCandidates = new Set(candidateIds)
  const features = (input.neuralPreferenceFeatures ?? [])
    .map((feature) => validateFeatures(feature, knownCandidates))
  const contributions = (input.providerContributions ?? []).map(validateContribution)
  const preference = input.selectedPreferenceRanking === undefined
    ? undefined
    : validateRanking(input.selectedPreferenceRanking, candidateIds)
  const sourceWeights = validateWeights(input.sourceWeights ?? defaultWeights)
  const applied = appliedWeights(sourceWeights, features.length > 0, preference !== undefined)
  const ruleTotals = Object.fromEntries(candidateIds.map((candidateId) => [candidateId, input.scores[candidateId]!.total]))
  const candidateScores: Record<string, CandidateEvaluationScoreV2> = {}
  for (const candidateId of candidateIds) {
    const rule = ruleTotals[candidateId]!
    const neural = neuralScore(candidateId, features)
    const humanPreference = preference?.scores[candidateId] ?? 0.5
    candidateScores[candidateId] = {
      rule,
      neural,
      humanPreference,
      final: rule * applied.rule + neural * applied.neural + humanPreference * applied.humanPreference,
    }
  }
  const finalTotals = Object.fromEntries(candidateIds.map((candidateId) => [
    candidateId,
    candidateScores[candidateId]!.final,
  ]))
  const finalRankedCandidateIds = rank(candidateIds, finalTotals)
  return {
    version: 2,
    rankedCandidateIds: finalRankedCandidateIds,
    scores: input.scores,
    ruleRankedCandidateIds: rank(candidateIds, ruleTotals),
    learnedRankedCandidateIds: preference?.rankedCandidateIds ?? [],
    finalRankedCandidateIds,
    candidateScores,
    neuralPreferenceFeatures: features,
    providerContributions: contributions,
    sourceWeights,
    appliedSourceWeights: applied,
    ...(preference === undefined ? {} : { selectedModel: preference.model }),
  }
}
