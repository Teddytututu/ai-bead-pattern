import type {
  PatternGenerationRequest,
  PatternGenerationResult,
} from './types'

/** Stable boundary between product code and the replaceable algorithm implementation. */
export interface PatternAlgorithm {
  readonly version: string

  generate(request: PatternGenerationRequest): Promise<PatternGenerationResult>
}
