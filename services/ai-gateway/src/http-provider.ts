import type { PixelImage } from '@ai-bead-pattern/pattern-core'
import sharp from 'sharp'

import type { AICapability, ModelManifest } from './model-catalog.js'
import { validateModelManifest } from './model-catalog.js'
import {
  hydrateImageAnalysis,
  hydrateInstanceProposal,
  hydrateProposalSourceFrame,
  type AIModelProvider,
  type LearnedProposal,
  type ModelProviderRequest,
  type ModelProviderResult,
  type PreferenceFeatures,
  type RegionalPreferenceComparison,
  type ProviderHealth,
  validateLearnedProposal,
  validatePreferenceFeatures,
  validateProviderRequest,
  validateProviderResult,
} from './provider-contract.js'

export interface HttpVisionProviderOptions {
  manifest: ModelManifest
  endpoint: string
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  maximumResponseBytes?: number
  analyzePath?: string
  healthPath?: string
}

interface WireIdentity {
  modelId: string
  modelVersion: string
  sourceRevision: string
  weightRevision: string
}

const schemaVersion = 'ai-gateway-provider-v1'

function normalizedEndpoint(value: string): string {
  const url = new URL(value)
  if (url.username.length > 0 || url.password.length > 0) {
    throw new RangeError('Vision provider credentials must use deployment secrets')
  }
  if (url.protocol !== 'https:'
    && (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost'))) {
    throw new RangeError('Vision provider endpoint must use HTTPS or loopback HTTP')
  }
  return url.toString().replace(/\/$/, '')
}

function normalizedPath(value: string, label: string): string {
  if (value.startsWith('/') === false || value.includes('://')) {
    throw new RangeError(`${label} must be an absolute URL path`)
  }
  return value
}

function positive(value: number, label: string): number {
  if (Number.isFinite(value) === false || value <= 0) {
    throw new RangeError(`${label} must be a finite positive number`)
  }
  return value
}

async function encodePng(image: PixelImage): Promise<Buffer> {
  return sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: 4 },
  }).png().toBuffer()
}

async function readResponseBytes(response: Response, limit: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new Error('Vision provider response exceeds the response limit')
  }
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > limit) throw new Error('Vision provider response exceeds the response limit')
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    total += next.value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new Error('Vision provider response exceeds the response limit')
    }
    chunks.push(next.value)
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function boundedServerMessage(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\s+/g, ' ').trim().slice(0, 500)
}

function objectValue(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || Number.isFinite(value) === false) {
    throw new TypeError(`${label} must be finite`)
  }
  return value
}

function unit(value: unknown, label: string): number {
  const parsed = finite(value, label)
  if (parsed < 0 || parsed > 1) throw new RangeError(`${label} must stay within 0..1`)
  return parsed
}

function identity(value: unknown): WireIdentity {
  const input = objectValue(value, 'Provider model identity')
  return {
    modelId: nonEmpty(input.modelId, 'Provider model id'),
    modelVersion: nonEmpty(input.modelVersion, 'Provider model version'),
    sourceRevision: nonEmpty(input.sourceRevision, 'Provider source revision'),
    weightRevision: nonEmpty(input.weightRevision, 'Provider weight revision'),
  }
}

function assertIdentity(value: WireIdentity, manifest: ModelManifest): void {
  if (value.modelId !== manifest.modelId
    || value.modelVersion !== manifest.modelVersion
    || value.sourceRevision !== manifest.sourceRevision
    || value.weightRevision !== manifest.weightRevision) {
    throw new RangeError('Vision provider model identity differs from the pinned manifest')
  }
}

function capabilityList(value: unknown, manifest: ModelManifest): readonly AICapability[] {
  if (Array.isArray(value) === false || value.length === 0) {
    throw new TypeError('Provider capabilities must be a non-empty array')
  }
  const entries = value.map((entry, index) => nonEmpty(entry, `Provider capabilities[${index}]`) as AICapability)
  if (new Set(entries).size !== entries.length
    || entries.some((entry) => manifest.capabilities.includes(entry) === false)) {
    throw new RangeError('Provider capabilities differ from the manifest')
  }
  return entries
}

function decodeRgba(value: unknown, width: number, height: number): Uint8ClampedArray {
  const encoded = nonEmpty(value, 'Learned proposal RGBA payload')
  if (/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) === false) {
    throw new RangeError('Learned proposal RGBA payload must use base64')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== width * height * 4) {
    throw new RangeError('Learned proposal RGBA length differs from dimensions')
  }
  return new Uint8ClampedArray(bytes)
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : nonEmpty(value, label)
}

