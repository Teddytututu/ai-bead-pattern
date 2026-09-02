import {
  PREFERENCE_FEATURES,
  PREFERENCE_ISSUES,
  deduplicatePreferenceRecords,
  normalizePreferenceRecordV2,
  type PreferenceCandidateV2,
  type PreferenceFeatureName,
  type PreferenceFeatureVector,
  type PreferenceIssue,
  type PreferenceRecordV2,
  type PreferenceSubjectKind,
} from './preference-v2.js'
import type { GridSize, PatternStyle } from './types.js'

export interface PreferenceModelContext {
  subjectKind: PreferenceSubjectKind
  grid: GridSize
  style: PatternStyle
  paletteId: string
}

export interface PreferenceGenerationAdjustments {
  featureProtection: number
  thinStructure: number
  boundaryAnchor: number
  valueOrder: number
  refinement: number
  craftCost: number
}

export interface PreferenceGenerationParameters {
  importanceStrength: number
  edgeStrength: number
  edgeProtection: number
  isolatedPixelPenalty: number
  stripePenalty: number
  valueOrderStrength: number
  localSearchIterations: number
  maxColorsScale: number
}

export interface PreferenceConfidenceInterval {
  lower: number
  upper: number
}

export interface PreferenceStratumModel {
  sampleCount: number
  weights: PreferenceFeatureVector
}

export interface PreferenceModelV2 {
  model: 'preference-linear-v2'
  version: string
  baselineWeights: PreferenceFeatureVector
  learnedWeights: PreferenceFeatureVector
  sampleCount: number
  comparisonCount: number
  issueCounts: Readonly<Record<PreferenceIssue, number>>
  confidenceIntervals: Readonly<Record<PreferenceFeatureName, PreferenceConfidenceInterval>>
  generationAdjustments: PreferenceGenerationAdjustments
  strata: Readonly<Record<string, PreferenceStratumModel>>
}

export interface PreferenceModelOptions {
  maximumIterations?: number
  learningRate?: number
  regularization?: number
  minimumStratumSamples?: number
}

export interface PreferenceCandidateRankScore {
  total: number
  probabilityShare: number
  contributions: PreferenceFeatureVector
}

export interface PreferenceRankingResult {
  rankedCandidateIds: readonly string[]
  scores: Readonly<Record<string, PreferenceCandidateRankScore>>
  weights: PreferenceFeatureVector
  stratumKeys: readonly string[]
}

export interface ComparedPreferencePair {
  candidateAId: string
  candidateBId: string
  count: number
}

export interface ActivePreferencePairOptions {
  context: PreferenceModelContext
  comparedPairs?: readonly ComparedPreferencePair[]
  issueCoverage?: Partial<Readonly<Record<PreferenceIssue, number>>>
}

export interface ActivePreferencePair {
  candidateAId: string
  candidateBId: string
  priority: number
  uncertainty: number
  modelDisagreement: number
  coverageScarcity: number
  repeatPenalty: number
}

export interface FrozenPreferenceSplitOptions {
  seed: string
  trainRatio?: number
  validationRatio?: number
  holdoutRatio?: number
}

export interface FrozenPreferenceSplit {
  version: string
  seed: string
  ratios: {
    train: number
    validation: number
    holdout: number
  }
  recordIds: {
    train: readonly string[]
    validation: readonly string[]
    holdout: readonly string[]
  }
  groupAssignments: Readonly<Record<string, 'train' | 'validation' | 'holdout'>>
}

export interface PreferenceEvaluationMetrics {
  comparisons: number
  accuracy: number
  logLoss: number
  tieMeanAbsoluteError: number
}

export interface PreferenceModelComparison {
  baselineVersion: string
  challengerVersion: string
  baseline: PreferenceEvaluationMetrics
  challenger: PreferenceEvaluationMetrics
  accuracyGain: number
  logLossReduction: number
}

export interface PreferenceModelSelectionOptions {
  minimumTrainingSamples?: number
  minimumAccuracyGain?: number
  maximumLogLossRegression?: number
}

export interface PreferenceModelSelection {
  selectedVersion: string
  rolledBack: boolean
  reason: 'accepted' | 'insufficient-samples' | 'accuracy-regression' | 'log-loss-regression'
}

