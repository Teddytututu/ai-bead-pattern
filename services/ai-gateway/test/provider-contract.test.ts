import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ImageAnalysis, PixelImage } from '@ai-bead-pattern/pattern-core'

import {
  AIProviderRegistry,
  CompositeImageAnalyzer,
  HttpVisionProvider,
  MODEL_CATALOG,
  RembgVisionProvider,
  validateLearnedProposal,
  validateModelManifest,
  type AIModelProvider,
  type ModelProviderRequest,
  type ModelProviderResult,
} from '../src/index.js'

function image(width = 2, height = 2): PixelImage {
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4).fill(255),
  }
}

const localManifest = {
  providerId: 'test-local',
  modelId: 'test/model',
  modelVersion: '1.2.3',
  sourceRevision: '0123456789abcdef0123456789abcdef01234567',
  weightSource: 'https://models.example.test/test-model.onnx',
  weightRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  license: {
    spdx: 'Apache-2.0',
    name: 'Apache License 2.0',
    url: 'https://www.apache.org/licenses/LICENSE-2.0',
  },
  documentationUrl: 'https://docs.example.test/test-model',
  capabilities: ['embedding', 'material'] as const,
  input: {
    minimumWidth: 1,
    minimumHeight: 1,
    maximumWidth: 1024,
    maximumHeight: 1024,
    preferredWidth: 224,
    preferredHeight: 224,
    colorSpace: 'srgb' as const,
  },
  execution: {
    location: 'local' as const,
    devices: ['cpu'] as const,
    estimatedMemoryMiB: 500,
    estimatedLatencyMs: { p50: 50, p95: 200 },
    measurement: 'local' as const,
  },
  privacy: {
    imageLeavesDevice: false,
    retention: 'none' as const,
  },
  failurePolicy: {
    timeoutMs: 1_000,
    maximumResponseBytes: 1_000_000,
    retryCount: 0,
    fallback: 'deterministic-baseline' as const,
  },
} as const

describe('model manifest and catalog', () => {
  it('keeps every registered model pinned to a source and weight revision with a declared license', () => {
    assert.ok(MODEL_CATALOG.length >= 8)
    for (const manifest of MODEL_CATALOG) {
      assert.doesNotThrow(() => validateModelManifest(manifest))
      assert.match(manifest.sourceRevision, /^[a-f0-9]{40}$/)
      assert.ok(manifest.weightRevision.length > 8)
      assert.ok(manifest.license.spdx.length > 0)
      assert.ok(manifest.documentationUrl.startsWith('https://'))
    }
  })

  it('rejects mutable identities, unclear licenses, and impossible limits', () => {
    assert.throws(() => validateModelManifest({
      ...localManifest,
      sourceRevision: 'main',
    }), /source revision/)
    assert.throws(() => validateModelManifest({
      ...localManifest,
      license: { ...localManifest.license, spdx: 'NOASSERTION' },
    }), /license/)
    assert.throws(() => validateModelManifest({
      ...localManifest,
      input: { ...localManifest.input, maximumWidth: 0 },
    }), /input/)
  })
})

describe('learned proposal contract', () => {
  const proposal = {
    id: 'proposal-1',
    kind: 'learned-pixelization' as const,
    image: image(),
    confidence: 0.8,
    modelId: 'test/pixelizer',
    targetGrid: { width: 32, height: 48 },
  }

  it('accepts a replayable proposal with a positive target grid', () => {
    assert.doesNotThrow(() => validateLearnedProposal(proposal))
  })

  it('rejects invalid routes, grids, and RGBA values before composition', () => {
    assert.throws(() => validateLearnedProposal({
      ...proposal,
      kind: 'unknown-route' as never,
    }), /kind/)
    assert.throws(() => validateLearnedProposal({
      ...proposal,
      targetGrid: { width: 0, height: 48 },
    }), /target grid/)
    assert.throws(() => validateLearnedProposal({
      ...proposal,
      image: { ...proposal.image, data: new Uint8Array(proposal.image.data) as never },
    }), /RGBA/)
  })
})

