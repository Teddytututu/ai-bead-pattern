import {
  AIProviderRegistry,
  modelManifest,
} from '../services/ai-gateway/dist/index.js'

import { createDemoAiService } from './demo-ai-api.mjs'

export function createDemoAiE2EService() {
  const manifest = modelManifest('rembg-birefnet-general-lite')
  const registry = new AIProviderRegistry()
  registry.register({
    manifest,
    async probe() {
      return { status: 'ready', checkedAt: Date.now(), latencyMs: 1, model: manifest }
    },
    async analyze(request) {
      const length = request.image.width * request.image.height
      const values = Float32Array.from({ length }, (_, index) => {
        const x = index % request.image.width
        const y = Math.floor(index / request.image.width)
        const marginX = Math.max(1, Math.floor(request.image.width * 0.08))
        const marginY = Math.max(1, Math.floor(request.image.height * 0.08))
        return x >= marginX && x < request.image.width - marginX
          && y >= marginY && y < request.image.height - marginY
          ? 1
          : 0
      })
      const mask = { width: request.image.width, height: request.image.height, values }
      return {
        providerId: manifest.providerId,
        model: manifest,
        capabilities: request.capabilities,
        confidence: 0.9,
        elapsedMs: 1,
        analysis: {
          subjectMask: mask,
          subjectMaskEvidence: {
            mask,
            confidence: 0.9,
            source: 'ai',
            revision: 'e2e:subject-mask:v1',
          },
          importanceMap: {
            width: request.image.width,
            height: request.image.height,
            weights: Float32Array.from(values, (value) => value * 0.8),
          },
          confidence: 0.9,
          modelVersions: { segmentation: manifest.modelId },
        },
      }
    },
  }, 100)
  return createDemoAiService({ registry })
}