export const BASELINE_PREFERENCE_WEIGHTS: PreferenceFeatureVector = {
  silhouette: 0.15,
  identityFeatures: 0.18,
  composition: 0.08,
  valueOrder: 0.10,
  colorFidelity: 0.08,
  pixelClusters: 0.10,
  contourRhythm: 0.07,
  thinStructure: 0.08,
  boundaryAnchors: 0.06,
  material: 0.03,
  styleFit: 0.03,
  craftEase: 0.04,
}

const issueBoosts: Readonly<Record<PreferenceIssue, Partial<Record<PreferenceFeatureName, number>>>> = {
  'facial-feature-loss': { identityFeatures: 1, boundaryAnchors: 0.35 },
  'marking-loss': { identityFeatures: 0.8, colorFidelity: 0.2 },
  'pattern-loss': { identityFeatures: 0.8, colorFidelity: 0.2 },
  'thin-structure-collapse': { thinStructure: 1, boundaryAnchors: 0.8 },
  'jagged-contour': { contourRhythm: 0.8, pixelClusters: 0.4 },
  'isolated-cell': { pixelClusters: 1, contourRhythm: 0.2 },
  'color-stripe': { pixelClusters: 0.8, colorFidelity: 0.2 },
  'color-banding': { pixelClusters: 0.8, colorFidelity: 0.2 },
  'texture-noise': { pixelClusters: 0.8, material: 0.2 },
  'value-confusion': { valueOrder: 1 },
  'palette-deviation': { colorFidelity: 1 },
  'proportion-distortion': { composition: 0.8, silhouette: 0.4 },
  'background-dominance': { composition: 0.8, silhouette: 0.3 },
  'too-many-colors': { craftEase: 0.7, colorFidelity: 0.3 },
  'fragile-thin-structure': { thinStructure: 0.8, craftEase: 0.3 },
  'craft-complexity': { craftEase: 1 },
}

const axisFeatureMapping: Readonly<Record<string, readonly PreferenceFeatureName[]>> = {
  subjectRecognition: ['identityFeatures', 'silhouette'],
  silhouette: ['silhouette'],
  identityFeatures: ['identityFeatures', 'boundaryAnchors'],
  composition: ['composition'],
  valueHierarchy: ['valueOrder'],
  palette: ['colorFidelity'],
  contourRhythm: ['contourRhythm', 'boundaryAnchors'],
  pixelClusters: ['pixelClusters'],
  material: ['material'],
  styleFit: ['styleFit'],
  craftEase: ['craftEase'],
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const exp = Math.exp(-value)
    return 1 / (1 + exp)
  }
  const exp = Math.exp(value)
  return exp / (1 + exp)
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b) >>> 0
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0
  hash ^= hash >>> 16
  return hash >>> 0
}

function stableVersion(value: unknown): string {
  return `preference-v2-${stableHash(JSON.stringify(value)).toString(16).padStart(8, '0')}`
}

function featureRecord(initial: number | PreferenceFeatureVector): Record<PreferenceFeatureName, number> {
  return Object.fromEntries(PREFERENCE_FEATURES.map((name) => [
    name,
    typeof initial === 'number' ? initial : initial[name],
  ])) as Record<PreferenceFeatureName, number>
}

function normalizeWeights(input: Readonly<Record<PreferenceFeatureName, number>>): PreferenceFeatureVector {
  const positive = featureRecord(0)
  let total = 0
  for (const name of PREFERENCE_FEATURES) {
    positive[name] = clamp(input[name], 0.001, 1)
    total += positive[name]
  }
  return Object.fromEntries(PREFERENCE_FEATURES.map((name) => [name, positive[name] / total])) as unknown as PreferenceFeatureVector
}

function candidateMap(record: PreferenceRecordV2): ReadonlyMap<string, PreferenceCandidateV2> {
  return new Map(record.candidates.map((candidate) => [candidate.id, candidate]))
}

interface TrainingExample {
  difference: PreferenceFeatureVector
  target: number
  weight: number
}