describe('provider registry and composite analyzer', () => {
  it('selects real providers by capability and fuses structured outputs', async () => {
    const embeddingProvider: AIModelProvider = {
      manifest: localManifest,
      async analyze(): Promise<ModelProviderResult> {
        return {
          providerId: localManifest.providerId,
          model: localManifest,
          capabilities: ['embedding', 'material'],
          confidence: 0.8,
          elapsedMs: 12,
          analysis: { imageType: 'general', confidence: 0.8 },
          preferenceFeatures: {
            modelId: localManifest.modelId,
            names: ['identity-similarity', 'material-metal'],
            values: new Float32Array([0.75, 0.2]),
            confidence: 0.8,
          },
        }
      },
      async probe() {
        return { status: 'ready', checkedAt: 1, latencyMs: 2, model: localManifest }
      },
    }
    const segmentationManifest = {
      ...localManifest,
      providerId: 'test-segmentation',
      modelId: 'test/segmentation',
      capabilities: ['subject-segmentation'] as const,
    }
    const segmentationProvider: AIModelProvider = {
      manifest: segmentationManifest,
      async analyze(): Promise<ModelProviderResult> {
        const analysis: ImageAnalysis = { imageType: 'portrait', confidence: 0.9 }
        return {
          providerId: segmentationManifest.providerId,
          model: segmentationManifest,
          capabilities: ['subject-segmentation'],
          confidence: 0.9,
          elapsedMs: 5,
          analysis,
        }
      },
      async probe() {
        return { status: 'ready', checkedAt: 1, latencyMs: 1, model: segmentationManifest }
      },
    }
    const registry = new AIProviderRegistry()
    registry.register(segmentationProvider, 20)
    registry.register(embeddingProvider, 10)

    const result = await new CompositeImageAnalyzer(registry).analyze({
      image: image(),
      capabilities: ['subject-segmentation', 'embedding', 'material'],
      route: 'neural-analysis',
    })

    assert.equal(result.analysis.imageType, 'portrait')
    assert.equal(result.preferenceFeatures.length, 1)
    assert.deepEqual(result.contributions.map((entry) => entry.providerId), [
      'test-segmentation',
      'test-local',
    ])
    assert.equal(result.uncoveredCapabilities.length, 0)
  })

  it('keeps the deterministic route free from provider calls', async () => {
    let calls = 0
    const provider: AIModelProvider = {
      manifest: localManifest,
      async analyze(): Promise<ModelProviderResult> {
        calls += 1
        throw new Error('unexpected')
      },
      async probe() {
        return { status: 'ready', checkedAt: 1, latencyMs: 1, model: localManifest }
      },
    }
    const registry = new AIProviderRegistry()
    registry.register(provider)

    const result = await new CompositeImageAnalyzer(registry).analyze({
      image: image(),
      capabilities: [],
      route: 'deterministic',
    })

    assert.equal(calls, 0)
    assert.deepEqual(result.analysis, {})
    assert.equal(result.route, 'deterministic')
  })

  it('records optional failures and rejects required provider failures', async () => {
    const provider: AIModelProvider = {
      manifest: localManifest,
      async analyze(): Promise<ModelProviderResult> {
        throw new Error('runtime unavailable')
      },
      async probe() {
        return { status: 'unavailable', checkedAt: 1, latencyMs: 1, model: localManifest }
      },
    }
    const registry = new AIProviderRegistry()
    registry.register(provider)
    const analyzer = new CompositeImageAnalyzer(registry)

    const bestEffort = await analyzer.analyze({
      image: image(),
      capabilities: ['embedding'],
      route: 'neural-analysis',
      failureMode: 'best-effort',
    })
    assert.equal(bestEffort.contributions[0]?.status, 'failed')
    assert.match(bestEffort.contributions[0]?.message ?? '', /runtime unavailable/)

    await assert.rejects(() => analyzer.analyze({
      image: image(),
      capabilities: ['embedding'],
      route: 'neural-analysis',
      failureMode: 'strict',
    }), /runtime unavailable/)
  })

  it('propagates caller cancellation through best-effort analysis', async () => {
    const provider: AIModelProvider = {
      manifest: localManifest,
      async analyze(request): Promise<ModelProviderResult> {
        return new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true })
        })
      },
      async probe() {
        return { status: 'ready', checkedAt: 1, latencyMs: 1, model: localManifest }
      },
    }
    const registry = new AIProviderRegistry()
    registry.register(provider)
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('caller cancelled analysis')), 5)

    await assert.rejects(() => new CompositeImageAnalyzer(registry).analyze({
      image: image(),
      capabilities: ['embedding'],
      route: 'neural-analysis',
      failureMode: 'best-effort',
      signal: controller.signal,
    }), /caller cancelled analysis/)
  })

  it('rejects malformed structured output from an in-process provider', async () => {
    const provider: AIModelProvider = {
      manifest: localManifest,
      async analyze(): Promise<ModelProviderResult> {
        return {
          providerId: localManifest.providerId,
          model: localManifest,
          capabilities: ['embedding'],
          confidence: 0.5,
          elapsedMs: 1,
          analysis: { confidence: 2 },
        }
      },
      async probe() {
        return { status: 'ready', checkedAt: 1, latencyMs: 1, model: localManifest }
      },
    }
    const registry = new AIProviderRegistry()
    registry.register(provider)

    const result = await new CompositeImageAnalyzer(registry).analyze({
      image: image(),
      capabilities: ['embedding'],
      route: 'neural-analysis',
      failureMode: 'best-effort',
    })

    assert.equal(result.contributions[0]?.status, 'failed')
    assert.match(result.contributions[0]?.message ?? '', /confidence/)
  })
})

