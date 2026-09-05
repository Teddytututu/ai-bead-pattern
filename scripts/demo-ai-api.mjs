import {
  AIProviderRegistry,
  CompositeImageAnalyzer,
  HttpVisionProvider,
  RembgVisionProvider,
  modelManifest,
} from '../services/ai-gateway/dist/index.js'

const routeCapabilities = Object.freeze({
  deterministic: Object.freeze([]),
  'neural-analysis': Object.freeze(['subject-segmentation', 'edge-thin-structure']),
  'learned-pixelization': Object.freeze(['learned-pixelization']),
  'generative-proposal': Object.freeze(['generative-proposal']),
  'preference-scoring': Object.freeze(['embedding', 'preference-scoring']),
})

const maximumImageDimension = 2048
const defaultMaximumRequestBytes = 24 * 1024 * 1024
const defaultMaximumResponseBytes = 24 * 1024 * 1024

export const demoAiLimits = Object.freeze({
  maximumImageDimension,
  maximumRequestBytes: defaultMaximumRequestBytes,
  maximumResponseBytes: defaultMaximumResponseBytes,
})

function capabilitiesForRoute(route) {
  const capabilities = routeCapabilities[route]
  if (capabilities === undefined) throw new RangeError(`Unknown model route: ${route}`)
  return capabilities
}

function sameCapabilities(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((entry, index) => entry === expected[index])
}

function decodePixelImage(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Image payload must be an object')
  }
  const { width, height, rgbaBase64 } = value
  if (Number.isInteger(width) === false || Number.isInteger(height) === false
    || width <= 0 || height <= 0
    || width > maximumImageDimension || height > maximumImageDimension) {
    throw new RangeError('Image dimensions fall outside the demo limit')
  }
  if (typeof rgbaBase64 !== 'string' || rgbaBase64.length === 0
    || /^[A-Za-z0-9+/]*={0,2}$/.test(rgbaBase64) === false) {
    throw new TypeError('Image RGBA data must use Base64')
  }
  const bytes = Buffer.from(rgbaBase64, 'base64')
  if (bytes.length !== width * height * 4) {
    throw new RangeError('Image RGBA length differs from its dimensions')
  }
  return { width, height, data: new Uint8ClampedArray(bytes) }
}

function requestFromPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('AI request must be an object')
  }
  const capabilities = capabilitiesForRoute(payload.route)
  if (sameCapabilities(payload.capabilities, capabilities) === false) {
    throw new RangeError('AI request capabilities differ from the selected route')
  }
  return {
    route: payload.route,
    capabilities,
    image: decodePixelImage(payload.image),
    ...(payload.referenceImage === undefined ? {} : {
      referenceImage: decodePixelImage(payload.referenceImage),
    }),
    failureMode: 'best-effort',
    timeoutMs: payload.route === 'learned-pixelization' || payload.route === 'generative-proposal'
      ? 30 * 60_000
      : payload.route === 'preference-scoring' ? 120_000 : 30_000,
    ...(payload.targetGrid === undefined ? {} : { targetGrid: payload.targetGrid }),
    ...(payload.paletteId === undefined ? {} : { paletteId: payload.paletteId }),
    ...(payload.styleId === undefined ? {} : { styleId: payload.styleId }),
    ...(payload.prompt === undefined ? {} : { prompt: payload.prompt }),
    ...(payload.providerIds === undefined ? {} : { providerIds: payload.providerIds }),
    ...(payload.instancePrompt === undefined ? {} : { instancePrompt: payload.instancePrompt }),
    ...(payload.sourceId === undefined ? {} : { sourceId: payload.sourceId }),
    ...(payload.candidateId === undefined ? {} : { candidateId: payload.candidateId }),
    ...(payload.imageTypeHint === undefined ? {} : { imageTypeHint: payload.imageTypeHint }),
  }
}

function jsonReady(value) {
  if (ArrayBuffer.isView(value)) return Array.from(value)
  if (Array.isArray(value)) return value.map(jsonReady)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonReady(entry)]))
  }
  return value
}

function routeStatus(route, providers) {
  const capabilities = capabilitiesForRoute(route)
  if (capabilities.length === 0) return { available: true, status: 'ready', providers: [] }
  const covering = providers.filter((provider) =>
    capabilities.some((capability) => provider.capabilities.includes(capability)))
  const covered = new Set(covering
    .filter((provider) => provider.status !== 'unavailable')
    .flatMap((provider) => provider.capabilities))
  const available = capabilities.every((capability) => covered.has(capability))
  return {
    available,
    status: available
      ? covering.some((provider) => provider.status === 'degraded') ? 'degraded' : 'ready'
      : 'unavailable',
    providers: covering.map((provider) => provider.providerId),
  }
}