function comparisonExamples(records: readonly PreferenceRecordV2[]): readonly TrainingExample[] {
  const examples: TrainingExample[] = []
  for (const record of records) {
    const annotatorConfidence = record.annotator.confidence ?? 1
    const candidates = candidateMap(record)
    const difference = (first: PreferenceCandidateV2, second: PreferenceCandidateV2): PreferenceFeatureVector =>
      Object.fromEntries(PREFERENCE_FEATURES.map((name) => [
        name,
        first.features[name] - second.features[name],
      ])) as unknown as PreferenceFeatureVector
    for (const comparison of record.comparisons) {
      const first = candidates.get(comparison.candidateAId)!
      const second = candidates.get(comparison.candidateBId)!
      examples.push({
        difference: difference(first, second),
        target: comparison.choice === 'a' ? 1 : comparison.choice === 'b' ? 0 : 0.5,
        weight: comparison.weight ?? annotatorConfidence,
      })
    }
    if (record.ranking !== undefined) {
      for (let index = 0; index + 1 < record.ranking.length; index += 1) {
        const first = candidates.get(record.ranking[index]!)
        const second = candidates.get(record.ranking[index + 1]!)
        if (first === undefined || second === undefined) continue
        examples.push({
          difference: difference(first, second),
          target: 1,
          weight: 0.5 * annotatorConfidence,
        })
      }
    }
    for (let firstIndex = 0; firstIndex < record.candidates.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < record.candidates.length; secondIndex += 1) {
        const first = record.candidates[firstIndex]!
        const second = record.candidates[secondIndex]!
        const firstScores = record.axisScores[first.id]
        const secondScores = record.axisScores[second.id]
        if (firstScores === undefined || secondScores === undefined) continue
        const meanDifference = Object.keys(axisFeatureMapping).reduce((sum, axis) =>
          sum + firstScores[axis as keyof typeof firstScores]
            - secondScores[axis as keyof typeof secondScores], 0) / Object.keys(axisFeatureMapping).length
        examples.push({
          difference: difference(first, second),
          target: clamp(0.5 + meanDifference / 8, 0, 1),
          weight: 0.7 * annotatorConfidence,
        })
      }
    }
  }
  return examples
}

function scoreDifference(weights: PreferenceFeatureVector, difference: PreferenceFeatureVector): number {
  return PREFERENCE_FEATURES.reduce((sum, name) => sum + weights[name] * difference[name], 0)
}

function learnPairwiseWeights(
  records: readonly PreferenceRecordV2[],
  options: PreferenceModelOptions,
): PreferenceFeatureVector {
  const examples = comparisonExamples(records)
  if (examples.length === 0) return { ...BASELINE_PREFERENCE_WEIGHTS }
  const iterations = options.maximumIterations ?? 240
  const learningRate = options.learningRate ?? 0.35
  const regularization = options.regularization ?? 1.5
  if (Number.isInteger(iterations) === false || iterations <= 0 || iterations > 10_000) {
    throw new RangeError('Preference maximumIterations must stay within 1..10000')
  }
  if (Number.isFinite(learningRate) === false || learningRate <= 0) {
    throw new RangeError('Preference learningRate must be finite and positive')
  }
  if (Number.isFinite(regularization) === false || regularization < 0) {
    throw new RangeError('Preference regularization must be finite and non-negative')
  }
  const weights = featureRecord(BASELINE_PREFERENCE_WEIGHTS)
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const gradient = featureRecord(0)
    for (const example of examples) {
      const error = (example.target - sigmoid(scoreDifference(weights, example.difference) * 6)) * example.weight
      for (const name of PREFERENCE_FEATURES) gradient[name] += error * example.difference[name]
    }
    const step = learningRate / Math.sqrt(iteration + 1)
    for (const name of PREFERENCE_FEATURES) {
      const priorPull = regularization * (BASELINE_PREFERENCE_WEIGHTS[name] - weights[name])
      weights[name] = clamp(weights[name] + step * (gradient[name] + priorPull) / examples.length, 0.002, 0.6)
    }
  }
  return normalizeWeights(weights)
}

function collectIssueCounts(records: readonly PreferenceRecordV2[]): Record<PreferenceIssue, number> {
  const counts = Object.fromEntries(PREFERENCE_ISSUES.map((issue) => [issue, 0])) as Record<PreferenceIssue, number>
  for (const record of records) {
    for (const annotation of record.issueAnnotations) {
      counts[annotation.issue] += annotation.severity / 5 * annotation.confidence
    }
  }
  return counts
}

