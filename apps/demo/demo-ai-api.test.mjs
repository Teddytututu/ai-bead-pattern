import assert from 'node:assert/strict'
import { createServer, request as createRequest } from 'node:http'
import { afterEach, describe, it } from 'node:test'

import {
  AIProviderRegistry,
  modelManifest,
} from '../../services/ai-gateway/dist/index.js'
import {
  createDemoAiApiHandler,
  createDemoAiService,
  demoAiLimits,
} from '../../scripts/demo-ai-api.mjs'

const servers = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error))
  })))
})

function fakeRegistry() {
  const manifest = modelManifest('rembg-birefnet-general-lite')
  const registry = new AIProviderRegistry()
  registry.register({
    manifest,
    async probe() {
      return { status: 'ready', checkedAt: 1, latencyMs: 2, model: manifest }
    },
    async analyze(request) {
      const values = Float32Array.from({ length: request.image.width * request.image.height }, (_, index) =>
        index === 0 ? 0 : 1)
      const mask = { width: request.image.width, height: request.image.height, values }
      return {
        providerId: manifest.providerId,
        model: manifest,
        capabilities: request.capabilities,
        confidence: 0.9,
        elapsedMs: 3,
        analysis: {
          subjectMask: mask,
          subjectMaskEvidence: {
            mask,
            confidence: 0.9,
            source: 'ai',
            revision: 'fake:mask:v1',
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
  return registry
}

async function start(handler) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

function imagePayload(route = 'neural-analysis') {
  return {
    route,
    capabilities: route === 'neural-analysis'
      ? ['subject-segmentation', 'edge-thin-structure']
      : [route],
    image: {
      width: 2,
      height: 2,
      rgbaBase64: Buffer.from(new Uint8Array(16).fill(255)).toString('base64'),
    },
  }
}

describe('demo AI JSON API', () => {
  it('keeps the hard request limit large enough for the declared 2048 RGBA input', () => {
    const rgbaBytes = demoAiLimits.maximumImageDimension ** 2 * 4
    const maximumBase64Bytes = Math.ceil(rgbaBytes / 3) * 4
    assert.ok(demoAiLimits.maximumRequestBytes > maximumBase64Bytes + 1024)
  })

  it('reports provider identity and explicit route availability', async () => {
    const service = createDemoAiService({ registry: fakeRegistry() })
    const baseUrl = await start(createDemoAiApiHandler({ service }))

    const response = await fetch(`${baseUrl}/api/ai/health`)
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.equal(body.routes['neural-analysis'].available, true)
    assert.equal(body.routes['learned-pixelization'].available, false)
    assert.equal(body.providers[0].providerId, 'rembg-birefnet-general-lite')
    assert.equal(body.providers[0].modelId, 'rembg/birefnet-general-lite')
  })

  it('registers the configured pixel proposal sidecar and exposes both routes', async () => {
    const model = modelManifest('pixel-art-sprite-lcm-local')
    const fetch = async (input) => {
      assert.equal(String(input), 'http://127.0.0.1:7101/health')
      return Response.json({
        status: 'ready',
        model: {
          modelId: model.modelId,
          modelVersion: model.modelVersion,
          sourceRevision: model.sourceRevision,
          weightRevision: model.weightRevision,
        },
      })
    }
    const service = createDemoAiService({
      proposalEndpoint: 'http://127.0.0.1:7101',
      proposalFetch: fetch,
    })

    const health = await service.health()

    assert.equal(health.routes['learned-pixelization'].available, true)
    assert.equal(health.routes['generative-proposal'].available, true)
    assert.equal(health.providers.find((entry) => entry.providerId === model.providerId)?.status, 'ready')
  })

  it('scores one candidate against its source with DINOv2 and OpenCLIP in the same API request', async () => {
    const dinov2 = modelManifest('dinov2-vits14-pair-local')
    const openclip = modelManifest('openclip-vit-b32-pair-local')
    const received = []
    const identity = (model) => ({
      modelId: model.modelId,
      modelVersion: model.modelVersion,
      sourceRevision: model.sourceRevision,
      weightRevision: model.weightRevision,
    })
    const pairFetch = (model, preferenceFeatures) => async (input, init) => {
      if (String(input).endsWith('/health')) {
        return Response.json({ status: 'ready', model: identity(model) })
      }
      assert.ok(init?.body instanceof FormData)
      assert.ok(init.body.get('image') instanceof Blob)
      assert.ok(init.body.get('referenceImage') instanceof Blob)
      const request = JSON.parse(String(init.body.get('request')))
      received.push({ providerId: model.providerId, request })
      return Response.json({
        schemaVersion: 'ai-gateway-provider-v1',
        providerId: model.providerId,
        model: identity(model),
        capabilities: ['embedding', 'preference-scoring'],
        confidence: 0.9,
        preferenceFeatures,
      })
    }
    const regionalComparisons = [
      ['global', 0.91, 0.87, 0.85, 0.96],
      ['subject', 0.93, 0.89, 0.88, 0.92],
      ['head', 0.95, 0.9, 0.94, 0.86],
      ['critical-local', 0.92, 0.88, 0.93, 0.82],
    ].map(([view, identitySimilarity, patchCorrespondence, criticalPatchRetention, regionalCoverage]) => ({
      view,
      identitySimilarity,
      patchCorrespondence,
      criticalPatchRetention,
      regionalCoverage,
      confidence: 0.9,
    }))
    const regionalNames = regionalComparisons.flatMap((entry) => [
      `${entry.view}.identitySimilarity`,
      `${entry.view}.patchCorrespondence`,
      `${entry.view}.criticalPatchRetention`,
      `${entry.view}.regionalCoverage`,
    ])
    const regionalValues = regionalComparisons.flatMap((entry) => [
      entry.identitySimilarity,
      entry.patchCorrespondence,
      entry.criticalPatchRetention,
      entry.regionalCoverage,
    ])
    const service = createDemoAiService({
      dinov2Endpoint: 'http://127.0.0.1:7105',
      dinov2Fetch: pairFetch(dinov2, {
        names: regionalNames,
        values: regionalValues,
        confidence: 0.9,
        scope: 'pair',
        candidateId: 'candidate-quality-48',
        regionalComparisons,
      }),
      openclipEndpoint: 'http://127.0.0.1:7102',
      openclipFetch: pairFetch(openclip, {
        names: ['semanticRetention', 'classDistributionRetention', 'petClassMargin'],
        values: [0.89, 0.84, 0.78],
        confidence: 0.88,
        scope: 'pair',
        candidateId: 'candidate-quality-48',
      }),
    })
    const baseUrl = await start(createDemoAiApiHandler({ service }))
    const encoded = (fill) => ({
      width: 32,
      height: 32,
      rgbaBase64: Buffer.from(new Uint8Array(32 * 32 * 4).fill(fill)).toString('base64'),
    })

    const health = await fetch(`${baseUrl}/api/ai/health`).then((response) => response.json())
    assert.deepEqual(health.routes['preference-scoring'].providers, [
      'dinov2-vits14-pair-local',
      'openclip-vit-b32-pair-local',
    ])

    const response = await fetch(`${baseUrl}/api/ai/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        route: 'preference-scoring',
        capabilities: ['embedding', 'preference-scoring'],
        image: encoded(220),
        referenceImage: encoded(180),
        sourceId: 'source-cat-03',
        candidateId: 'candidate-quality-48',
        providerIds: ['dinov2-vits14-pair-local', 'openclip-vit-b32-pair-local'],
      }),
    })
    const result = await response.json()

    assert.equal(response.status, 200)
    assert.equal(result.status, 'ready')
    assert.deepEqual(received.map((entry) => entry.providerId), [
      'dinov2-vits14-pair-local',
      'openclip-vit-b32-pair-local',
    ])
    for (const entry of received) {
      assert.equal(entry.request.sourceId, 'source-cat-03')
      assert.equal(entry.request.candidateId, 'candidate-quality-48')
      assert.deepEqual(entry.request.capabilities, ['embedding', 'preference-scoring'])
    }
    assert.deepEqual(result.contributions.map((entry) => entry.status), ['used', 'used'])
    assert.deepEqual(new Set(result.preferenceFeatures.map((entry) => entry.modelId)), new Set([
      dinov2.modelId,
      openclip.modelId,
    ]))
    assert.deepEqual(
      result.preferenceFeatures.find((entry) => entry.modelId === dinov2.modelId)
        .regionalComparisons.map((entry) => entry.view),
      ['global', 'subject', 'head', 'critical-local'],
    )
  })

  it('registers the configured SAM2 prompted segmentation sidecar', async () => {
    const model = modelManifest('sam2-local')
    const groundedModel = modelManifest('grounded-sam2-local')
    const fetch = async (input) => {
      const grounded = String(input).endsWith('/health/grounded')
      return Response.json({
        status: 'ready',
        model: {
          modelId: grounded ? groundedModel.modelId : model.modelId,
          modelVersion: grounded ? groundedModel.modelVersion : model.modelVersion,
          sourceRevision: grounded ? groundedModel.sourceRevision : model.sourceRevision,
          weightRevision: grounded ? groundedModel.weightRevision : model.weightRevision,
        },
      })
    }
    const service = createDemoAiService({
      sam2Endpoint: 'http://127.0.0.1:7103',
      sam2Fetch: fetch,
    })

    const health = await service.health()

    const provider = health.providers.find((entry) => entry.providerId === model.providerId)
    assert.equal(provider?.status, 'ready')
    assert.equal(provider?.modelId, 'facebook/sam2.1-hiera-small')
    assert.ok(health.routes['neural-analysis'].providers.includes('sam2-local'))
    assert.ok(health.routes['neural-analysis'].providers.includes('grounded-sam2-local'))
  })

  it('registers Grounded SAM2 with its dedicated health identity', async () => {
    const model = modelManifest('grounded-sam2-local')
    const fetch = async (input) => {
      assert.equal(String(input), 'http://127.0.0.1:7103/health/grounded')
      return Response.json({
        status: 'ready',
        model: {
          modelId: model.modelId,
          modelVersion: model.modelVersion,
          sourceRevision: model.sourceRevision,
          weightRevision: model.weightRevision,
        },
      })
    }
    const service = createDemoAiService({
      groundedSam2Endpoint: 'http://127.0.0.1:7103',
      groundedSam2Fetch: fetch,
    })

    const health = await service.health()

    const provider = health.providers.find((entry) => entry.providerId === model.providerId)
    assert.equal(provider?.status, 'ready')
    assert.ok(health.routes['neural-analysis'].providers.includes('grounded-sam2-local'))
  })

  it('forwards a labels-only Grounded request and hydrates multiple instances', async () => {
    const model = modelManifest('grounded-sam2-local')
    let postedRequest
    const fetch = async (input, init) => {
      if (String(input).endsWith('/health/grounded')) {
        return Response.json({
          status: 'ready',
          model: {
            modelId: model.modelId,
            modelVersion: model.modelVersion,
            sourceRevision: model.sourceRevision,
            weightRevision: model.weightRevision,
          },
        })
      }
      postedRequest = JSON.parse(init.body.get('request'))
      const identity = {
        modelId: model.modelId,
        modelVersion: model.modelVersion,
        sourceRevision: model.sourceRevision,
        weightRevision: model.weightRevision,
      }
      const diagnostics = {
        promptSource: 'text+box',
        positivePointCount: 0,
        negativePointCount: 0,
        maskAreaRatio: 1 / 1024,
        lassoContainment: 0.5,
        inferenceMs: 5,
        device: 'cuda:0',
      }
      const maskA = { size: [32, 32], counts: [0, 1, 1023] }
      const maskB = { size: [32, 32], counts: [1023, 1] }
      return Response.json({
        schemaVersion: 'ai-gateway-provider-v1',
        providerId: model.providerId,
        model: identity,
        capabilities: ['subject-segmentation', 'edge-thin-structure'],
        confidence: 0.9,
        inferenceMs: 8,
        analysis: {
          subjectMaskEvidence: {
            mask: { width: 32, height: 32, rle: { size: [32, 32], counts: [0, 1, 1022, 1] } },
            confidence: 0.9,
            source: 'ai',
            revision: 'grounded:test',
          },
          semanticRegions: [
            { id: 'pet-01:subject', label: 'subject', mask: { width: 32, height: 32, rle: maskA }, confidence: 0.92 },
            { id: 'pet-02:subject', label: 'subject', mask: { width: 32, height: 32, rle: maskB }, confidence: 0.88 },
          ],
          suggestedCrop: { x: 0, y: 0, width: 32, height: 32 },
          suggestedCropConfidence: 0.9,
          suggestedCropSource: 'automatic',
        },
        instanceProposals: [
          {
            id: 'pet-01:test', instanceId: 'pet-01', label: 'cat',
            bbox: { x: 0, y: 0, width: 0.5, height: 0.5 }, maskRle: maskA,
            confidence: 0.92, detectionScore: 0.9, predictedIoU: 0.95,
            stabilityScore: 0.98, promptAgreement: 1, selected: true, diagnostics,
          },
          {
            id: 'pet-02:test', instanceId: 'pet-02', label: 'cat',
            bbox: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, maskRle: maskB,
            confidence: 0.88, detectionScore: 0.84, predictedIoU: 0.93,
            stabilityScore: 0.97, promptAgreement: 1, selected: false, diagnostics,
          },
        ],
      })
    }
    const service = createDemoAiService({
      groundedSam2Endpoint: 'http://127.0.0.1:7103',
      groundedSam2Fetch: fetch,
    })

    const result = await service.analyze({
      ...imagePayload(),
      image: {
        width: 32,
        height: 32,
        rgbaBase64: Buffer.from(new Uint8Array(32 * 32 * 4).fill(255)).toString('base64'),
      },
      providerIds: ['grounded-sam2-local'],
      imageTypeHint: 'pet',
      instancePrompt: { labels: ['a cat'] },
    })

    assert.equal(result.contributions[0]?.status, 'used', result.contributions[0]?.message)
    assert.deepEqual(postedRequest.instancePrompt, { labels: ['a cat'] })
    assert.equal(result.instanceProposals.length, 2)
    assert.deepEqual(result.analysis.semanticRegions.map((region) => region.id), [
      'pet-01:subject',
      'pet-02:subject',
    ])
    assert.equal(result.instanceProposals[0].detectionScore, 0.9)
  })

  it('discovers an untyped pet upload before one batched RTMPose request', async () => {
    const groundedModel = modelManifest('grounded-sam2-local')
    const poseModel = modelManifest('mmpose-animal-local')
    const requests = []
    const groundedFetch = async (input, init) => {
      if (String(input).endsWith('/health/grounded')) {
        return Response.json({
          status: 'ready',
          model: {
            modelId: groundedModel.modelId,
            modelVersion: groundedModel.modelVersion,
            sourceRevision: groundedModel.sourceRevision,
            weightRevision: groundedModel.weightRevision,
          },
        })
      }
      requests.push({ providerId: groundedModel.providerId, request: JSON.parse(init.body.get('request')) })
      const diagnostics = {
        promptSource: 'text+box', positivePointCount: 0, negativePointCount: 0,
        maskAreaRatio: 0.25, lassoContainment: 1, inferenceMs: 5, device: 'cuda:0',
      }
      const firstMask = { size: [32, 32], counts: [0, 256, 768] }
      const secondMask = { size: [32, 32], counts: [768, 256] }
      return Response.json({
        schemaVersion: 'ai-gateway-provider-v1',
        providerId: groundedModel.providerId,
        model: {
          modelId: groundedModel.modelId,
          modelVersion: groundedModel.modelVersion,
          sourceRevision: groundedModel.sourceRevision,
          weightRevision: groundedModel.weightRevision,
        },
        capabilities: ['subject-segmentation', 'edge-thin-structure'],
        confidence: 0.92,
        inferenceMs: 8,
        instanceProposals: [
          {
            id: 'pet-01:cat', instanceId: 'pet-01', label: 'cat',
            bbox: { x: 0, y: 0, width: 0.48, height: 1 }, maskRle: firstMask,
            confidence: 0.94, detectionScore: 0.93, predictedIoU: 0.96,
            stabilityScore: 0.99, promptAgreement: 1, selected: true, diagnostics,
          },
          {
            id: 'pet-02:cat', instanceId: 'pet-02', label: 'cat',
            bbox: { x: 0.52, y: 0, width: 0.48, height: 1 }, maskRle: secondMask,
            confidence: 0.9, detectionScore: 0.89, predictedIoU: 0.95,
            stabilityScore: 0.98, promptAgreement: 1, selected: true, diagnostics,
          },
        ],
      })
    }
    const poseFetch = async (input, init) => {
      if (String(input).endsWith('/health')) {
        return Response.json({
          status: 'ready',
          model: {
            modelId: poseModel.modelId,
            modelVersion: poseModel.modelVersion,
            sourceRevision: poseModel.sourceRevision,
            weightRevision: poseModel.weightRevision,
          },
        })
      }
      const request = JSON.parse(init.body.get('request'))
      requests.push({ providerId: poseModel.providerId, request })
      return Response.json({
        schemaVersion: 'ai-gateway-provider-v1',
        providerId: poseModel.providerId,
        model: {
          modelId: poseModel.modelId,
          modelVersion: poseModel.modelVersion,
          sourceRevision: poseModel.sourceRevision,
          weightRevision: poseModel.weightRevision,
        },
        capabilities: ['keypoints'],
        confidence: 0.88,
        inferenceMs: 7,
        analysis: {
          imageType: 'pet',
          landmarks: request.instancePrompts.map((prompt, index) => ({
            id: `${prompt.selectedInstanceId}:nose-tip`,
            kind: 'nose',
            structuralRole: 'nose-tip',
            observationState: 'observed',
            x: index === 0 ? 8 : 24,
            y: 12,
            confidence: 0.88,
            priority: 'hard',
          })),
        },
        warnings: ['instanceCount=2'],
      })
    }
    const service = createDemoAiService({
      groundedSam2Endpoint: 'http://127.0.0.1:7103',
      groundedSam2Fetch: groundedFetch,
      mmposeEndpoint: 'http://127.0.0.1:7104',
      mmposeFetch: poseFetch,
    })

    const baseUrl = await start(createDemoAiApiHandler({ service }))
    const response = await fetch(`${baseUrl}/api/ai/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...imagePayload(),
        image: {
          width: 32,
          height: 32,
          rgbaBase64: Buffer.from(new Uint8Array(32 * 32 * 4).fill(255)).toString('base64'),
        },
      }),
    })
    const result = await response.json()

    assert.equal(response.status, 200)
    assert.deepEqual(result.contributions.map((entry) => entry.providerId).slice(0, 2), [
      'grounded-sam2-local',
      'mmpose-animal-local',
    ])
    assert.deepEqual(requests[1].request.instancePrompts.map((prompt) => prompt.selectedInstanceId), [
      'pet-01',
      'pet-02',
    ])
    assert.deepEqual(result.analysis.landmarks.map((landmark) => landmark.id), [
      'pet-01:nose-tip',
      'pet-02:nose-tip',
    ])
    assert.equal(result.analysis.imageType, 'pet')
  })

  it('runs analysis and serializes typed model output as bounded JSON arrays', async () => {
    const service = createDemoAiService({ registry: fakeRegistry() })
    const baseUrl = await start(createDemoAiApiHandler({ service }))

    const response = await fetch(`${baseUrl}/api/ai/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(imagePayload()),
    })
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.equal(body.status, 'ready')
    assert.deepEqual(body.analysis.subjectMask.values, [0, 1, 1, 1])
    assert.deepEqual(body.analysis.importanceMap.weights.map((value) => Math.round(value * 10)), [0, 8, 8, 8])
    assert.equal(body.contributions[0].providerId, 'rembg-birefnet-general-lite')
  })

  it('preserves explicit providers and coarse instance guidance at the API boundary', async () => {
    let received
    const manifest = modelManifest('rembg-birefnet-general-lite')
    const registry = new AIProviderRegistry()
    registry.register({
      manifest,
      async probe() {
        return { status: 'ready', checkedAt: 1, latencyMs: 1, model: manifest }
      },
      async analyze(request) {
        received = request
        return {
          providerId: manifest.providerId,
          model: manifest,
          capabilities: request.capabilities,
          confidence: 0.8,
          elapsedMs: 1,
        }
      },
    })
    const service = createDemoAiService({ registry })
    const baseUrl = await start(createDemoAiApiHandler({ service }))
    const instancePrompt = {
      lasso: [
        { x: 0.1, y: 0.15 },
        { x: 0.85, y: 0.2 },
        { x: 0.8, y: 0.9 },
      ],
      positivePoints: [{ x: 0.5, y: 0.5 }],
      labels: ['cat'],
    }
    const response = await fetch(`${baseUrl}/api/ai/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...imagePayload(),
        imageTypeHint: 'pet',
        providerIds: ['rembg-birefnet-general-lite'],
        instancePrompt,
      }),
    })

    assert.equal(response.status, 200)
    assert.equal(received.imageTypeHint, 'pet')
    assert.deepEqual(received.instancePrompt, instancePrompt)
  })

  it('returns unavailable proposal routes and rejects invalid or oversized requests', async () => {
    const service = createDemoAiService({ registry: fakeRegistry() })
    const baseUrl = await start(createDemoAiApiHandler({ service, maximumRequestBytes: 256 }))

    const proposalResponse = await fetch(`${baseUrl}/api/ai/proposals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(imagePayload('learned-pixelization')),
    })
    const proposal = await proposalResponse.json()
    assert.equal(proposal.status, 'unavailable')
    assert.deepEqual(proposal.uncoveredCapabilities, ['learned-pixelization'])

    const invalidResponse = await fetch(`${baseUrl}/api/ai/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...imagePayload(), route: 'future-route' }),
    })
    assert.equal(invalidResponse.status, 400)

    const oversizedResponse = await fetch(`${baseUrl}/api/ai/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'x'.repeat(400) }),
    })
    assert.equal(oversizedResponse.status, 413)
  })

  it('requires JSON and forwards a disconnected client as cancellation', async () => {
    let started
    let observeStart
    const startedPromise = new Promise((resolve) => { observeStart = resolve })
    const aborted = new Promise((resolve) => {
      started = (signal) => {
        observeStart()
        signal.addEventListener('abort', () => resolve(signal.reason), { once: true })
        return new Promise((_complete, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
    })
    const service = {
      async health() { return { routes: {}, providers: [] } },
      analyze(payload, signal) { return started(signal) },
    }
    const baseUrl = await start(createDemoAiApiHandler({ service }))

    const wrongType = await fetch(`${baseUrl}/api/ai/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(imagePayload()),
    })
    assert.equal(wrongType.status, 415)

    const url = new URL(`${baseUrl}/api/ai/analyze`)
    const request = createRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    request.on('error', () => {})
    request.end(JSON.stringify(imagePayload()))
    await startedPromise
    request.destroy()
    assert.match(String(await aborted), /disconnected/i)
  })
})
