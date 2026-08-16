import { DeterministicPatternAlgorithm } from './pipeline.js'
import type {
  AlgorithmEngine,
  PatternGenerationRequest,
  PatternGenerationResult,
  PatternAdaptationRequest,
  PatternAdaptationResult,
} from './types.js'

export interface PatternAlgorithm {
  readonly version: string
  readonly engine: AlgorithmEngine
  generate(request: PatternGenerationRequest): Promise<PatternGenerationResult>
  adapt(request: PatternAdaptationRequest): Promise<PatternAdaptationResult>
}

export interface PatternAlgorithmConfig {
  version?: string
  clock?: () => number
  engine?: AlgorithmEngine
}

export function createPatternAlgorithm(config: PatternAlgorithmConfig = {}): PatternAlgorithm {
  return new DeterministicPatternAlgorithm(config)
}