function applySupervisionBoosts(
  pairwiseWeights: PreferenceFeatureVector,
  records: readonly PreferenceRecordV2[],
  issueCounts: Readonly<Record<PreferenceIssue, number>>,
): PreferenceFeatureVector {
  const weights = featureRecord(pairwiseWeights)
  const sampleScale = Math.max(1, records.length)
  for (const issue of PREFERENCE_ISSUES) {
    const frequency = issueCounts[issue] / sampleScale
    for (const [feature, boost] of Object.entries(issueBoosts[issue]) as [PreferenceFeatureName, number][]) {
      weights[feature] += clamp(frequency, 0, 1) * boost * 0.08
    }
  }
  for (const record of records) {
    const candidates = candidateMap(record)
    for (const comparison of record.comparisons) {
      if (comparison.choice === 'tie') continue
      const winnerId = comparison.choice === 'a' ? comparison.candidateAId : comparison.candidateBId
      const loserId = comparison.choice === 'a' ? comparison.candidateBId : comparison.candidateAId
      const winnerScores = record.axisScores[winnerId]
      const loserScores = record.axisScores[loserId]
      if (winnerScores === undefined || loserScores === undefined) continue
      for (const [axis, features] of Object.entries(axisFeatureMapping)) {
        const axisDelta = clamp((winnerScores[axis as keyof typeof winnerScores]
          - loserScores[axis as keyof typeof loserScores]) / 4, -1, 1)
        if (axisDelta <= 0) continue
        for (const feature of features) weights[feature] += axisDelta * 0.002 / records.length
      }
      const winner = candidates.get(winnerId)
      const loser = candidates.get(loserId)
      if (winner === undefined || loser === undefined) continue
      for (const name of PREFERENCE_FEATURES) {
        if (winner.features[name] > loser.features[name]) weights[name] += 0.001 / records.length
      }
    }
  }
  return normalizeWeights(weights)
}

function stratumKeys(context: PreferenceModelContext): readonly string[] {
  return [
    `subject:${context.subjectKind}`,
    `grid:${context.grid.width}x${context.grid.height}`,
    `style:${context.style}`,
    `palette:${context.paletteId}`,
  ]
}

function recordStratumKeys(record: PreferenceRecordV2): readonly string[] {
  const keys = new Set<string>([`subject:${record.source.subjectKind}`])
  for (const candidate of record.candidates) {
    keys.add(`grid:${candidate.grid.width}x${candidate.grid.height}`)
    keys.add(`style:${candidate.style}`)
    keys.add(`palette:${candidate.paletteId}`)
  }
  return [...keys].sort()
}

function buildStrata(
  records: readonly PreferenceRecordV2[],
  globalWeights: PreferenceFeatureVector,
  minimumSamples: number,
  options: PreferenceModelOptions,
): Readonly<Record<string, PreferenceStratumModel>> {
  const recordsByKey = new Map<string, PreferenceRecordV2[]>()
  for (const record of records) {
    for (const key of recordStratumKeys(record)) {
      const entries = recordsByKey.get(key) ?? []
      entries.push(record)
      recordsByKey.set(key, entries)
    }
  }
  return Object.fromEntries([...recordsByKey.entries()]
    .filter(([, entries]) => entries.length >= minimumSamples)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, entries]) => {
      const localIssues = collectIssueCounts(entries)
      const local = applySupervisionBoosts(learnPairwiseWeights(entries, options), entries, localIssues)
      const shrinkage = entries.length / (entries.length + minimumSamples * 2)
      const blended = normalizeWeights(Object.fromEntries(PREFERENCE_FEATURES.map((name) => [
        name,
        globalWeights[name] * (1 - shrinkage) + local[name] * shrinkage,
      ])) as Record<PreferenceFeatureName, number>)
      return [key, { sampleCount: entries.length, weights: blended }]
    }))
}

function generationAdjustments(
  issueCounts: Readonly<Record<PreferenceIssue, number>>,
  sampleCount: number,
): PreferenceGenerationAdjustments {
  const scale = Math.max(1, sampleCount)
  const issueStrength = (issues: readonly PreferenceIssue[]): number =>
    issues.reduce((sum, issue) => sum + issueCounts[issue], 0) / scale
  return {
    featureProtection: clamp(1 + 0.18 * issueStrength(['facial-feature-loss', 'pattern-loss']), 0.75, 1.5),
    thinStructure: clamp(1 + 0.18 * issueStrength(['thin-structure-collapse', 'fragile-thin-structure']), 0.75, 1.5),
    boundaryAnchor: clamp(1 + 0.16 * issueStrength(['thin-structure-collapse', 'jagged-contour']), 0.75, 1.5),
    valueOrder: clamp(1 + 0.2 * issueStrength(['value-confusion']), 0.75, 1.5),
    refinement: clamp(1 + 0.14 * issueStrength(['jagged-contour', 'isolated-cell', 'color-stripe', 'texture-noise']), 0.75, 1.5),
    craftCost: clamp(1 + 0.18 * issueStrength(['craft-complexity', 'too-many-colors', 'fragile-thin-structure']), 0.75, 1.5),
  }
}

