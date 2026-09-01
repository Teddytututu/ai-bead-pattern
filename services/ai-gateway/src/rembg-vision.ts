import {
  RembgHttpSegmentationProvider,
  type SegmentationProvider,
} from './segmentation.js'
import { modelManifest } from './model-catalog.js'
import {
  type AIModelProvider,
  type ModelProviderRequest,
  type ModelProviderResult,
  type ProviderHealth,
  type ProviderHealthStatus,
  validateProviderRequest,
  validateProviderResult,
} from './provider-contract.js'

export interface RembgVisionProbeResult {
  status: ProviderHealthStatus
  latencyMs: number
  message?: string
}

export interface RembgVisionProviderOptions {
  segmentation?: SegmentationProvider
  probe?: (signal?: AbortSignal) => Promise<RembgVisionProbeResult>
}

export class RembgVisionProvider implements AIModelProvider {
  readonly manifest = modelManifest('rembg-birefnet-general-lite')
  readonly #segmentation: SegmentationProvider
  readonly #probe?: RembgVisionProviderOptions['probe']

  constructor(options: RembgVisionProviderOptions = {}) {
    this.#segmentation = options.segmentation ?? new RembgHttpSegmentationProvider({
      defaultModel: 'birefnet-general-lite',
    })
    this.#probe = options.probe
  }

  async analyze(request: ModelProviderRequest): Promise<ModelProviderResult> {
    validateProviderRequest(request, this.manifest)
    const result = await this.#segmentation.segment({
      image: request.image,
      model: 'birefnet-general-lite',
      ...(request.imageTypeHint === undefined ? {} : { imageTypeHint: request.imageTypeHint }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    })
    if (result.model !== 'birefnet-general-lite') {
      throw new RangeError('rembg returned a model that differs from the pinned manifest')
    }
    const providerResult: ModelProviderResult = {
      providerId: this.manifest.providerId,
      model: this.manifest,
      capabilities: request.capabilities,
      confidence: result.analysis.confidence ?? 0,
      elapsedMs: result.elapsedMs,
      analysis: result.analysis,
    }
    validateProviderResult(providerResult, this, request.capabilities, request.image)
    return providerResult
  }

  async probe(signal?: AbortSignal): Promise<ProviderHealth> {
    const startedAt = performance.now()
    try {
      const callback = this.#probe ?? this.#segmentation.probe?.bind(this.#segmentation)
      if (callback === undefined) {
        return {
          status: 'unavailable',
          checkedAt: Date.now(),
          latencyMs: Math.max(0, performance.now() - startedAt),
          model: this.manifest,
          message: 'Segmentation provider has no health probe',
        }
      }
      const result = await callback(signal)
      return {
        status: result.status,
        checkedAt: Date.now(),
        latencyMs: result.latencyMs,
        model: this.manifest,
        ...(result.message === undefined ? {} : { message: result.message.slice(0, 500) }),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        status: 'unavailable',
        checkedAt: Date.now(),
        latencyMs: Math.max(0, performance.now() - startedAt),
        model: this.manifest,
        message: message.replace(/\s+/g, ' ').trim().slice(0, 500),
      }
    }
  }
}
