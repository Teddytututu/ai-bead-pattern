import { DeterministicPatternAlgorithm } from './pipeline.js'
import type {
  AlgorithmEngine,
  PatternGenerationRequest,
  PatternGenerationResult,
  PatternAdaptationRequest,
  PatternAdaptationResult,
  PatternCandidate,
  CandidateEvaluationModelIdentity,
} from './types.js'

export interface PreferenceRankOverride {
  scores: Readonly<Record<string, number>>
  model: CandidateEvaluationModelIdentity
}

export interface PatternAlgorithm {
  readonly version: string
  readonly engine: AlgorithmEngine
  generate(request: PatternGenerationRequest): Promise<PatternGenerationResult>
  adapt(request: PatternAdaptationRequest): Promise<PatternAdaptationResult>
}

export interface PatternAlgorithmConfig {
  version?: string
  clock?: () => number
  /** Optional learned ranker applied after deterministic validity ordering. */
  preferenceRanker?: (candidates: readonly PatternCandidate[]) => PreferenceRankOverride | undefined
}

export function createPatternAlgorithm(config: PatternAlgorithmConfig = {}): PatternAlgorithm {
  return new DeterministicPatternAlgorithm(config)
}