export function fitPreferenceModelV2(
  inputRecords: readonly PreferenceRecordV2[],
  options: PreferenceModelOptions = {},
): PreferenceModelV2 {
  const records = deduplicatePreferenceRecords(inputRecords)
  const issueCounts = collectIssueCounts(records)
  const learnedWeights = applySupervisionBoosts(learnPairwiseWeights(records, options), records, issueCounts)
  const minimumStratumSamples = options.minimumStratumSamples ?? 8
  if (Number.isInteger(minimumStratumSamples) === false || minimumStratumSamples <= 0) {
    throw new RangeError('Preference minimumStratumSamples must be a positive integer')
  }
  const strata = buildStrata(records, learnedWeights, minimumStratumSamples, options)
  const comparisonCount = records.reduce((sum, record) => sum + record.comparisons.length, 0)
  const uncertainty = 0.35 / Math.sqrt(Math.max(1, comparisonCount))
  const confidenceIntervals = Object.fromEntries(PREFERENCE_FEATURES.map((name) => [name, {
    lower: clamp(learnedWeights[name] - uncertainty, 0, 1),
    upper: clamp(learnedWeights[name] + uncertainty, 0, 1),
  }])) as Readonly<Record<PreferenceFeatureName, PreferenceConfidenceInterval>>
  const adjustments = generationAdjustments(issueCounts, records.length)
  const versionPayload = {
    sampleCount: records.length,
    comparisonCount,
    learnedWeights,
    issueCounts,
    adjustments,
    strata,
  }
  return {
    model: 'preference-linear-v2',
    version: stableVersion(versionPayload),
    baselineWeights: { ...BASELINE_PREFERENCE_WEIGHTS },
    learnedWeights,
    sampleCount: records.length,
    comparisonCount,
    issueCounts,
    confidenceIntervals,
    generationAdjustments: adjustments,
    strata,
  }
}

export function derivePreferenceGenerationParameters(
  model: PreferenceModelV2,
  baseline: PreferenceGenerationParameters = {
    importanceStrength: 1,
    edgeStrength: 1,
    edgeProtection: 1,
    isolatedPixelPenalty: 1,
    stripePenalty: 1,
    valueOrderStrength: 1,
    localSearchIterations: 3,
    maxColorsScale: 1,
  },
): PreferenceGenerationParameters {
  for (const [name, value] of Object.entries(baseline)) {
    if (Number.isFinite(value) === false || value <= 0) {
      throw new RangeError(`Preference generation parameter ${name} must be finite and positive`)
    }
  }
  const adjustments = model.generationAdjustments
  const learnedPriority = (
    name: PreferenceFeatureName,
    sensitivity = 0.5,
    minimum = 1,
  ): number => {
    const baselineWeight = Math.max(0.001, model.baselineWeights[name])
    const learnedWeight = Math.max(0.001, model.learnedWeights[name])
    return clamp(Math.pow(learnedWeight / baselineWeight, sensitivity), minimum, 1.5)
  }
  const featurePriority = learnedPriority('identityFeatures')
  const thinPriority = learnedPriority('thinStructure')
  const boundaryPriority = learnedPriority('boundaryAnchors')
  const valuePriority = learnedPriority('valueOrder')
  const refinementPriority = Math.sqrt(
    learnedPriority('pixelClusters') * learnedPriority('contourRhythm'),
  )
  const craftPriority = learnedPriority('craftEase', 0.35, 0.75)
  return {
    importanceStrength: clamp(
      baseline.importanceStrength * adjustments.featureProtection * featurePriority,
      0.25,
      2,
    ),
    edgeStrength: clamp(
      baseline.edgeStrength
        * (adjustments.thinStructure * thinPriority + adjustments.boundaryAnchor * boundaryPriority) / 2,
      0.25,
      2,
    ),
    edgeProtection: clamp(
      baseline.edgeProtection * adjustments.boundaryAnchor * boundaryPriority,
      0.25,
      4,
    ),
    isolatedPixelPenalty: clamp(
      baseline.isolatedPixelPenalty * adjustments.refinement * refinementPriority,
      0.25,
      4,
    ),
    stripePenalty: clamp(
      baseline.stripePenalty * adjustments.refinement * refinementPriority,
      0.25,
      4,
    ),
    valueOrderStrength: clamp(
      baseline.valueOrderStrength * adjustments.valueOrder * valuePriority,
      0.25,
      2,
    ),
    localSearchIterations: Math.round(clamp(
      baseline.localSearchIterations * adjustments.refinement * refinementPriority,
      1,
      12,
    )),
    maxColorsScale: clamp(
      baseline.maxColorsScale / (adjustments.craftCost * craftPriority),
      0.6,
      1.25,
    ),
  }
}