function automaticPetProviderPlan(request, registry) {
  if (request.route !== 'neural-analysis'
    || (request.imageTypeHint !== undefined && request.imageTypeHint !== 'pet')
    || request.providerIds !== undefined) return request
  const grounded = registry.get('grounded-sam2-local')
  const pose = registry.get('mmpose-animal-local')
  if (grounded === undefined || pose === undefined) return request
  const providerIds = [grounded.manifest.providerId, pose.manifest.providerId]
  const rembg = registry.get('rembg-birefnet-general-lite')
  if (rembg !== undefined) providerIds.push(rembg.manifest.providerId)
  return {
    ...request,
    capabilities: [...new Set([...request.capabilities, 'keypoints'])],
    providerIds,
  }
}

export function createDemoAiService(options = {}) {
  const registry = options.registry ?? new AIProviderRegistry()
  if (options.registry === undefined) {
    registry.register(new RembgVisionProvider(), 100)
    const sam2Endpoint = options.sam2Endpoint ?? process.env.SAM2_ENDPOINT
    if (typeof sam2Endpoint === 'string' && sam2Endpoint.trim().length > 0) {
      const sam2Manifest = modelManifest('sam2-local')
      registry.register(new HttpVisionProvider({
        manifest: sam2Manifest,
        endpoint: sam2Endpoint,
        timeoutMs: options.sam2TimeoutMs ?? sam2Manifest.failurePolicy.timeoutMs,
        ...(options.sam2Fetch === undefined ? {} : { fetch: options.sam2Fetch }),
      }), 95)
    }
    const groundedSam2Endpoint = options.groundedSam2Endpoint
      ?? process.env.GROUNDED_SAM2_ENDPOINT
      ?? sam2Endpoint
    if (typeof groundedSam2Endpoint === 'string' && groundedSam2Endpoint.trim().length > 0) {
      const groundedManifest = modelManifest('grounded-sam2-local')
      registry.register(new HttpVisionProvider({
        manifest: groundedManifest,
        endpoint: groundedSam2Endpoint,
        healthPath: '/health/grounded',
        timeoutMs: options.groundedSam2TimeoutMs ?? groundedManifest.failurePolicy.timeoutMs,
        ...((options.groundedSam2Fetch ?? options.sam2Fetch) === undefined
          ? {}
          : { fetch: options.groundedSam2Fetch ?? options.sam2Fetch }),
      }), 94)
    }
    const mmposeEndpoint = options.mmposeEndpoint ?? process.env.MMPOSE_ENDPOINT
    if (typeof mmposeEndpoint === 'string' && mmposeEndpoint.trim().length > 0) {
      const mmposeManifest = modelManifest('mmpose-animal-local')
      registry.register(new HttpVisionProvider({
        manifest: mmposeManifest,
        endpoint: mmposeEndpoint,
        timeoutMs: options.mmposeTimeoutMs ?? mmposeManifest.failurePolicy.timeoutMs,
        ...(options.mmposeFetch === undefined ? {} : { fetch: options.mmposeFetch }),
      }), 93)
    }
    const proposalEndpoint = options.proposalEndpoint ?? process.env.PIXEL_PROPOSAL_ENDPOINT
    if (typeof proposalEndpoint === 'string' && proposalEndpoint.trim().length > 0) {
      registry.register(new HttpVisionProvider({
        manifest: modelManifest('pixel-art-sprite-lcm-local'),
        endpoint: proposalEndpoint,
        timeoutMs: options.proposalProbeTimeoutMs ?? 10_000,
        ...(options.proposalFetch === undefined ? {} : { fetch: options.proposalFetch }),
      }), 90)
    }
    const dinov2Endpoint = options.dinov2Endpoint ?? process.env.DINOV2_ENDPOINT
    if (typeof dinov2Endpoint === 'string' && dinov2Endpoint.trim().length > 0) {
      const dinov2Manifest = modelManifest('dinov2-vits14-pair-local')
      registry.register(new HttpVisionProvider({
        manifest: dinov2Manifest,
        endpoint: dinov2Endpoint,
        timeoutMs: options.dinov2TimeoutMs ?? dinov2Manifest.failurePolicy.timeoutMs,
        ...(options.dinov2Fetch === undefined ? {} : { fetch: options.dinov2Fetch }),
      }), 85)
    }
    const openclipEndpoint = options.openclipEndpoint ?? process.env.OPENCLIP_ENDPOINT
    if (typeof openclipEndpoint === 'string' && openclipEndpoint.trim().length > 0) {
      const openclipManifest = modelManifest('openclip-vit-b32-pair-local')
      registry.register(new HttpVisionProvider({
        manifest: openclipManifest,
        endpoint: openclipEndpoint,
        timeoutMs: options.openclipTimeoutMs ?? openclipManifest.failurePolicy.timeoutMs,
        ...(options.openclipFetch === undefined ? {} : { fetch: options.openclipFetch }),
      }), 84)
    }
  }
  const analyzer = new CompositeImageAnalyzer(registry)

  return {
    async health(signal) {
      const providers = await Promise.all(registry.list().map(async (provider) => {
        const health = await provider.probe(signal)
        return {
          providerId: provider.manifest.providerId,
          modelId: provider.manifest.modelId,
          modelVersion: provider.manifest.modelVersion,
          sourceRevision: provider.manifest.sourceRevision,
          weightRevision: provider.manifest.weightRevision,
          license: provider.manifest.weightLicense?.spdx ?? provider.manifest.license.spdx,
          capabilities: provider.manifest.capabilities,
          status: health.status,
          latencyMs: health.latencyMs,
          checkedAt: health.checkedAt,
          ...(health.message === undefined ? {} : { message: health.message }),
        }
      }))
      return {
        providers,
        routes: Object.fromEntries(Object.keys(routeCapabilities)
          .map((route) => [route, routeStatus(route, providers)])),
      }
    },

    async analyze(payload, signal) {
      const request = automaticPetProviderPlan(requestFromPayload(payload), registry)
      const result = await analyzer.analyze({ ...request, signal })
      return jsonReady({
        ...result,
        status: result.uncoveredCapabilities.length === 0
          && result.contributions.some((entry) => entry.status === 'failed') === false
          ? 'ready'
          : result.contributions.some((entry) => entry.status === 'used')
            ? 'degraded'
            : 'unavailable',
      })
    },
  }
}

