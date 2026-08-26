export type PairwisePreferenceChoice = 'a' | 'b' | 'tie'

export interface PairwisePreferenceRecord {
  id?: string
  sourceId?: string
  raterId?: string
  candidateAId: string
  candidateBId: string
  choice: PairwisePreferenceChoice
  weight?: number
}

export interface BradleyTerryOptions {
  maximumIterations?: number
  tolerance?: number
  learningRate?: number
  regularization?: number
}

export interface CandidatePreferenceScore {
  utility: number
  share: number
  comparisonWeight: number
}

export interface BradleyTerryResult {
  model: 'bradley-terry-v1'
  rankedCandidateIds: readonly string[]
  scores: Readonly<Record<string, CandidatePreferenceScore>>
  comparisonCount: number
  iterations: number
  converged: boolean
}

const validChoices = new Set<PairwisePreferenceChoice>(['a', 'b', 'tie'])

function sigmoid(value: number): number {
  if (value >= 0) {
    const exp = Math.exp(-value)
    return 1 / (1 + exp)
  }
  const exp = Math.exp(value)
  return exp / (1 + exp)
}

function positiveOption(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (Number.isFinite(resolved) === false || resolved <= 0) {
    throw new RangeError(`${label} must be finite and positive`)
  }
  return resolved
}

function nonNegativeOption(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (Number.isFinite(resolved) === false || resolved < 0) {
    throw new RangeError(`${label} must be finite and non-negative`)
  }
  return resolved
}

function iterationOption(value: number | undefined): number {
  const resolved = value ?? 500
  if (Number.isInteger(resolved) === false || resolved <= 0 || resolved > 10_000) {
    throw new RangeError('maximumIterations must be an integer within 1..10000')
  }
  return resolved
}

function validateCandidates(candidateIds: readonly string[]): readonly string[] {
  if (candidateIds.length === 0) throw new RangeError('Bradley-Terry requires candidates')
  if (candidateIds.some((candidateId) => candidateId.trim().length === 0)) {
    throw new RangeError('Candidate ids must be non-empty')
  }
  const unique = new Set(candidateIds)
  if (unique.size !== candidateIds.length) throw new RangeError('Candidate ids must be unique')
  return [...unique].sort()
}

function validateComparisons(
  candidateIds: ReadonlySet<string>,
  comparisons: readonly PairwisePreferenceRecord[],
): readonly Required<Pick<PairwisePreferenceRecord,
  'candidateAId' | 'candidateBId' | 'choice' | 'weight'>>[] {
  const normalized = comparisons.map((comparison) => {
    if (candidateIds.has(comparison.candidateAId) === false
      || candidateIds.has(comparison.candidateBId) === false) {
      throw new RangeError('Preference comparison references an unknown candidate')
    }
    if (comparison.candidateAId === comparison.candidateBId) {
      throw new RangeError('Preference comparison requires distinct candidates')
    }
    if (validChoices.has(comparison.choice) === false) {
      throw new RangeError('Preference comparison choice has an unsupported value')
    }
    const weight = comparison.weight ?? 1
    if (Number.isFinite(weight) === false || weight <= 0) {
      throw new RangeError('Preference comparison requires a finite positive weight')
    }
    return {
      candidateAId: comparison.candidateAId,
      candidateBId: comparison.candidateBId,
      choice: comparison.choice,
      weight,
    }
  })
  return normalized.sort((first, second) =>
    first.candidateAId.localeCompare(second.candidateAId)
      || first.candidateBId.localeCompare(second.candidateBId)
      || first.choice.localeCompare(second.choice)
      || first.weight - second.weight)
}

function preferenceShare(utilities: readonly number[]): readonly number[] {
  const maximum = Math.max(...utilities)
  const strengths = utilities.map((utility) => Math.exp(utility - maximum))
  const total = strengths.reduce((sum, strength) => sum + strength, 0)
  return strengths.map((strength) => strength / total)
}

export function fitBradleyTerry(
  inputCandidateIds: readonly string[],
  inputComparisons: readonly PairwisePreferenceRecord[],
  options: BradleyTerryOptions = {},
): BradleyTerryResult {
  const candidateIds = validateCandidates(inputCandidateIds)
  const candidateIndex = new Map(candidateIds.map((candidateId, index) => [candidateId, index]))
  const comparisons = validateComparisons(new Set(candidateIds), inputComparisons)
  const maximumIterations = iterationOption(options.maximumIterations)
  const tolerance = positiveOption(options.tolerance, 1e-9, 'tolerance')
  const learningRate = positiveOption(options.learningRate, 0.8, 'learningRate')
  const regularization = nonNegativeOption(options.regularization, 0.25, 'regularization')
  const utilities = new Array(candidateIds.length).fill(0)
  const comparisonWeights = new Array(candidateIds.length).fill(0)
  for (const comparison of comparisons) {
    comparisonWeights[candidateIndex.get(comparison.candidateAId)!] += comparison.weight
    comparisonWeights[candidateIndex.get(comparison.candidateBId)!] += comparison.weight
  }
  let iterations = 0
  let converged = comparisons.length === 0
  for (let iteration = 0; iteration < maximumIterations && comparisons.length > 0; iteration += 1) {
    const gradients = utilities.map((utility) => -regularization * utility)
    for (const comparison of comparisons) {
      const first = candidateIndex.get(comparison.candidateAId)!
      const second = candidateIndex.get(comparison.candidateBId)!
      const target = comparison.choice === 'a' ? 1 : comparison.choice === 'b' ? 0 : 0.5
      const error = (target - sigmoid(utilities[first]! - utilities[second]!)) * comparison.weight
      gradients[first] = gradients[first]! + error
      gradients[second] = gradients[second]! - error
    }
    let maximumDelta = 0
    const next = utilities.map((utility, index) => {
      const delta = learningRate * gradients[index]!
        / Math.max(1, comparisonWeights[index]! + regularization)
      maximumDelta = Math.max(maximumDelta, Math.abs(delta))
      return utility + delta
    })
    const mean = next.reduce((sum, utility) => sum + utility, 0) / next.length
    for (let index = 0; index < utilities.length; index += 1) {
      utilities[index] = next[index]! - mean
    }
    iterations = iteration + 1
    if (maximumDelta <= tolerance) {
      converged = true
      break
    }
  }
  const shares = preferenceShare(utilities)
  const scores = Object.fromEntries(candidateIds.map((candidateId, index) => [
    candidateId,
    {
      utility: utilities[index]!,
      share: shares[index]!,
      comparisonWeight: comparisonWeights[index]!,
    },
  ]))
  const rankedCandidateIds = [...candidateIds].sort((first, second) =>
    scores[second]!.utility - scores[first]!.utility || first.localeCompare(second))
  return {
    model: 'bradley-terry-v1',
    rankedCandidateIds,
    scores,
    comparisonCount: comparisons.length,
    iterations,
    converged,
  }
}

export function predictPairwisePreference(
  result: BradleyTerryResult,
  candidateAId: string,
  candidateBId: string,
): number {
  const first = result.scores[candidateAId]
  const second = result.scores[candidateBId]
  if (first === undefined || second === undefined) {
    throw new RangeError('Pairwise prediction references an unknown candidate')
  }
  if (candidateAId === candidateBId) return 0.5
  return sigmoid(first.utility - second.utility)
}