function resolveWeights(
  model: PreferenceModelV2,
  context: PreferenceModelContext,
): { weights: PreferenceFeatureVector; keys: readonly string[] } {
  const keys = stratumKeys(context).filter((key) => model.strata[key] !== undefined)
  if (keys.length === 0) return { weights: model.learnedWeights, keys }
  const totalSamples = keys.reduce((sum, key) => sum + model.strata[key]!.sampleCount, 0)
  return {
    weights: normalizeWeights(Object.fromEntries(PREFERENCE_FEATURES.map((name) => [
      name,
      keys.reduce((sum, key) => sum + model.strata[key]!.weights[name]
        * model.strata[key]!.sampleCount, 0) / totalSamples,
    ])) as Record<PreferenceFeatureName, number>),
    keys,
  }
}

function scoreCandidate(candidate: PreferenceCandidateV2, weights: PreferenceFeatureVector): number {
  return PREFERENCE_FEATURES.reduce((sum, name) => sum + candidate.features[name] * weights[name], 0)
}

export function rankPreferenceCandidates(
  candidates: readonly PreferenceCandidateV2[],
  model: PreferenceModelV2,
  context: PreferenceModelContext,
): PreferenceRankingResult {
  if (candidates.length === 0) throw new RangeError('Preference ranking requires candidates')
  const ids = candidates.map((candidate) => candidate.id)
  if (ids.some((id) => id.trim().length === 0) || new Set(ids).size !== ids.length) {
    throw new RangeError('Preference ranking candidate ids must be unique and non-empty')
  }
  const resolved = resolveWeights(model, context)
  const totals = Object.fromEntries(candidates.map((candidate) => [
    candidate.id,
    scoreCandidate(candidate, resolved.weights),
  ])) as Record<string, number>
  const maximum = Math.max(...Object.values(totals))
  const strengths = Object.fromEntries(Object.entries(totals).map(([id, total]) => [id, Math.exp((total - maximum) * 6)]))
  const strengthTotal = Object.values(strengths).reduce((sum, value) => sum + value, 0)
  const scores = Object.fromEntries(candidates.map((candidate) => [candidate.id, {
    total: totals[candidate.id]!,
    probabilityShare: strengths[candidate.id]! / strengthTotal,
    contributions: Object.fromEntries(PREFERENCE_FEATURES.map((name) => [
      name,
      candidate.features[name] * resolved.weights[name],
    ])) as unknown as PreferenceFeatureVector,
  }]))
  return {
    rankedCandidateIds: [...ids].sort((first, second) =>
      totals[second]! - totals[first]! || first.localeCompare(second)),
    scores,
    weights: resolved.weights,
    stratumKeys: resolved.keys,
  }
}

function pairKey(first: string, second: string): string {
  return first.localeCompare(second) < 0 ? `${first}\u0000${second}` : `${second}\u0000${first}`
}

