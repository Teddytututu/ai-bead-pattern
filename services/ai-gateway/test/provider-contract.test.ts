import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ImageAnalysis, PixelImage } from '@ai-bead-pattern/pattern-core'

import {
  createContainSourceFrame,
  projectSourceAnalysisToProposal,
} from '../src/provider-contract.js'

import {
  AIProviderRegistry,
  CompositeImageAnalyzer,
  HttpVisionProvider,
  MODEL_CATALOG,
  RembgVisionProvider,
  validateLearnedProposal,
  validateInstancePrompt,
  validateModelManifest,
  validatePreferenceFeatures,
  validateProviderRequest,
  validateProviderResult,
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

  it('ships a pinned local pixel proposal stack for both proposal routes', () => {
    const proposal = MODEL_CATALOG.find((entry) => entry.providerId === 'pixel-art-sprite-lcm-local')

    assert.ok(proposal)
    assert.deepEqual(proposal.capabilities, ['learned-pixelization', 'generative-proposal'])
    assert.equal(proposal.execution.location, 'local')
    assert.ok(proposal.execution.devices.includes('cuda'))
    assert.match(proposal.weightRevision, /8229c9b6e928103f0e657cfe6b14d902cb2101d6/)
    assert.match(proposal.weightRevision, /cf2fced511dbe7e26c8d1d397e728fbab875db4b/)
  })

  it('pins the OpenCLIP pair scorer to reviewed source, weights, and licenses', () => {
    const scorer = MODEL_CATALOG.find((entry) => entry.providerId === 'openclip-vit-b32-pair-local')

    assert.ok(scorer)
    assert.equal(scorer.modelId, 'mlfoundations/open_clip/ViT-B-32/laion2b_s34b_b79k')
    assert.equal(scorer.modelVersion, 'open_clip_torch-3.3.0')
    assert.equal(scorer.sourceRevision, '30573618fc375b12f094ef64cb3a1391cf611c45')
    assert.equal(scorer.weightRevision, 'hf:1a25a446712ba5ee05982a381eed697ef9b435cf')
    assert.deepEqual(scorer.capabilities, ['embedding', 'preference-scoring'])
    assert.equal(scorer.license.spdx, 'MIT')
    assert.equal(scorer.weightLicense?.spdx, 'MIT')
  })

  it('pins SAM 2.1 and MMPose to matching released code and weights', () => {
    const sam = MODEL_CATALOG.find((entry) => entry.providerId === 'sam2-local')
    const groundedSam = MODEL_CATALOG.find((entry) => entry.providerId === 'grounded-sam2-local')
    const animalPose = MODEL_CATALOG.find((entry) => entry.providerId === 'mmpose-animal-local')

    assert.ok(sam)
    assert.equal(sam.modelVersion, 'transformers-5.16.1+sam2.1')
    assert.equal(sam.sourceRevision, '93c8b7b485963a10800c91f55304db6be211c2bd')
    assert.equal(sam.modelId, 'facebook/sam2.1-hiera-small')
    assert.match(sam.weightSource, /sam2\.1-hiera-small\/tree\/ee5bba1d82bb8749febdf90f45e84b687142ba03$/)
    assert.equal(sam.weightRevision, 'hf:ee5bba1d82bb8749febdf90f45e84b687142ba03')
    assert.equal(sam.weightLicense?.spdx, 'Apache-2.0')
    assert.ok(sam.execution.devices.includes('cpu'))
    assert.ok(groundedSam)
    assert.equal(groundedSam.sourceRevision, 'dd4c5141b75e4838dd486c64f773c43b4db3a07b')
    assert.match(groundedSam.modelId, /grounding-dino-tiny.*sam2\.1-hiera-small/)
    assert.match(groundedSam.weightRevision, /a2bb814dd30d776dcf7e30523b00659f4f141c71/)
    assert.match(groundedSam.weightRevision, /ee5bba1d82bb8749febdf90f45e84b687142ba03/)
    assert.equal(groundedSam.license.spdx, 'Apache-2.0')
    assert.ok(animalPose)
    assert.equal(animalPose.modelVersion, 'mmpose-v1.3.2+onnx-sdk-20230831')
    assert.equal(animalPose.sourceRevision, '5408bc76f5b848cf925a0d1857899011d8c5b497')
    assert.equal(animalPose.weightRevision, 'sha256:1cfd1c86e0d9e5d5f95178bcd95ee9a4e8386a624cd3c57519f27ff58cac7f28')
    assert.match(animalPose.documentationUrl, /tree\/5408bc76/)
    assert.equal(animalPose.privacy.imageLeavesDevice, false)
  })
})