describe('generic HTTP vision provider', () => {
  it('posts a bounded image request and hydrates typed provider outputs', async () => {
    const fetch: typeof globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'http://127.0.0.1:7100/v1/analyze')
      assert.equal(init?.method, 'POST')
      assert.ok(init?.body instanceof FormData)
      const form = init.body
      assert.ok(form.get('image') instanceof Blob)
      const request = JSON.parse(String(form.get('request'))) as { capabilities: string[] }
      assert.deepEqual(request.capabilities, ['embedding', 'material'])
      return Response.json({
        schemaVersion: 'ai-gateway-provider-v1',
        providerId: localManifest.providerId,
        model: {
          modelId: localManifest.modelId,
          modelVersion: localManifest.modelVersion,
          sourceRevision: localManifest.sourceRevision,
          weightRevision: localManifest.weightRevision,
        },
        capabilities: ['embedding', 'material'],
        confidence: 0.7,
        analysis: { imageType: 'general', confidence: 0.7 },
        preferenceFeatures: {
          names: ['identity-similarity'],
          values: [0.6],
          confidence: 0.7,
        },
      })
    }
    const provider = new HttpVisionProvider({
      manifest: localManifest,
      endpoint: 'http://127.0.0.1:7100',
      fetch,
    })

    const result = await provider.analyze({
      image: image(),
      capabilities: ['embedding', 'material'],
    })

    assert.ok(result.preferenceFeatures?.values instanceof Float32Array)
    assert.equal(result.preferenceFeatures?.values[0], Math.fround(0.6))
    assert.equal(result.model.weightRevision, localManifest.weightRevision)
  })

  it('rejects unsupported capabilities and oversized images before HTTP', async () => {
    const provider = new HttpVisionProvider({
      manifest: localManifest,
      endpoint: 'http://127.0.0.1:7100',
      fetch: async () => assert.fail('invalid input must stop before HTTP'),
    })

    await assert.rejects(() => provider.analyze({
      image: image(),
      capabilities: ['depth'],
    }), /capability/)
    await assert.rejects(() => provider.analyze({
      image: image(1025, 1),
      capabilities: ['embedding'],
    }), /input limit/)
    await assert.rejects(() => provider.analyze({
      image: image(),
      capabilities: ['embedding'],
      timeoutMs: localManifest.failurePolicy.timeoutMs + 1,
    }), /timeout.*manifest/i)
    assert.throws(() => new HttpVisionProvider({
      manifest: localManifest,
      endpoint: 'http://127.0.0.1:7100',
      timeoutMs: localManifest.failurePolicy.timeoutMs + 1,
    }), /timeout.*manifest/i)
  })

  it('enforces timeout, caller cancellation, response size, and pinned identity', async () => {
    const stalledFetch: typeof globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
    const timed = new HttpVisionProvider({
      manifest: localManifest,
      endpoint: 'http://127.0.0.1:7100',
      fetch: stalledFetch,
      timeoutMs: 5,
    })
    await assert.rejects(() => timed.analyze({
      image: image(),
      capabilities: ['embedding'],
    }), /timed out/)

    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))
    await assert.rejects(() => timed.analyze({
      image: image(),
      capabilities: ['embedding'],
      signal: controller.signal,
    }), /caller cancelled/)

    const oversized = new HttpVisionProvider({
      manifest: localManifest,
      endpoint: 'http://127.0.0.1:7100',
      maximumResponseBytes: 64,
      fetch: async () => Response.json({ payload: 'x'.repeat(128) }),
    })
    await assert.rejects(() => oversized.analyze({
      image: image(),
      capabilities: ['embedding'],
    }), /response limit/)

    const drifted = new HttpVisionProvider({
      manifest: localManifest,
      endpoint: 'http://127.0.0.1:7100',
      fetch: async () => Response.json({
        schemaVersion: 'ai-gateway-provider-v1',
        providerId: localManifest.providerId,
        model: {
          modelId: localManifest.modelId,
          modelVersion: 'future',
          sourceRevision: localManifest.sourceRevision,
          weightRevision: localManifest.weightRevision,
        },
        capabilities: ['embedding'],
        confidence: 0.5,
      }),
    })
    await assert.rejects(() => drifted.analyze({
      image: image(),
      capabilities: ['embedding'],
    }), /identity/)
  })

  it('probes the configured runtime and verifies the pinned model identity', async () => {
    const provider = new HttpVisionProvider({
      manifest: localManifest,
      endpoint: 'http://127.0.0.1:7100',
      fetch: async (input) => {
        assert.equal(String(input), 'http://127.0.0.1:7100/health')
        return Response.json({
          status: 'ready',
          model: {
            modelId: localManifest.modelId,
            modelVersion: localManifest.modelVersion,
            sourceRevision: localManifest.sourceRevision,
            weightRevision: localManifest.weightRevision,
          },
        })
      },
    })

    const health = await provider.probe()

    assert.equal(health.status, 'ready')
    assert.equal(health.model.license.spdx, 'Apache-2.0')
  })
})

describe('rembg unified provider adapter', () => {
  it('exposes the existing BiRefNet sidecar through the shared provider contract', async () => {
    const analysis: ImageAnalysis = {
      confidence: 0.9,
      modelVersions: { segmentation: 'rembg/birefnet-general-lite' },
    }
    const provider = new RembgVisionProvider({
      segmentation: {
        async segment() {
          return {
            provider: 'rembg-http',
            model: 'birefnet-general-lite',
            analysis,
            elapsedMs: 8,
          }
        },
      },
      probe: async () => ({ status: 'ready', latencyMs: 2 }),
    })

    const result = await provider.analyze({
      image: image(),
      capabilities: ['subject-segmentation', 'edge-thin-structure'],
    } satisfies ModelProviderRequest)

    assert.equal(result.analysis, analysis)
    assert.equal(result.model.license.spdx, 'MIT')
    assert.deepEqual(result.capabilities, ['subject-segmentation', 'edge-thin-structure'])
    assert.equal((await provider.probe()).status, 'ready')
  })
})