export function selectActivePreferencePair(
  inputCandidates: readonly PreferenceCandidateV2[],
  model: PreferenceModelV2,
  options: ActivePreferencePairOptions,
): ActivePreferencePair {
  if (inputCandidates.length < 2) throw new RangeError('Active preference sampling requires at least two candidates')
  const candidates = [...inputCandidates].sort((first, second) => first.id.localeCompare(second.id))
  const ranking = rankPreferenceCandidates(candidates, model, options.context)
  const baseline = rankPreferenceCandidates(candidates, {
    ...model,
    learnedWeights: model.baselineWeights,
    strata: {},
  }, options.context)
  const repeatCounts = new Map((options.comparedPairs ?? []).map((entry) => [
    pairKey(entry.candidateAId, entry.candidateBId),
    entry.count,
  ]))
  const coverageValues = Object.values(options.issueCoverage ?? {})
  const coverageScarcity = coverageValues.length === 0
    ? 0.5
    : 1 - coverageValues.reduce((sum, value) => sum + clamp(value ?? 0, 0, 1), 0) / coverageValues.length
  let selected: ActivePreferencePair | undefined
  for (let firstIndex = 0; firstIndex < candidates.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < candidates.length; secondIndex += 1) {
      const first = candidates[firstIndex]!
      const second = candidates[secondIndex]!
      const learnedDifference = ranking.scores[first.id]!.total - ranking.scores[second.id]!.total
      const baselineDifference = baseline.scores[first.id]!.total - baseline.scores[second.id]!.total
      const probability = sigmoid(learnedDifference * 6)
      const uncertainty = 1 - Math.abs(probability - 0.5) * 2
      const modelDisagreement = clamp(Math.abs(learnedDifference - baselineDifference) * 5, 0, 1)
      const repeatCount = repeatCounts.get(pairKey(first.id, second.id)) ?? 0
      const repeatPenalty = clamp(repeatCount / 4, 0, 0.9)
      const priority = (0.62 * uncertainty + 0.25 * modelDisagreement + 0.13 * coverageScarcity)
        * (1 - repeatPenalty)
      const entry: ActivePreferencePair = {
        candidateAId: first.id,
        candidateBId: second.id,
        priority,
        uncertainty,
        modelDisagreement,
        coverageScarcity,
        repeatPenalty,
      }
      if (selected === undefined || entry.priority > selected.priority + 1e-12
        || (Math.abs(entry.priority - selected.priority) <= 1e-12
          && pairKey(entry.candidateAId, entry.candidateBId)
            < pairKey(selected.candidateAId, selected.candidateBId))) {
        selected = entry
      }
    }
  }
  return selected!
}

export function createFrozenPreferenceSplit(
  inputRecords: readonly PreferenceRecordV2[],
  options: FrozenPreferenceSplitOptions,
): FrozenPreferenceSplit {
  if (options.seed.trim().length === 0) throw new RangeError('Preference split seed must be non-empty')
  const train = options.trainRatio ?? 0.7
  const validation = options.validationRatio ?? 0.15
  const holdout = options.holdoutRatio ?? 0.15
  for (const [label, ratio] of [['train', train], ['validation', validation], ['holdout', holdout]] as const) {
    if (Number.isFinite(ratio) === false || ratio <= 0 || ratio >= 1) {
      throw new RangeError(`Preference split ${label} ratio must stay within 0..1`)
    }
  }
  if (Math.abs(train + validation + holdout - 1) > 1e-9) {
    throw new RangeError('Preference split ratios must sum to one')
  }
  const records = inputRecords.map(normalizePreferenceRecordV2)
    .sort((first, second) => first.id.localeCompare(second.id))
  const groupAssignments: Record<string, 'train' | 'validation' | 'holdout'> = {}
  const recordIds = { train: [] as string[], validation: [] as string[], holdout: [] as string[] }
  const recordsByGroup = new Map<string, string[]>()
  for (const record of records) {
    const group = record.source.groupId ?? record.source.id
    const ids = recordsByGroup.get(group) ?? []
    ids.push(record.id)
    recordsByGroup.set(group, ids)
  }
  const groups = [...recordsByGroup.keys()].sort((first, second) =>
    stableHash(`${options.seed}\u0000${first}`) - stableHash(`${options.seed}\u0000${second}`)
      || first.localeCompare(second))
  let validationGroups = groups.length >= 3 ? Math.max(1, Math.round(groups.length * validation)) : 0
  let holdoutGroups = groups.length >= 3 ? Math.max(1, Math.round(groups.length * holdout)) : 0
  while (groups.length - validationGroups - holdoutGroups < 1) {
    if (validationGroups >= holdoutGroups && validationGroups > 1) validationGroups -= 1
    else if (holdoutGroups > 1) holdoutGroups -= 1
    else break
  }
  const trainGroups = groups.length - validationGroups - holdoutGroups
  for (const [index, group] of groups.entries()) {
    const split = index < trainGroups ? 'train'
      : index < trainGroups + validationGroups ? 'validation' : 'holdout'
    groupAssignments[group] = split
    recordIds[split].push(...recordsByGroup.get(group)!)
  }
  for (const ids of Object.values(recordIds)) ids.sort()
  return {
    version: stableVersion({ seed: options.seed, train, validation, holdout, groupAssignments, recordIds }),
    seed: options.seed,
    ratios: { train, validation, holdout },
    recordIds,
    groupAssignments: Object.fromEntries(Object.entries(groupAssignments).sort(([first], [second]) => first.localeCompare(second))),
  }
}