describe('paired preference feature contract', () => {
  it('validates the reference image and requires a candidate identity', () => {
    assert.throws(() => validateProviderRequest({
      image: image(),
      referenceImage: image(),
      capabilities: ['embedding'],
    }, localManifest), /candidate/i)

    assert.throws(() => validateProviderRequest({
      image: image(),
      referenceImage: image(1025, 1),
      candidateId: 'candidate-a',
      capabilities: ['embedding'],
    }, localManifest), /reference image.*input limit/i)

    assert.throws(() => validateProviderRequest({
      image: image(),
      candidateId: '   ',
      capabilities: ['embedding'],
    }, localManifest), /candidate/i)
  })

  it('requires pair and candidate feature scopes to bind a candidate', () => {
    const features = {
      modelId: localManifest.modelId,
      names: ['identity-similarity'],
      values: new Float32Array([0.8]),
      confidence: 0.9,
    }

    assert.throws(() => validatePreferenceFeatures({
      ...features,
      scope: 'pair',
    }), /candidate/i)
    assert.throws(() => validatePreferenceFeatures({
      ...features,
      scope: 'candidate',
    }), /candidate/i)
    assert.throws(() => validatePreferenceFeatures({
      ...features,
      scope: 'source',
      candidateId: 'candidate-a',
    }), /scope/i)
    assert.doesNotThrow(() => validatePreferenceFeatures({
      ...features,
      scope: 'pair',
      candidateId: 'candidate-a',
    }))
  })
})

describe('instance prompt contract', () => {
  it('accepts a normalized coarse lasso with positive and negative guidance', () => {
    assert.doesNotThrow(() => validateInstancePrompt({
      lasso: [
        { x: 0.1, y: 0.1 },
        { x: 0.8, y: 0.1 },
        { x: 0.8, y: 0.9 },
        { x: 0.1, y: 0.9 },
      ],
      positivePoints: [{ x: 0.5, y: 0.45 }],
      negativePoints: [{ x: 0.95, y: 0.5 }],
      labels: ['cat'],
    }))
  })

  it('rejects empty, degenerate, and out-of-bounds instance guidance', () => {
    assert.throws(() => validateInstancePrompt({}), /guidance/i)
    assert.throws(() => validateInstancePrompt({
      lasso: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }],
    }), /lasso/i)
    assert.throws(() => validateInstancePrompt({
      positivePoints: [{ x: 1.1, y: 0.5 }],
    }), /positivePoints/i)
    assert.throws(() => validateInstancePrompt({
      selectedInstanceId: '   ',
    }), /selected instance/i)
  })

  it('requires unique boxed identities for a batched provider request', () => {
    const manifest = { ...localManifest, capabilities: ['keypoints'] as const }
    const prompt = {
      box: { x: 0, y: 0, width: 0.5, height: 1 },
      selectedInstanceId: 'pet-01',
    }
    assert.throws(() => validateProviderRequest({
      image: image(),
      capabilities: ['keypoints'],
      instancePrompt: prompt,
      instancePrompts: [prompt],
    }, manifest), /singular or batched/i)
    assert.throws(() => validateProviderRequest({
      image: image(),
      capabilities: ['keypoints'],
      instancePrompts: [prompt, prompt],
    }, manifest), /ids must be unique/i)
  })
})