function hydrateProposal(
  value: unknown,
  modelId: string,
  index: number,
  sourceImage: PixelImage,
): LearnedProposal {
  const input = objectValue(value, `learnedProposals[${index}]`)
  const image = objectValue(input.image, `learnedProposals[${index}].image`)
  const width = finite(image.width, `learnedProposals[${index}].image.width`)
  const height = finite(image.height, `learnedProposals[${index}].image.height`)
  if (Number.isInteger(width) === false || Number.isInteger(height) === false || width <= 0 || height <= 0
    || width * height > 4_000_000) {
    throw new RangeError(`learnedProposals[${index}].image dimensions are invalid`)
  }
  const kind = nonEmpty(input.kind, `learnedProposals[${index}].kind`)
  if (kind !== 'learned-pixelization' && kind !== 'generative-proposal') {
    throw new RangeError(`learnedProposals[${index}].kind is invalid`)
  }
  let targetGrid: LearnedProposal['targetGrid']
  if (input.targetGrid !== undefined) {
    const grid = objectValue(input.targetGrid, `learnedProposals[${index}].targetGrid`)
    const gridWidth = finite(grid.width, `learnedProposals[${index}].targetGrid.width`)
    const gridHeight = finite(grid.height, `learnedProposals[${index}].targetGrid.height`)
    if (Number.isInteger(gridWidth) === false || Number.isInteger(gridHeight) === false
      || gridWidth <= 0 || gridHeight <= 0) {
      throw new RangeError(`learnedProposals[${index}].targetGrid is invalid`)
    }
    targetGrid = { width: gridWidth, height: gridHeight }
  }
  const seed = input.seed === undefined ? undefined : finite(input.seed, `learnedProposals[${index}].seed`)
  if (seed !== undefined && Number.isInteger(seed) === false) {
    throw new RangeError(`learnedProposals[${index}].seed must be an integer`)
  }
  const paletteId = optionalString(input.paletteId, `learnedProposals[${index}].paletteId`)
  const styleId = optionalString(input.styleId, `learnedProposals[${index}].styleId`)
  const proposalImage = {
    width,
    height,
    data: decodeRgba(image.rgbaBase64, width, height),
  }
  const proposal: LearnedProposal = {
    id: nonEmpty(input.id, `learnedProposals[${index}].id`),
    kind,
    image: proposalImage,
    confidence: unit(input.confidence, `learnedProposals[${index}].confidence`),
    modelId,
    ...(targetGrid === undefined ? {} : { targetGrid }),
    ...(paletteId === undefined ? {} : { paletteId }),
    ...(styleId === undefined ? {} : { styleId }),
    ...(seed === undefined ? {} : { seed }),
    sourceFrame: hydrateProposalSourceFrame(input.sourceFrame, proposalImage, sourceImage),
  }
  validateLearnedProposal(proposal, sourceImage)
  return proposal
}

function hydrateFeatures(value: unknown, modelId: string): PreferenceFeatures {
  const input = objectValue(value, 'preferenceFeatures')
  if (Array.isArray(input.names) === false || Array.isArray(input.values) === false) {
    throw new TypeError('Preference feature names and values must be arrays')
  }
  const names = input.names.map((entry, index) => nonEmpty(entry, `preferenceFeatures.names[${index}]`))
  const values = new Float32Array(input.values.length)
  for (let index = 0; index < values.length; index += 1) {
    values[index] = finite(input.values[index], `preferenceFeatures.values[${index}]`)
  }
  const scopeValue = optionalString(input.scope, 'preferenceFeatures.scope')
  if (scopeValue !== undefined && scopeValue !== 'source' && scopeValue !== 'candidate' && scopeValue !== 'pair') {
    throw new RangeError('Preference feature scope is invalid')
  }
  const candidateId = optionalString(input.candidateId, 'preferenceFeatures.candidateId')
  let regionalComparisons: readonly RegionalPreferenceComparison[] | undefined
  if (input.regionalComparisons !== undefined) {
    if (Array.isArray(input.regionalComparisons) === false || input.regionalComparisons.length > 16) {
      throw new RangeError('preferenceFeatures.regionalComparisons must be a bounded array')
    }
    regionalComparisons = input.regionalComparisons.map((entry, index) => {
      const comparison = objectValue(entry, `preferenceFeatures.regionalComparisons[${index}]`)
      const view = nonEmpty(
        comparison.view,
        `preferenceFeatures.regionalComparisons[${index}].view`,
      )
      if (view !== 'global' && view !== 'subject' && view !== 'head' && view !== 'critical-local') {
        throw new RangeError(`preferenceFeatures.regionalComparisons[${index}].view is invalid`)
      }
      return {
        view,
        identitySimilarity: unit(
          comparison.identitySimilarity,
          `preferenceFeatures.regionalComparisons[${index}].identitySimilarity`,
        ),
        patchCorrespondence: unit(
          comparison.patchCorrespondence,
          `preferenceFeatures.regionalComparisons[${index}].patchCorrespondence`,
        ),
        criticalPatchRetention: unit(
          comparison.criticalPatchRetention,
          `preferenceFeatures.regionalComparisons[${index}].criticalPatchRetention`,
        ),
        regionalCoverage: unit(
          comparison.regionalCoverage,
          `preferenceFeatures.regionalComparisons[${index}].regionalCoverage`,
        ),
        confidence: unit(
          comparison.confidence,
          `preferenceFeatures.regionalComparisons[${index}].confidence`,
        ),
      }
    })
  }
  const result: PreferenceFeatures = {
    modelId,
    names,
    values,
    confidence: unit(input.confidence, 'preferenceFeatures.confidence'),
    ...(scopeValue === undefined ? {} : { scope: scopeValue }),
    ...(candidateId === undefined ? {} : { candidateId }),
    ...(regionalComparisons === undefined ? {} : { regionalComparisons }),
  }
  validatePreferenceFeatures(result)
  return result
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error(`${label} returned malformed JSON`)
  }
}