function evaluateModel(model: PreferenceModelV2, inputRecords: readonly PreferenceRecordV2[]): PreferenceEvaluationMetrics {
  const records = inputRecords.map(normalizePreferenceRecordV2)
  let comparisons = 0
  let correct = 0
  let logLoss = 0
  let tieError = 0
  let tieCount = 0
  for (const record of records) {
    const contextCandidate = record.candidates[0]!
    const context: PreferenceModelContext = {
      subjectKind: record.source.subjectKind,
      grid: contextCandidate.grid,
      style: contextCandidate.style,
      paletteId: contextCandidate.paletteId,
    }
    const ranking = rankPreferenceCandidates(record.candidates, model, context)
    for (const comparison of record.comparisons) {
      const difference = ranking.scores[comparison.candidateAId]!.total
        - ranking.scores[comparison.candidateBId]!.total
      const probability = clamp(sigmoid(difference * 6), 1e-6, 1 - 1e-6)
      const target = comparison.choice === 'a' ? 1 : comparison.choice === 'b' ? 0 : 0.5
      const predicted = probability > 0.5 + 1e-9 ? 'a' : probability < 0.5 - 1e-9 ? 'b' : 'tie'
      if (predicted === comparison.choice) correct += 1
      logLoss += -(target * Math.log(probability) + (1 - target) * Math.log(1 - probability))
      if (comparison.choice === 'tie') {
        tieError += Math.abs(probability - 0.5)
        tieCount += 1
      }
      comparisons += 1
    }
  }
  return {
    comparisons,
    accuracy: comparisons === 0 ? 0 : correct / comparisons,
    logLoss: comparisons === 0 ? 0 : logLoss / comparisons,
    tieMeanAbsoluteError: tieCount === 0 ? 0 : tieError / tieCount,
  }
}

export function comparePreferenceModels(
  baseline: PreferenceModelV2,
  challenger: PreferenceModelV2,
  holdoutRecords: readonly PreferenceRecordV2[],
): PreferenceModelComparison {
  const baselineMetrics = evaluateModel(baseline, holdoutRecords)
  const challengerMetrics = evaluateModel(challenger, holdoutRecords)
  return {
    baselineVersion: baseline.version,
    challengerVersion: challenger.version,
    baseline: baselineMetrics,
    challenger: challengerMetrics,
    accuracyGain: challengerMetrics.accuracy - baselineMetrics.accuracy,
    logLossReduction: baselineMetrics.logLoss - challengerMetrics.logLoss,
  }
}

export function selectPreferenceModelVersion(
  baseline: PreferenceModelV2,
  challenger: PreferenceModelV2,
  comparison: PreferenceModelComparison,
  options: PreferenceModelSelectionOptions = {},
): PreferenceModelSelection {
  const minimumSamples = options.minimumTrainingSamples ?? 20
  const minimumAccuracyGain = options.minimumAccuracyGain ?? 0
  const maximumLogLossRegression = options.maximumLogLossRegression ?? 0.01
  if (challenger.sampleCount < minimumSamples) {
    return { selectedVersion: baseline.version, rolledBack: true, reason: 'insufficient-samples' }
  }
  if (comparison.accuracyGain < minimumAccuracyGain) {
    return { selectedVersion: baseline.version, rolledBack: true, reason: 'accuracy-regression' }
  }
  if (comparison.logLossReduction < -maximumLogLossRegression) {
    return { selectedVersion: baseline.version, rolledBack: true, reason: 'log-loss-regression' }
  }
  return { selectedVersion: challenger.version, rolledBack: false, reason: 'accepted' }
}
