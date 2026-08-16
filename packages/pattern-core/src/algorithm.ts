import { DeterministicPatternAlgorithm } from './pipeline.js'
import type {
  PatternGenerationRequest,
  PatternGenerationResult,
  PatternAdaptationRequest,
  PatternAdaptationResult,
} from './types.js'

export interface PatternAlgorithm {
  readonly version: string
  generate(request: PatternGenerationRequest): Promise<PatternGenerationResult>
  adapt(request: PatternAdaptationRequest): Promise<PatternAdaptationResult>
}

export interface PatternAlgorithmConfig {
  version?: string
  clock?: () => number
}

export function createPatternAlgorithm(config: PatternAlgorithmConfig = {}): PatternAlgorithm {
  return new DeterministicPatternAlgorithm(config)
}