function warnings(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value) === false || value.length > 100) {
    throw new RangeError('Provider warnings must be a bounded array')
  }
  return value.map((entry, index) => nonEmpty(entry, `Provider warnings[${index}]`).slice(0, 500))
}

export class HttpVisionProvider implements AIModelProvider {
  readonly manifest: ModelManifest
  readonly #endpoint: string
  readonly #fetch: typeof globalThis.fetch
  readonly #timeoutMs: number
  readonly #maximumResponseBytes: number
  readonly #analyzePath: string
  readonly #healthPath: string

  constructor(options: HttpVisionProviderOptions) {
    validateModelManifest(options.manifest)
    this.manifest = options.manifest
    this.#endpoint = normalizedEndpoint(options.endpoint)
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#timeoutMs = positive(options.timeoutMs ?? options.manifest.failurePolicy.timeoutMs, 'Vision timeout')
    if (this.#timeoutMs > options.manifest.failurePolicy.timeoutMs) {
      throw new RangeError('Vision timeout must stay within the model manifest')
    }
    this.#maximumResponseBytes = positive(
      options.maximumResponseBytes ?? options.manifest.failurePolicy.maximumResponseBytes,
      'Vision response limit',
    )
    if (this.#maximumResponseBytes > options.manifest.failurePolicy.maximumResponseBytes) {
      throw new RangeError('Vision response limit must stay within the model manifest')
    }
    this.#analyzePath = normalizedPath(options.analyzePath ?? '/v1/analyze', 'Vision analyze path')
    this.#healthPath = normalizedPath(options.healthPath ?? '/health', 'Vision health path')
  }

  async analyze(request: ModelProviderRequest): Promise<ModelProviderResult> {
    validateProviderRequest(request, this.manifest)
    request.signal?.throwIfAborted()
    const [image, referenceImage] = await Promise.all([
      encodePng(request.image),
      request.referenceImage === undefined ? Promise.resolve(undefined) : encodePng(request.referenceImage),
    ])
    request.signal?.throwIfAborted()
    const form = new FormData()
    form.append('image', new Blob([Uint8Array.from(image)], { type: 'image/png' }), 'input.png')
    if (referenceImage !== undefined) {
      form.append(
        'referenceImage',
        new Blob([Uint8Array.from(referenceImage)], { type: 'image/png' }),
        'reference.png',
      )
    }
    form.append('request', JSON.stringify({
      schemaVersion,
      capabilities: request.capabilities,
      model: {
        modelId: this.manifest.modelId,
        modelVersion: this.manifest.modelVersion,
        sourceRevision: this.manifest.sourceRevision,
        weightRevision: this.manifest.weightRevision,
      },
      ...(request.targetGrid === undefined ? {} : { targetGrid: request.targetGrid }),
      ...(request.paletteId === undefined ? {} : { paletteId: request.paletteId }),
      ...(request.styleId === undefined ? {} : { styleId: request.styleId }),
      ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
      ...(request.imageTypeHint === undefined ? {} : { imageTypeHint: request.imageTypeHint }),
      ...(request.instancePrompt === undefined ? {} : { instancePrompt: request.instancePrompt }),
      ...(request.instancePrompts === undefined ? {} : { instancePrompts: request.instancePrompts }),
      ...(request.sourceId === undefined ? {} : { sourceId: request.sourceId }),
      ...(request.candidateId === undefined ? {} : { candidateId: request.candidateId }),
    }))
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', forwardAbort, { once: true })
    const timeoutMs = request.timeoutMs ?? this.#timeoutMs
    const timeout = setTimeout(() => controller.abort(new Error('Vision provider request timed out')), timeoutMs)
    const startedAt = performance.now()
    try {
      const response = await this.#fetch(`${this.#endpoint}${this.#analyzePath}`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      })
      const bytes = await readResponseBytes(response, this.#maximumResponseBytes)
      if (response.ok === false) {
        const message = boundedServerMessage(bytes)
        throw new Error(`Vision provider returned ${response.status}${message.length === 0 ? '' : `: ${message}`}`)
      }
      const input = objectValue(parseJson(bytes, 'Vision provider'), 'Vision provider response')
      if (input.schemaVersion !== schemaVersion) throw new RangeError('Vision provider schema version is unsupported')
      if (nonEmpty(input.providerId, 'Vision provider id') !== this.manifest.providerId) {
        throw new RangeError('Vision provider id differs from the manifest')
      }
      assertIdentity(identity(input.model), this.manifest)
      const responseCapabilities = capabilityList(input.capabilities, this.manifest)
      if (responseCapabilities.some((capability) => request.capabilities.includes(capability) === false)) {
        throw new RangeError('Vision provider returned an unrequested capability')
      }
      const proposalValues = input.learnedProposals === undefined ? [] : input.learnedProposals
      if (Array.isArray(proposalValues) === false || proposalValues.length > 32) {
        throw new RangeError('Vision provider learned proposals must be a bounded array')
      }
      const instanceValues = input.instanceProposals === undefined ? [] : input.instanceProposals
      if (Array.isArray(instanceValues) === false || instanceValues.length > 64) {
        throw new RangeError('Vision provider instance proposals must be a bounded array')
      }
      const warningValues = warnings(input.warnings)
      const result: ModelProviderResult = {
        providerId: this.manifest.providerId,
        model: this.manifest,
        capabilities: responseCapabilities,
        confidence: unit(input.confidence, 'Vision provider confidence'),
        elapsedMs: Math.max(0, performance.now() - startedAt),
        ...(input.analysis === undefined ? {} : { analysis: hydrateImageAnalysis(input.analysis) }),
        ...(instanceValues.length === 0 ? {} : {
          instanceProposals: instanceValues.map((entry, index) =>
            hydrateInstanceProposal(entry, request.image, index),
          ),
        }),
        ...(proposalValues.length === 0 ? {} : {
          learnedProposals: proposalValues.map((entry, index) =>
            hydrateProposal(entry, this.manifest.modelId, index, request.image),
          ),
        }),
        ...(input.preferenceFeatures === undefined ? {} : {
          preferenceFeatures: hydrateFeatures(input.preferenceFeatures, this.manifest.modelId),
        }),
        ...(warningValues === undefined ? {} : { warnings: warningValues }),
      }
      validateProviderResult(result, this, request.capabilities, request.image, request)
      return result
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', forwardAbort)
    }
  }

  async probe(signal?: AbortSignal): Promise<ProviderHealth> {
    signal?.throwIfAborted()
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', forwardAbort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error('Vision provider probe timed out')), this.#timeoutMs)
    const startedAt = performance.now()
    try {
      const response = await this.#fetch(`${this.#endpoint}${this.#healthPath}`, {
        method: 'GET',
        signal: controller.signal,
      })
      const bytes = await readResponseBytes(response, Math.min(this.#maximumResponseBytes, 64 * 1024))
      if (response.ok === false) {
        return {
          status: 'unavailable',
          checkedAt: Date.now(),
          latencyMs: Math.max(0, performance.now() - startedAt),
          model: this.manifest,
          message: `HTTP ${response.status}`,
        }
      }
      const input = objectValue(parseJson(bytes, 'Vision provider health probe'), 'Vision provider health')
      const status = nonEmpty(input.status, 'Vision provider health status')
      if (status !== 'ready' && status !== 'degraded' && status !== 'unavailable') {
        throw new RangeError('Vision provider health status is invalid')
      }
      assertIdentity(identity(input.model), this.manifest)
      const message = optionalString(input.message, 'Vision provider health message')
      return {
        status,
        checkedAt: Date.now(),
        latencyMs: Math.max(0, performance.now() - startedAt),
        model: this.manifest,
        ...(message === undefined ? {} : { message: message.slice(0, 500) }),
      }
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', forwardAbort)
    }
  }
}
