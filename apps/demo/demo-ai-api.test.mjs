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