describe('multi-instance result contract', () => {
  const manifest = {
    ...localManifest,
    providerId: 'test-multi-instance',
    modelId: 'test/multi-instance',
    capabilities: ['subject-segmentation'] as const,
  }
  const provider: AIModelProvider = {
    manifest,
    async analyze() { throw new Error('unused') },
    async probe() { return { status: 'ready', checkedAt: 1, latencyMs: 1, model: manifest } },
  }
  const proposal = (id: string, instanceId: string, x: number) => ({
    id,
    instanceId,
    label: 'cat',
    bbox: { x, y: 0, width: 0.5, height: 1 },
    maskRle: { size: [2, 4] as const, counts: [0, 8] },
    confidence: 0.9,
    detectionScore: 0.88,
    predictedIoU: 0.92,
    stabilityScore: 0.95,
    promptAgreement: 1,
    selected: true,
    diagnostics: {
      promptSource: 'text+box',
      positivePointCount: 0,
      negativePointCount: 0,
      maskAreaRatio: 1,
      lassoContainment: 0.5,
      inferenceMs: 4,
      device: 'cpu',
    },
  })
  const request: ModelProviderRequest = {
    image: image(4, 2),
    capabilities: ['subject-segmentation'],
    instancePrompts: [
      { box: { x: 0, y: 0, width: 0.5, height: 1 }, selectedInstanceId: 'pet-01' },
      { box: { x: 0.5, y: 0, width: 0.5, height: 1 }, selectedInstanceId: 'pet-02' },
    ],
  }
  const result = (proposals: readonly ReturnType<typeof proposal>[]): ModelProviderResult => ({
    providerId: manifest.providerId,
    model: manifest,
    capabilities: ['subject-segmentation'],
    confidence: 0.9,
    elapsedMs: 5,
    instanceProposals: proposals,
  })

  it('accepts one selected proposal per requested pet instance', () => {
    assert.doesNotThrow(() => validateProviderResult(
      result([proposal('mask-1', 'pet-01', 0), proposal('mask-2', 'pet-02', 0.5)]),
      provider,
      ['subject-segmentation'],
      request.image,
      request,
    ))
  })

  it('rejects two selected proposals for one instance', () => {
    assert.throws(() => validateProviderResult(
      result([proposal('mask-1', 'pet-01', 0), proposal('mask-2', 'pet-01', 0.5)]),
      provider,
      ['subject-segmentation'],
      request.image,
      request,
    ), /one proposal per instance/i)
  })

  it('rejects a result that omits one requested instance', () => {
    assert.throws(() => validateProviderResult(
      result([proposal('mask-1', 'pet-01', 0)]),
      provider,
      ['subject-segmentation'],
      request.image,
      request,
    ), /omits a requested/i)
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
    sourceFrame: createContainSourceFrame(
      { width: 4, height: 2 },
      { width: 2, height: 2 },
    ),
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

  it('requires a centered contain mapping tied to the source dimensions', () => {
    assert.throws(() => validateLearnedProposal({
      ...proposal,
      sourceFrame: undefined as never,
    }), /source frame/i)
    assert.throws(() => validateLearnedProposal({
      ...proposal,
      sourceFrame: { ...proposal.sourceFrame, y: 0.1, height: 1.8 },
    }), /contain/i)
    assert.throws(() => validateLearnedProposal(
      proposal,
      image(3, 2),
    ), /source dimensions/i)
  })

  it('projects source identity evidence through the proposal contain frame', () => {
    const sourceFrame = createContainSourceFrame(
      { width: 4, height: 2 },
      { width: 4, height: 4 },
    )
    const sourceValues = new Float32Array([
      0, 1, 0, 0,
      0, 0, 0.5, 0,
    ])
    const sourceAnalysis: ImageAnalysis = {
      subjectMask: { width: 4, height: 2, values: sourceValues },
      subjectMaskEvidence: {
        mask: { width: 4, height: 2, values: sourceValues },
        confidence: 0.9,
        source: 'ai',
        revision: 'source-mask',
      },
      semanticRegions: [{
        id: 'cat-face',
        label: 'cat face',
        mask: { width: 4, height: 2, values: sourceValues },
        confidence: 0.95,
        importance: 1,
      }],
      importanceMap: { width: 4, height: 2, weights: sourceValues },
      landmarks: [{
        id: 'left-eye',
        kind: 'eye',
        x: 1,
        y: 0,
        confidence: 0.98,
        priority: 'hard',
        sourceRadiusPx: 1.5,
      }],
      suggestedCrop: { x: 1, y: 0, width: 2, height: 2 },
      suggestedCropConfidence: 0.9,
      suggestedCropSource: 'automatic',
      imageType: 'pet',
    }
    const mapped = projectSourceAnalysisToProposal(sourceAnalysis, {
      ...proposal,
      image: image(4, 4),
      sourceFrame,
    })

    assert.deepEqual(sourceFrame, {
      fit: 'contain',
      sourceWidth: 4,
      sourceHeight: 2,
      x: 0,
      y: 1,
      width: 4,
      height: 2,
    })
    assert.deepEqual(mapped.suggestedCrop, { x: 1, y: 1, width: 2, height: 2 })
    assert.equal(mapped.landmarks?.[0]?.x, 1)
    assert.equal(mapped.landmarks?.[0]?.y, 1)
    assert.equal(mapped.landmarks?.[0]?.sourceRadiusPx, 1.5)
    assert.equal(mapped.subjectMask?.width, 4)
    assert.equal(mapped.subjectMask?.height, 4)
    assert.deepEqual([...mapped.subjectMask!.values], [
      0, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 0.5, 0,
      0, 0, 0, 0,
    ])
    assert.deepEqual(
      [...mapped.semanticRegions![0]!.mask.values],
      [...mapped.subjectMask!.values],
    )
    assert.deepEqual(
      [...mapped.importanceMap!.weights],
      [...mapped.subjectMask!.values],
    )
    assert.deepEqual(
      [...mapped.subjectMaskEvidence!.mask.values],
      [...mapped.subjectMask!.values],
    )
    assert.deepEqual([...sourceAnalysis.subjectMask!.values], [...sourceValues])

    const upscaled = projectSourceAnalysisToProposal({
      importanceMap: { width: 2, height: 1, weights: new Float32Array([1, 0]) },
    }, {
      ...proposal,
      image: image(4, 4),
      sourceFrame: createContainSourceFrame(
        { width: 2, height: 1 },
        { width: 4, height: 4 },
      ),
    })
    assert.deepEqual(
      [...upscaled.importanceMap!.weights.slice(4, 8)].map((value) => Math.round(value * 100)),
      [100, 75, 25, 0],
    )
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

  it('preserves source-candidate pair identity through composite provider selection', async () => {
    const pairManifest = {
      ...localManifest,
      providerId: 'test-pair-provider',
      capabilities: ['embedding', 'preference-scoring'] as const,
    }
    const source = image(3, 2)
    const candidate = image(2, 3)
    const provider: AIModelProvider = {
      manifest: pairManifest,
      async analyze(request): Promise<ModelProviderResult> {
        assert.equal(request.referenceImage, source)
        assert.equal(request.image, candidate)
        assert.equal(request.sourceId, 'source-cat-03')
        assert.equal(request.candidateId, 'candidate-48-quality')
        return {
          providerId: pairManifest.providerId,
          model: pairManifest,
          capabilities: ['embedding', 'preference-scoring'],
          confidence: 0.84,
          elapsedMs: 4,
          preferenceFeatures: {
            modelId: pairManifest.modelId,
            names: ['image-cosine-similarity'],
            values: new Float32Array([0.79]),
            confidence: 0.84,
            scope: 'pair',
            candidateId: 'candidate-48-quality',
          },
        }
      },
      async probe() {
        return { status: 'ready', checkedAt: 1, latencyMs: 1, model: pairManifest }
      },
    }
    const registry = new AIProviderRegistry()
    registry.register(provider)

    const result = await new CompositeImageAnalyzer(registry).analyze({
      image: candidate,
      referenceImage: source,
      sourceId: 'source-cat-03',
      candidateId: 'candidate-48-quality',
      capabilities: ['embedding', 'preference-scoring'],
      route: 'neural-analysis',
      failureMode: 'strict',
    })

    assert.equal(result.preferenceFeatures[0]?.scope, 'pair')
    assert.equal(result.preferenceFeatures[0]?.candidateId, 'candidate-48-quality')
  })

  it('forwards image type and coarse instance guidance through the composite analyzer', async () => {
    const prompt = {
      lasso: [
        { x: 0.15, y: 0.2 },
        { x: 0.75, y: 0.2 },
        { x: 0.8, y: 0.85 },
      ],
      positivePoints: [{ x: 0.48, y: 0.5 }],
      labels: ['cat'],
    } as const
    const provider: AIModelProvider = {
      manifest: localManifest,
      async analyze(request): Promise<ModelProviderResult> {
        assert.equal(request.imageTypeHint, 'pet')
        assert.deepEqual(request.instancePrompt, prompt)
        return {
          providerId: localManifest.providerId,
          model: localManifest,
          capabilities: ['embedding'],
          confidence: 0.8,
          elapsedMs: 2,
        }
      },
      async probe() {
        return { status: 'ready', checkedAt: 1, latencyMs: 1, model: localManifest }
      },
    }
    const registry = new AIProviderRegistry()
    registry.register(provider)

    await new CompositeImageAnalyzer(registry).analyze({
      image: image(),
      capabilities: ['embedding'],
      route: 'neural-analysis',
      failureMode: 'strict',
      imageTypeHint: 'pet',
      instancePrompt: prompt,
    })
  })

  it('runs every explicitly named provider in caller order for the same capability', async () => {
    const calls: string[] = []
    const provider = (providerId: string): AIModelProvider => {
      const manifest = { ...localManifest, providerId }
      return {
        manifest,
        async analyze(request): Promise<ModelProviderResult> {
          calls.push(providerId)
          return {
            providerId,
            model: manifest,
            capabilities: request.capabilities,
            confidence: 0.8,
            elapsedMs: 1,
          }
        },
        async probe() {
          return { status: 'ready', checkedAt: 1, latencyMs: 1, model: manifest }
        },
      }
    }
    const registry = new AIProviderRegistry()
    registry.register(provider('birefnet'), 100)
    registry.register(provider('sam2'), 10)

    await new CompositeImageAnalyzer(registry).analyze({
      image: image(),
      capabilities: ['embedding'],
      route: 'neural-analysis',
      failureMode: 'strict',
      providerIds: ['sam2', 'birefnet'],
    })

    assert.deepEqual(calls, ['sam2', 'birefnet'])
  })

  it('feeds detected instance boxes to one batched keypoint provider request', async () => {
    const source = image(4, 2)
    const segmentationManifest = {
      ...localManifest,
      providerId: 'grounded-pets',
      modelId: 'test/grounded-pets',
      capabilities: ['subject-segmentation'] as const,
    }
    const poseManifest = {
      ...localManifest,
      providerId: 'animal-pose',
      modelId: 'test/animal-pose',
      capabilities: ['keypoints'] as const,
    }
    const proposal = (instanceId: string, x: number) => ({
      id: `${instanceId}:mask`,
      instanceId,
      label: 'cat',
      bbox: { x, y: 0, width: 0.5, height: 1 },
      maskRle: { size: [2, 4] as const, counts: [0, 8] },
      confidence: 0.9,
      detectionScore: 0.88,
      predictedIoU: 0.92,
      stabilityScore: 0.95,
      promptAgreement: 1,
      selected: true,
      diagnostics: {
        promptSource: 'text+box',
        positivePointCount: 0,
        negativePointCount: 0,
        maskAreaRatio: 1,
        lassoContainment: 0.5,
        inferenceMs: 4,
        device: 'cpu',
      },
    })
    const segmentationProvider: AIModelProvider = {
      manifest: segmentationManifest,
      async analyze() {
        return {
          providerId: segmentationManifest.providerId,
          model: segmentationManifest,
          capabilities: ['subject-segmentation'],
          confidence: 0.9,
          elapsedMs: 5,
          instanceProposals: [proposal('pet-01', 0), proposal('pet-02', 0.5)],
        }
      },
      async probe() {
        return { status: 'ready', checkedAt: 1, latencyMs: 1, model: segmentationManifest }
      },
    }
    let poseCalls = 0
    const poseProvider: AIModelProvider = {
      manifest: poseManifest,
      async analyze(request) {
        poseCalls += 1
        assert.deepEqual(request.instancePrompts, [
          {
            box: { x: 0, y: 0, width: 0.5, height: 1 },
            labels: ['cat'],
            selectedInstanceId: 'pet-01',
          },
          {
            box: { x: 0.5, y: 0, width: 0.5, height: 1 },
            labels: ['cat'],
            selectedInstanceId: 'pet-02',
          },
        ])
        return {
          providerId: poseManifest.providerId,
          model: poseManifest,
          capabilities: ['keypoints'],
          confidence: 0.86,
          elapsedMs: 7,
          analysis: {
            imageType: 'pet',
            landmarks: request.instancePrompts!.map((prompt, index) => ({
              id: `${prompt.selectedInstanceId}:nose-tip`,
              kind: 'nose' as const,
              x: index === 0 ? 1 : 3,
              y: 1,
              confidence: 0.86,
              priority: 'hard' as const,
              structuralRole: 'nose-tip' as const,
              observationState: 'observed' as const,
            })),
          },
        }
      },
      async probe() {
        return { status: 'ready', checkedAt: 1, latencyMs: 1, model: poseManifest }
      },
    }
    const registry = new AIProviderRegistry()
    registry.register(segmentationProvider, 20)
    registry.register(poseProvider, 10)

    const result = await new CompositeImageAnalyzer(registry).analyze({
      image: source,
      capabilities: ['subject-segmentation', 'keypoints'],
      route: 'neural-analysis',
      failureMode: 'strict',
      imageTypeHint: 'pet',
    })

    assert.equal(poseCalls, 1)
    assert.equal(result.analysis.landmarks?.length, 2)
    assert.deepEqual(result.analysis.landmarks?.map((entry) => entry.id), [
      'pet-01:nose-tip',
      'pet-02:nose-tip',
    ])
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

  it('hydrates a proposal source frame and binds it to the uploaded source image', async () => {
    const manifest = MODEL_CATALOG.find((entry) => entry.providerId === 'pixel-art-sprite-lcm-local')
    assert.ok(manifest)
    const sourceFrame = createContainSourceFrame(
      { width: 64, height: 32 },
      { width: 64, height: 64 },
    )
    const responses = [
      { sourceFrame },
      {},
    ]
    const provider = new HttpVisionProvider({
      manifest,
      endpoint: 'http://127.0.0.1:7101',
      fetch: async () => {
        const response = responses.shift()!
        return Response.json({
          schemaVersion: 'ai-gateway-provider-v1',
          providerId: manifest.providerId,
          model: {
            modelId: manifest.modelId,
            modelVersion: manifest.modelVersion,
            sourceRevision: manifest.sourceRevision,
            weightRevision: manifest.weightRevision,
          },
          capabilities: ['learned-pixelization'],
          confidence: 0.82,
          learnedProposals: [{
            id: 'cat-proposal',
            kind: 'learned-pixelization',
            confidence: 0.82,
            targetGrid: { width: 48, height: 48 },
            image: {
              width: 64,
              height: 64,
              rgbaBase64: Buffer.alloc(64 * 64 * 4, 255).toString('base64'),
            },
            ...response,
          }],
        })
      },
    })

    const hydrated = await provider.analyze({
      image: image(64, 32),
      capabilities: ['learned-pixelization'],
      targetGrid: { width: 48, height: 48 },
    })

    assert.deepEqual(hydrated.learnedProposals?.[0]?.sourceFrame, sourceFrame)
    await assert.rejects(() => provider.analyze({
      image: image(64, 32),
      capabilities: ['learned-pixelization'],
      targetGrid: { width: 48, height: 48 },
    }), /source frame/i)
  })

  it('replays landmark observation state and structural role from HTTP analysis', async () => {
    const provider = new HttpVisionProvider({
      manifest: localManifest,
      endpoint: 'http://127.0.0.1:7100',
      fetch: async () => Response.json({
        schemaVersion: 'ai-gateway-provider-v1',
        providerId: localManifest.providerId,
        model: {
          modelId: localManifest.modelId,
          modelVersion: localManifest.modelVersion,
          sourceRevision: localManifest.sourceRevision,
          weightRevision: localManifest.weightRevision,
        },
        capabilities: ['embedding'],
        confidence: 0.9,
        analysis: {
          landmarks: [{
            id: 'pet-left-ear-tip',
            kind: 'ear',
            x: 0.25,
            y: 0.125,
            confidence: 0.92,
            priority: 'hard',
            observationState: 'observed',
            structuralRole: 'ear-tip',
            affectsOccupancy: true,
          }],
        },
      }),
    })

    const result = await provider.analyze({
      image: image(),
      capabilities: ['embedding'],
    })

    assert.equal(result.analysis?.landmarks?.[0]?.observationState, 'observed')
    assert.equal(result.analysis?.landmarks?.[0]?.structuralRole, 'ear-tip')
    assert.equal(result.analysis?.landmarks?.[0]?.affectsOccupancy, true)
  })

  it('rejects invalid landmark observation states and structural roles from HTTP analysis', async () => {
    const response = (landmark: Readonly<Record<string, unknown>>) => Response.json({
      schemaVersion: 'ai-gateway-provider-v1',
      providerId: localManifest.providerId,
      model: {
        modelId: localManifest.modelId,
        modelVersion: localManifest.modelVersion,
        sourceRevision: localManifest.sourceRevision,
        weightRevision: localManifest.weightRevision,
      },
      capabilities: ['embedding'],
      confidence: 0.9,
      analysis: {
        landmarks: [{
          id: 'pet-landmark',
          kind: 'body',
          x: 0.5,
          y: 0.5,
          confidence: 0.8,
          priority: 'soft',
          ...landmark,
        }],
      },
    })
    const responses = [
      response({ observationState: 'estimated' }),
      response({ structuralRole: 'whisker-tip' }),
    ]
    const provider = new HttpVisionProvider({
      manifest: localManifest,
      endpoint: 'http://127.0.0.1:7100',
      fetch: async () => responses.shift()!,
    })

    await assert.rejects(() => provider.analyze({
      image: image(),
      capabilities: ['embedding'],
    }), /observationState is invalid/)
    await assert.rejects(() => provider.analyze({
      image: image(),
      capabilities: ['embedding'],
    }), /structuralRole is invalid/)
  })

  it('accepts legacy HTTP landmarks that omit observation state and structural role', async () => {
    const provider = new HttpVisionProvider({
      manifest: localManifest,
      endpoint: 'http://127.0.0.1:7100',
      fetch: async () => Response.json({
        schemaVersion: 'ai-gateway-provider-v1',
        providerId: localManifest.providerId,
        model: {
          modelId: localManifest.modelId,
          modelVersion: localManifest.modelVersion,
          sourceRevision: localManifest.sourceRevision,
          weightRevision: localManifest.weightRevision,
        },
        capabilities: ['embedding'],
        confidence: 0.8,
        analysis: {
          landmarks: [{
            id: 'legacy-eye',
            kind: 'eye',
            x: 0.4,
            y: 0.3,
            confidence: 0.85,
            priority: 'hard',
            sourceRadiusPx: 3,
          }],
        },
      }),
    })

    const result = await provider.analyze({
      image: image(),
      capabilities: ['embedding'],
    })

    assert.equal(result.analysis?.landmarks?.[0]?.id, 'legacy-eye')
    assert.equal(result.analysis?.landmarks?.[0]?.observationState, undefined)
    assert.equal(result.analysis?.landmarks?.[0]?.structuralRole, undefined)
  })

  it('posts source and candidate images and binds OpenCLIP pair features to the candidate', async () => {
    const openClipManifest = {
      ...localManifest,
      providerId: 'openclip-pair-test',
      modelId: 'mlfoundations/open_clip/ViT-B-32/laion2b_s34b_b79k',
      modelVersion: 'open_clip_torch-3.3.0',
      capabilities: ['embedding', 'preference-scoring'] as const,
      license: {
        spdx: 'MIT',
        name: 'MIT License',
        url: 'https://opensource.org/license/mit',
      },
      weightLicense: {
        spdx: 'MIT',
        name: 'MIT License',
        url: 'https://opensource.org/license/mit',
      },
    }
    const source = image(3, 2)
    const candidate = image(2, 3)
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      assert.ok(init?.body instanceof FormData)
      const form = init.body
      assert.ok(form.get('image') instanceof Blob)
      assert.ok(form.get('referenceImage') instanceof Blob)
      const request = JSON.parse(String(form.get('request'))) as {
        sourceId: string
        candidateId: string
        capabilities: string[]
        model: { modelId: string; modelVersion: string }
      }
      assert.equal(request.sourceId, 'source-cat-03')
      assert.equal(request.candidateId, 'candidate-48-quality')
      assert.deepEqual(request.capabilities, ['embedding', 'preference-scoring'])
      assert.equal(request.model.modelId, openClipManifest.modelId)
      assert.equal(request.model.modelVersion, openClipManifest.modelVersion)
      return Response.json({
        schemaVersion: 'ai-gateway-provider-v1',
        providerId: openClipManifest.providerId,
        model: {
          modelId: openClipManifest.modelId,
          modelVersion: openClipManifest.modelVersion,
          sourceRevision: openClipManifest.sourceRevision,
          weightRevision: openClipManifest.weightRevision,
        },
        capabilities: ['embedding', 'preference-scoring'],
        confidence: 0.88,
        preferenceFeatures: {
          names: ['image-cosine-similarity', 'cat-vs-bird-margin'],
          values: [0.82, 0.41],
          confidence: 0.88,
          scope: 'pair',
          candidateId: 'candidate-48-quality',
        },
      })
    }
    const provider = new HttpVisionProvider({
      manifest: openClipManifest,
      endpoint: 'http://127.0.0.1:7100',
      fetch,
    })

    const result = await provider.analyze({
      image: candidate,
      referenceImage: source,
      sourceId: 'source-cat-03',
      candidateId: 'candidate-48-quality',
      capabilities: ['embedding', 'preference-scoring'],
    })

    assert.equal(result.preferenceFeatures?.scope, 'pair')
    assert.equal(result.preferenceFeatures?.candidateId, 'candidate-48-quality')
    assert.equal(result.model.providerId, openClipManifest.providerId)
    assert.equal(result.model.modelVersion, 'open_clip_torch-3.3.0')
    assert.equal(result.model.license.spdx, 'MIT')
    assert.equal(result.model.weightLicense?.spdx, 'MIT')
  })

  it('posts image type and instance guidance to prompted vision providers', async () => {
    const prompt = {
      lasso: [
        { x: 0.1, y: 0.15 },
        { x: 0.85, y: 0.2 },
        { x: 0.78, y: 0.9 },
      ],
      positivePoints: [{ x: 0.5, y: 0.5 }],
      negativePoints: [{ x: 0.95, y: 0.5 }],
      labels: ['cat'],
    } as const
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      assert.ok(init?.body instanceof FormData)
      const request = JSON.parse(String(init.body.get('request'))) as {
        imageTypeHint: string
        instancePrompt: typeof prompt
      }
      assert.equal(request.imageTypeHint, 'pet')
      assert.deepEqual(request.instancePrompt, prompt)
      return Response.json({
        schemaVersion: 'ai-gateway-provider-v1',
        providerId: localManifest.providerId,
        model: {
          modelId: localManifest.modelId,
          modelVersion: localManifest.modelVersion,
          sourceRevision: localManifest.sourceRevision,
          weightRevision: localManifest.weightRevision,
        },
        capabilities: ['embedding'],
        confidence: 0.8,
      })
    }
    const provider = new HttpVisionProvider({
      manifest: localManifest,
      endpoint: 'http://127.0.0.1:7100',
      fetch,
    })

    await provider.analyze({
      image: image(),
      capabilities: ['embedding'],
      imageTypeHint: 'pet',
      instancePrompt: prompt,
    })
  })

  it('hydrates SAM2 compact RLE evidence and structured instance quality', async () => {
    const samManifest = MODEL_CATALOG.find((entry) => entry.providerId === 'sam2-local')
    assert.ok(samManifest)
    const compactMask = {
      size: [32, 32],
      counts: [495, 1, 31, 1, 496],
    }
    const compactImportance = new Uint8Array(32 * 32)
    compactImportance[15 * 32 + 14] = 255
    compactImportance[15 * 32 + 17] = 192
    const provider = new HttpVisionProvider({
      manifest: samManifest,
      endpoint: 'http://127.0.0.1:7103',
      fetch: async () => Response.json({
        schemaVersion: 'ai-gateway-provider-v1',
        providerId: samManifest.providerId,
        model: {
          modelId: samManifest.modelId,
          modelVersion: samManifest.modelVersion,
          sourceRevision: samManifest.sourceRevision,
          weightRevision: samManifest.weightRevision,
        },
        capabilities: ['subject-segmentation', 'edge-thin-structure'],
        confidence: 0.91,
        analysis: {
          subjectMaskEvidence: {
            mask: { width: 32, height: 32, rle: compactMask },
            confidence: 0.91,
            source: 'ai',
            revision: 'sam2:test-mask',
          },
          suggestedCrop: { x: 14, y: 14, width: 4, height: 3 },
          suggestedCropConfidence: 0.91,
          suggestedCropSource: 'automatic',
          importanceMap: {
            width: 32,
            height: 32,
            uint8Base64: Buffer.from(compactImportance).toString('base64'),
          },
        },
        instanceProposals: [{
          id: 'cat-left:mask-1',
          instanceId: 'cat-left',
          label: 'cat',
          bbox: { x: 14 / 32, y: 14 / 32, width: 4 / 32, height: 3 / 32 },
          maskRle: compactMask,
          confidence: 0.91,
          detectionScore: 0.89,
          predictedIoU: 0.93,
          stabilityScore: 0.97,
          promptAgreement: 1,
          selected: true,
          diagnostics: {
            promptSource: 'lasso',
            positivePointCount: 3,
            negativePointCount: 4,
            maskAreaRatio: 2 / 1024,
            lassoContainment: 0.98,
            inferenceMs: 18.5,
            device: 'cuda:0',
          },
        }],
      }),
    })

    const result = await provider.analyze({
      image: image(32, 32),
      capabilities: ['subject-segmentation', 'edge-thin-structure'],
      imageTypeHint: 'pet',
      instancePrompt: {
        lasso: [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.9, y: 0.9 },
        ],
        selectedInstanceId: 'cat-left',
      },
    })

    const hydratedMask = result.analysis?.subjectMaskEvidence?.mask.values
    assert.equal(hydratedMask?.length, 1024)
    assert.equal(hydratedMask?.[15 * 32 + 15], 1)
    assert.equal(hydratedMask?.[15 * 32 + 16], 1)
    assert.equal(hydratedMask?.reduce((sum, value) => sum + value, 0), 2)
    assert.equal(result.analysis?.importanceMap?.weights[15 * 32 + 14], 1)
    assert.ok(Math.abs((result.analysis?.importanceMap?.weights[15 * 32 + 17] ?? 0) - 192 / 255) < 1e-6)
    assert.equal(result.instanceProposals?.[0]?.instanceId, 'cat-left')
    assert.equal(result.instanceProposals?.[0]?.detectionScore, 0.89)
    assert.equal(result.instanceProposals?.[0]?.predictedIoU, 0.93)
    assert.equal(result.instanceProposals?.[0]?.stabilityScore, 0.97)
    assert.equal(result.instanceProposals?.[0]?.diagnostics.promptSource, 'lasso')
    assert.equal(result.instanceProposals?.[0]?.diagnostics.lassoContainment, 0.98)
    assert.equal(result.instanceProposals?.[0]?.maskRle.counts.reduce((sum, count) => sum + count, 0), 1024)
  })

  it('rejects malformed compact mask runs before returning provider output', async () => {
    const samManifest = MODEL_CATALOG.find((entry) => entry.providerId === 'sam2-local')
    assert.ok(samManifest)
    const provider = new HttpVisionProvider({
      manifest: samManifest,
      endpoint: 'http://127.0.0.1:7103',
      fetch: async () => Response.json({
        schemaVersion: 'ai-gateway-provider-v1',
        providerId: samManifest.providerId,
        model: {
          modelId: samManifest.modelId,
          modelVersion: samManifest.modelVersion,
          sourceRevision: samManifest.sourceRevision,
          weightRevision: samManifest.weightRevision,
        },
        capabilities: ['subject-segmentation'],
        confidence: 0.8,
        analysis: {
          subjectMaskEvidence: {
            mask: {
              width: 32,
              height: 32,
              rle: { size: [32, 32], counts: [4, 1] },
            },
            confidence: 0.8,
            source: 'ai',
            revision: 'sam2:bad-rle',
          },
        },
      }),
    })

    await assert.rejects(() => provider.analyze({
      image: image(32, 32),
      capabilities: ['subject-segmentation'],
      instancePrompt: { positivePoints: [{ x: 0.5, y: 0.5 }] },
    }), /RLE counts differ from dimensions/)
  })

  it('rejects pair features whose scope or candidate identity differs from the request', async () => {
    const response = (scope: 'candidate' | 'pair', candidateId: string) => Response.json({
      schemaVersion: 'ai-gateway-provider-v1',
      providerId: localManifest.providerId,
      model: {
        modelId: localManifest.modelId,
        modelVersion: localManifest.modelVersion,
        sourceRevision: localManifest.sourceRevision,
        weightRevision: localManifest.weightRevision,
      },
      capabilities: ['embedding'],
      confidence: 0.7,
      preferenceFeatures: {
        names: ['identity-similarity'],
        values: [0.6],
        confidence: 0.7,
        scope,
        candidateId,
      },
    })
    const responses = [
      response('candidate', 'candidate-a'),
      response('pair', 'candidate-b'),
    ]
    const provider = new HttpVisionProvider({
      manifest: localManifest,
      endpoint: 'http://127.0.0.1:7100',
      fetch: async () => responses.shift()!,
    })
    const request = {
      image: image(),
      referenceImage: image(),
      candidateId: 'candidate-a',
      capabilities: ['embedding'] as const,
    }

    await assert.rejects(() => provider.analyze(request), /pair scope/i)
    await assert.rejects(() => provider.analyze(request), /candidate identity/i)
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

  it('serializes batched instance prompts for a keypoint sidecar', async () => {
    const manifest = {
      ...localManifest,
      providerId: 'test-animal-pose-http',
      modelId: 'test/animal-pose-http',
      capabilities: ['keypoints'] as const,
    }
    const provider = new HttpVisionProvider({
      manifest,
      endpoint: 'http://127.0.0.1:7104',
      fetch: async (_input, init) => {
        assert.ok(init?.body instanceof FormData)
        const request = JSON.parse(String(init.body.get('request'))) as {
          instancePrompts?: unknown[]
        }
        assert.deepEqual(request.instancePrompts, [
          {
            box: { x: 0, y: 0, width: 0.45, height: 1 },
            labels: ['cat'],
            selectedInstanceId: 'pet-01',
          },
          {
            box: { x: 0.55, y: 0, width: 0.45, height: 1 },
            labels: ['cat'],
            selectedInstanceId: 'pet-02',
          },
        ])
        return Response.json({
          schemaVersion: 'ai-gateway-provider-v1',
          providerId: manifest.providerId,
          model: {
            modelId: manifest.modelId,
            modelVersion: manifest.modelVersion,
            sourceRevision: manifest.sourceRevision,
            weightRevision: manifest.weightRevision,
          },
          capabilities: ['keypoints'],
          confidence: 0.8,
        })
      },
    })

    await provider.analyze({
      image: image(4, 2),
      capabilities: ['keypoints'],
      instancePrompts: [
        {
          box: { x: 0, y: 0, width: 0.45, height: 1 },
          labels: ['cat'],
          selectedInstanceId: 'pet-01',
        },
        {
          box: { x: 0.55, y: 0, width: 0.45, height: 1 },
          labels: ['cat'],
          selectedInstanceId: 'pet-02',
        },
      ],
    })
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
      referenceImage: image(),
      candidateId: 'candidate-timeout',
      capabilities: ['embedding'],
    }), /timed out/)

    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))
    await assert.rejects(() => timed.analyze({
      image: image(),
      referenceImage: image(),
      candidateId: 'candidate-cancelled',
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
      referenceImage: image(),
      candidateId: 'candidate-oversized-response',
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