function sendJson(response, statusCode, value, maximumResponseBytes) {
  if (response.destroyed) return
  const body = JSON.stringify(value)
  if (Buffer.byteLength(body) > maximumResponseBytes) {
    const fallback = JSON.stringify({ error: 'AI response exceeded the demo limit' })
    response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(fallback)
    return
  }
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

async function readJson(request, maximumRequestBytes) {
  let total = 0
  const chunks = []
  for await (const chunk of request) {
    total += chunk.length
    if (total > maximumRequestBytes) {
      const error = new RangeError('AI request exceeded the demo limit')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) throw new TypeError('AI request body is empty')
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function createDemoAiApiHandler(options = {}) {
  const service = options.service ?? createDemoAiService()
  const maximumRequestBytes = options.maximumRequestBytes ?? defaultMaximumRequestBytes
  const maximumResponseBytes = options.maximumResponseBytes ?? defaultMaximumResponseBytes

  return async function demoAiApiHandler(request, response) {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    const controller = new AbortController()
    const clientDisconnected = () => controller.abort(new Error('Client disconnected'))
    const responseClosed = () => {
      if (response.writableEnded === false) clientDisconnected()
    }
    request.once('aborted', clientDisconnected)
    response.once('close', responseClosed)
    try {
      if (request.method === 'GET' && requestUrl.pathname === '/api/ai/health') {
        sendJson(response, 200, await service.health(controller.signal), maximumResponseBytes)
        return true
      }
      const endpoint = requestUrl.pathname === '/api/ai/analyze'
        ? 'analyze'
        : requestUrl.pathname === '/api/ai/proposals' ? 'proposals' : undefined
      if (request.method !== 'POST' || endpoint === undefined) return false
      const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') {
        const error = new TypeError('AI POST requests require application/json')
        error.statusCode = 415
        throw error
      }
      const payload = await readJson(request, maximumRequestBytes)
      const route = payload?.route
      if (endpoint === 'analyze'
        && route !== 'neural-analysis'
        && route !== 'deterministic'
        && route !== 'preference-scoring') {
        throw new RangeError('Analysis endpoint requires an analysis route')
      }
      if (endpoint === 'proposals'
        && route !== 'learned-pixelization' && route !== 'generative-proposal') {
        throw new RangeError('Proposal endpoint requires a proposal route')
      }
      sendJson(response, 200, await service.analyze(payload, controller.signal), maximumResponseBytes)
      return true
    } catch (error) {
      if (response.destroyed) return true
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 400
      sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : String(error),
      }, maximumResponseBytes)
      return true
    } finally {
      request.removeListener('aborted', clientDisconnected)
      response.removeListener('close', responseClosed)
    }
  }
}
