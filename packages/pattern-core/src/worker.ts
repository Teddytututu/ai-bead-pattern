import type { PatternAlgorithm } from './algorithm.js'
import type { PatternAdaptationRequest, PatternAdaptationResult, PatternGenerationRequest, PatternGenerationResult } from './types.js'

export type PatternWorkerRequest =
  | { id: string; type: 'generate'; request: PatternGenerationRequest }
  | { id: string; type: 'adapt'; request: PatternAdaptationRequest }

export type PatternWorkerResponse =
  | { id: string; type: 'result'; result: PatternGenerationResult | PatternAdaptationResult }
  | { id: string; type: 'error'; error: { name: string; message: string } }

export interface PatternWorkerEndpoint {
  postMessage(message: PatternWorkerResponse): void
}

/** Message handler shared by browser Workers, Node worker_threads, and test harnesses. */
export function createPatternWorkerHandler(
  algorithm: PatternAlgorithm,
  endpoint: PatternWorkerEndpoint,
): (message: PatternWorkerRequest) => Promise<void> {
  return async (message) => {
    try {
      const result = message.type === 'generate'
        ? await algorithm.generate(message.request)
        : await algorithm.adapt(message.request)
      endpoint.postMessage({ id: message.id, type: 'result', result })
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error))
      endpoint.postMessage({
        id: message.id,
        type: 'error',
        error: { name: cause.name, message: cause.message },
      })
    }
  }
}
