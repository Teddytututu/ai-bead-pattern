import type {
  BinaryMask,
  EvidenceOrigin,
  EvidenceProvenance,
  ImageAnalysis,
  ImageLandmark,
  ImageType,
  LandmarkKind,
  LandmarkPriority,
  PixelImage,
  SemanticRegion,
  SubjectMaskEvidence,
  SubjectMaskSource,
} from '@ai-bead-pattern/pattern-core'

import { fuseImageAnalyses } from './analysis-fusion.js'
import {
  type AICapability,
  type ModelManifest,
  validateModelManifest,
} from './model-catalog.js'

export type ModelRoute =
  | 'deterministic'
  | 'neural-analysis'
  | 'learned-pixelization'
  | 'generative-proposal'

export interface ModelProviderRequest {
  image: PixelImage
  capabilities: readonly AICapability[]
  signal?: AbortSignal
  timeoutMs?: number
  targetGrid?: Readonly<{ width: number; height: number }>
  paletteId?: string
  styleId?: string
  prompt?: string
  sourceId?: string
}

export interface LearnedProposal {
  id: string
  kind: 'learned-pixelization' | 'generative-proposal'
  image: PixelImage
  confidence: number
  modelId: string
  targetGrid?: Readonly<{ width: number; height: number }>
  paletteId?: string
  styleId?: string
  seed?: number
}

export interface PreferenceFeatures {
  modelId: string
  names: readonly string[]
  values: Float32Array
  confidence: number
  scope?: 'source' | 'candidate' | 'pair'
  candidateId?: string
}

export interface ModelProviderResult {
  providerId: string
  model: ModelManifest
  capabilities: readonly AICapability[]
  confidence: number
  elapsedMs: number
  analysis?: ImageAnalysis
  learnedProposals?: readonly LearnedProposal[]
  preferenceFeatures?: PreferenceFeatures
  warnings?: readonly string[]
}

export type ProviderHealthStatus = 'ready' | 'degraded' | 'unavailable'

export interface ProviderHealth {
  status: ProviderHealthStatus
  checkedAt: number
  latencyMs: number
  model: ModelManifest
  message?: string
}

export interface AIModelProvider {
  readonly manifest: ModelManifest
  analyze(request: ModelProviderRequest): Promise<ModelProviderResult>
  probe(signal?: AbortSignal): Promise<ProviderHealth>
}

export interface CompositeAnalysisRequest extends ModelProviderRequest {
  route: ModelRoute
  failureMode?: 'strict' | 'best-effort'
  providerIds?: readonly string[]
}

export interface ProviderContribution {
  providerId: string
  modelId: string
  capabilities: readonly AICapability[]
  status: 'used' | 'failed'
  confidence?: number
  elapsedMs: number
  message?: string
}

export interface CompositeAnalysisResult {
  route: ModelRoute
  analysis: ImageAnalysis
  learnedProposals: readonly LearnedProposal[]
  preferenceFeatures: readonly PreferenceFeatures[]
  contributions: readonly ProviderContribution[]
  uncoveredCapabilities: readonly AICapability[]
}

const imageTypes = new Set<ImageType>(['portrait', 'pet', 'illustration', 'landscape', 'general'])
const evidenceOrigins = new Set<EvidenceOrigin>(['model', 'source', 'heuristic', 'manual', 'fused'])
const subjectSources = new Set<SubjectMaskSource>([
  'ai',
  'alpha',
  'heuristic',
  'manual',
  'ai+manual',
  'fused',
  'legacy',
])
const landmarkKinds = new Set<LandmarkKind>([
  'eye',
  'mouth',
  'nose',
  'ear',
  'face-contour',
  'body',
  'identity-mark',
  'custom',
])
const landmarkPriorities = new Set<LandmarkPriority>(['hard', 'soft'])

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
}

function stringValue(value: unknown, label: string): string {
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

function finitePositive(value: unknown, label: string): number {
  const parsed = finite(value, label)
  if (parsed <= 0) throw new RangeError(`${label} must be positive`)
  return parsed
}

function integerPositive(value: unknown, label: string): number {
  const parsed = finitePositive(value, label)
  if (Number.isInteger(parsed) === false) throw new RangeError(`${label} must be an integer`)
  return parsed
}

function unit(value: unknown, label: string): number {
  const parsed = finite(value, label)
  if (parsed < 0 || parsed > 1) throw new RangeError(`${label} must stay within 0..1`)
  return parsed
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, label)
}

function numericArray(value: unknown, expectedLength: number, label: string): Float32Array {
  if (Array.isArray(value) === false) throw new TypeError(`${label} must be an array`)
  if (value.length !== expectedLength) throw new RangeError(`${label} length differs from dimensions`)
  const result = new Float32Array(expectedLength)
  for (let index = 0; index < expectedLength; index += 1) {
    result[index] = unit(value[index], `${label}[${index}]`)
  }
  return result
}

function hydrateMask(value: unknown, label: string): BinaryMask {
  const input = record(value, label)
  const width = integerPositive(input.width, `${label}.width`)
  const height = integerPositive(input.height, `${label}.height`)
  return {
    width,
    height,
    values: numericArray(input.values, width * height, `${label}.values`),
  }
}

function hydrateProvenance(value: unknown, label: string): readonly EvidenceProvenance[] | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value) === false) throw new TypeError(`${label} must be an array`)
  return value.map((entry, index) => {
    const input = record(entry, `${label}[${index}]`)
    const origin = stringValue(input.origin, `${label}[${index}].origin`) as EvidenceOrigin
    if (evidenceOrigins.has(origin) === false) throw new RangeError(`${label}[${index}].origin is invalid`)
    const model = optionalString(input.model, `${label}[${index}].model`)
    const version = optionalString(input.version, `${label}[${index}].version`)
    return {
      origin,
      provider: stringValue(input.provider, `${label}[${index}].provider`),
      ...(model === undefined ? {} : { model }),
      ...(version === undefined ? {} : { version }),
    }
  })
}

function hydrateSubjectEvidence(value: unknown): SubjectMaskEvidence {
  const input = record(value, 'analysis.subjectMaskEvidence')
  const source = stringValue(input.source, 'analysis.subjectMaskEvidence.source') as SubjectMaskSource
  if (subjectSources.has(source) === false) throw new RangeError('analysis.subjectMaskEvidence.source is invalid')
  const provenance = hydrateProvenance(input.provenance, 'analysis.subjectMaskEvidence.provenance')
  if (input.userConfirmed !== undefined && typeof input.userConfirmed !== 'boolean') {
    throw new TypeError('analysis.subjectMaskEvidence.userConfirmed must be boolean')
  }
  return {
    mask: hydrateMask(input.mask, 'analysis.subjectMaskEvidence.mask'),
    confidence: unit(input.confidence, 'analysis.subjectMaskEvidence.confidence'),
    source,
    revision: stringValue(input.revision, 'analysis.subjectMaskEvidence.revision'),
    ...(input.userConfirmed === undefined ? {} : { userConfirmed: input.userConfirmed }),
    ...(provenance === undefined ? {} : { provenance }),
  }
}

function hydrateSemanticRegions(value: unknown): readonly SemanticRegion[] | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value) === false) throw new TypeError('analysis.semanticRegions must be an array')
  const ids = new Set<string>()
  return value.map((entry, index) => {
    const input = record(entry, `analysis.semanticRegions[${index}]`)
    const id = stringValue(input.id, `analysis.semanticRegions[${index}].id`)
    if (ids.has(id)) throw new RangeError('analysis.semanticRegions ids must be unique')
    ids.add(id)
    const importance = input.importance === undefined
      ? undefined
      : unit(input.importance, `analysis.semanticRegions[${index}].importance`)
    const provenance = hydrateProvenance(
      input.provenance,
      `analysis.semanticRegions[${index}].provenance`,
    )
    return {
      id,
      label: stringValue(input.label, `analysis.semanticRegions[${index}].label`),
      mask: hydrateMask(input.mask, `analysis.semanticRegions[${index}].mask`),
      confidence: unit(input.confidence, `analysis.semanticRegions[${index}].confidence`),
      ...(importance === undefined ? {} : { importance }),
      ...(provenance === undefined ? {} : { provenance }),
    }
  })
}

function hydrateLandmarks(value: unknown): readonly ImageLandmark[] | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value) === false) throw new TypeError('analysis.landmarks must be an array')
  const ids = new Set<string>()
  return value.map((entry, index) => {
    const input = record(entry, `analysis.landmarks[${index}]`)
    const id = stringValue(input.id, `analysis.landmarks[${index}].id`)
    if (ids.has(id)) throw new RangeError('analysis.landmarks ids must be unique')
    ids.add(id)
    const kind = stringValue(input.kind, `analysis.landmarks[${index}].kind`) as LandmarkKind
    if (landmarkKinds.has(kind) === false) throw new RangeError(`analysis.landmarks[${index}].kind is invalid`)
    const priority = stringValue(
      input.priority,
      `analysis.landmarks[${index}].priority`,
    ) as LandmarkPriority
    if (landmarkPriorities.has(priority) === false) {
      throw new RangeError(`analysis.landmarks[${index}].priority is invalid`)
    }
    const provenance = hydrateProvenance(input.provenance, `analysis.landmarks[${index}].provenance`)
    const sourceRadiusPx = input.sourceRadiusPx === undefined
      ? undefined
      : finitePositive(input.sourceRadiusPx, `analysis.landmarks[${index}].sourceRadiusPx`)
    const gridRadiusCells = input.gridRadiusCells === undefined
      ? undefined
      : finitePositive(input.gridRadiusCells, `analysis.landmarks[${index}].gridRadiusCells`)
    const symmetryGroup = optionalString(input.symmetryGroup, `analysis.landmarks[${index}].symmetryGroup`)
    const featureRegionId = optionalString(input.featureRegionId, `analysis.landmarks[${index}].featureRegionId`)
    const carrierRegionId = optionalString(input.carrierRegionId, `analysis.landmarks[${index}].carrierRegionId`)
    if (input.affectsOccupancy !== undefined && typeof input.affectsOccupancy !== 'boolean') {
      throw new TypeError(`analysis.landmarks[${index}].affectsOccupancy must be boolean`)
    }
    return {
      id,
      kind,
      x: finite(input.x, `analysis.landmarks[${index}].x`),
      y: finite(input.y, `analysis.landmarks[${index}].y`),
      confidence: unit(input.confidence, `analysis.landmarks[${index}].confidence`),
      priority,
      ...(sourceRadiusPx === undefined ? {} : { sourceRadiusPx }),
      ...(gridRadiusCells === undefined ? {} : { gridRadiusCells }),
      ...(symmetryGroup === undefined ? {} : { symmetryGroup }),
      ...(featureRegionId === undefined ? {} : { featureRegionId }),
      ...(carrierRegionId === undefined ? {} : { carrierRegionId }),
      ...(input.affectsOccupancy === undefined ? {} : { affectsOccupancy: input.affectsOccupancy }),
      ...(provenance === undefined ? {} : { provenance }),
    }
  })
}

export function hydrateImageAnalysis(value: unknown): ImageAnalysis {
  const input = record(value, 'analysis')
  const subjectMask = input.subjectMask === undefined
    ? undefined
    : hydrateMask(input.subjectMask, 'analysis.subjectMask')
  const subjectMaskEvidence = input.subjectMaskEvidence === undefined
    ? undefined
    : hydrateSubjectEvidence(input.subjectMaskEvidence)
  const semanticRegions = hydrateSemanticRegions(input.semanticRegions)
  const landmarks = hydrateLandmarks(input.landmarks)
  let importanceMap: ImageAnalysis['importanceMap']
  if (input.importanceMap !== undefined) {
    const map = record(input.importanceMap, 'analysis.importanceMap')
    const width = integerPositive(map.width, 'analysis.importanceMap.width')
    const height = integerPositive(map.height, 'analysis.importanceMap.height')
    importanceMap = {
      width,
      height,
      weights: numericArray(map.weights, width * height, 'analysis.importanceMap.weights'),
    }
  }
  let suggestedCrop: ImageAnalysis['suggestedCrop']
  if (input.suggestedCrop !== undefined) {
    const crop = record(input.suggestedCrop, 'analysis.suggestedCrop')
    suggestedCrop = {
      x: finite(crop.x, 'analysis.suggestedCrop.x'),
      y: finite(crop.y, 'analysis.suggestedCrop.y'),
      width: finitePositive(crop.width, 'analysis.suggestedCrop.width'),
      height: finitePositive(crop.height, 'analysis.suggestedCrop.height'),
    }
  }
  const imageType = input.imageType === undefined
    ? undefined
    : stringValue(input.imageType, 'analysis.imageType') as ImageType
  if (imageType !== undefined && imageTypes.has(imageType) === false) {
    throw new RangeError('analysis.imageType is invalid')
  }
  const confidence = input.confidence === undefined ? undefined : unit(input.confidence, 'analysis.confidence')
  let modelVersions: Readonly<Record<string, string>> | undefined
  if (input.modelVersions !== undefined) {
    const entries = record(input.modelVersions, 'analysis.modelVersions')
    modelVersions = Object.fromEntries(Object.entries(entries).map(([key, entry]) => [
      stringValue(key, 'analysis.modelVersions key'),
      stringValue(entry, `analysis.modelVersions.${key}`),
    ]))
  }
  const provenance = hydrateProvenance(input.provenance, 'analysis.provenance')
  const suggestedCropConfidence = input.suggestedCropConfidence === undefined
    ? undefined
    : unit(input.suggestedCropConfidence, 'analysis.suggestedCropConfidence')
  let suggestedCropSource: ImageAnalysis['suggestedCropSource']
  if (input.suggestedCropSource !== undefined) {
    const value = stringValue(input.suggestedCropSource, 'analysis.suggestedCropSource')
    if (value !== 'automatic' && value !== 'manual') {
      throw new RangeError('analysis.suggestedCropSource is invalid')
    }
    suggestedCropSource = value
  }
  return {
    ...(subjectMask === undefined ? {} : { subjectMask }),
    ...(subjectMaskEvidence === undefined ? {} : { subjectMaskEvidence }),
    ...(semanticRegions === undefined ? {} : { semanticRegions }),
    ...(landmarks === undefined ? {} : { landmarks }),
    ...(importanceMap === undefined ? {} : { importanceMap }),
    ...(suggestedCrop === undefined ? {} : { suggestedCrop }),
    ...(suggestedCropConfidence === undefined ? {} : { suggestedCropConfidence }),
    ...(suggestedCropSource === undefined ? {} : { suggestedCropSource }),
    ...(imageType === undefined ? {} : { imageType }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(modelVersions === undefined ? {} : { modelVersions }),
    ...(provenance === undefined ? {} : { provenance }),
  }
}

export function validateProviderRequest(
  request: ModelProviderRequest,
  manifest: ModelManifest,
): void {
  validateModelManifest(manifest)
  const { image } = request
  if (Number.isInteger(image.width) === false || Number.isInteger(image.height) === false
    || image.width <= 0 || image.height <= 0
    || image.data.length !== image.width * image.height * 4) {
    throw new RangeError('Provider image must contain valid RGBA dimensions')
  }
  if (image.width < manifest.input.minimumWidth || image.height < manifest.input.minimumHeight
    || image.width > manifest.input.maximumWidth || image.height > manifest.input.maximumHeight) {
    throw new RangeError('Provider image exceeds the model input limit')
  }
  if (request.capabilities.length === 0
    || new Set(request.capabilities).size !== request.capabilities.length) {
    throw new RangeError('Provider capabilities must contain unique requested values')
  }
  for (const capability of request.capabilities) {
    if (manifest.capabilities.includes(capability) === false) {
      throw new RangeError(`Provider capability ${capability} is unsupported`)
    }
  }
  if (request.timeoutMs !== undefined
    && (Number.isFinite(request.timeoutMs) === false || request.timeoutMs <= 0)) {
    throw new RangeError('Provider timeout must be a finite positive number')
  }
  if (request.timeoutMs !== undefined && request.timeoutMs > manifest.failurePolicy.timeoutMs) {
    throw new RangeError('Provider request timeout must stay within the model manifest')
  }
  if (request.targetGrid !== undefined
    && (Number.isInteger(request.targetGrid.width) === false
      || Number.isInteger(request.targetGrid.height) === false
      || request.targetGrid.width <= 0 || request.targetGrid.height <= 0)) {
    throw new RangeError('Provider target grid must use positive integer dimensions')
  }
}

export function validatePreferenceFeatures(value: PreferenceFeatures): void {
  stringValue(value.modelId, 'Preference feature model id')
  if (value.names.length === 0 || value.names.length !== value.values.length
    || new Set(value.names).size !== value.names.length
    || value.names.some((name) => name.trim().length === 0)) {
    throw new RangeError('Preference feature names and values must align')
  }
  for (const feature of value.values) finite(feature, 'Preference feature value')
  unit(value.confidence, 'Preference feature confidence')
}

export function validateLearnedProposal(value: LearnedProposal): void {
  stringValue(value.id, 'Learned proposal id')
  stringValue(value.modelId, 'Learned proposal model id')
  unit(value.confidence, 'Learned proposal confidence')
  if (Number.isInteger(value.image.width) === false || value.image.width <= 0
    || Number.isInteger(value.image.height) === false || value.image.height <= 0
    || value.image.data.length !== value.image.width * value.image.height * 4) {
    throw new RangeError('Learned proposal image must contain valid RGBA data')
  }
}

function validateTypedMask(
  value: BinaryMask,
  label: string,
  sourceImage?: PixelImage,
): void {
  if (Number.isInteger(value.width) === false || value.width <= 0
    || Number.isInteger(value.height) === false || value.height <= 0
    || (sourceImage !== undefined
      && (value.width !== sourceImage.width || value.height !== sourceImage.height))
    || value.values instanceof Float32Array === false
    || value.values.length !== value.width * value.height) {
    throw new RangeError(`${label} dimensions or typed values are invalid`)
  }
  for (const entry of value.values) unit(entry, `${label} value`)
}

function validateTypedProvenance(
  value: readonly EvidenceProvenance[] | undefined,
  label: string,
): void {
  for (const [index, entry] of (value ?? []).entries()) {
    if (evidenceOrigins.has(entry.origin) === false) throw new RangeError(`${label}[${index}] origin is invalid`)
    stringValue(entry.provider, `${label}[${index}] provider`)
    if (entry.model !== undefined) stringValue(entry.model, `${label}[${index}] model`)
    if (entry.version !== undefined) stringValue(entry.version, `${label}[${index}] version`)
  }
}

export function validateImageAnalysis(
  analysis: ImageAnalysis,
  sourceImage?: PixelImage,
): void {
  if (analysis.confidence !== undefined) unit(analysis.confidence, 'Image analysis confidence')
  if (analysis.imageType !== undefined && imageTypes.has(analysis.imageType) === false) {
    throw new RangeError('Image analysis type is invalid')
  }
  if (analysis.subjectMask !== undefined) {
    validateTypedMask(analysis.subjectMask, 'Image analysis subject mask', sourceImage)
  }
  if (analysis.subjectMaskEvidence !== undefined) {
    validateTypedMask(analysis.subjectMaskEvidence.mask, 'Image analysis subject evidence mask', sourceImage)
    unit(analysis.subjectMaskEvidence.confidence, 'Image analysis subject evidence confidence')
    if (subjectSources.has(analysis.subjectMaskEvidence.source) === false) {
      throw new RangeError('Image analysis subject evidence source is invalid')
    }
    stringValue(analysis.subjectMaskEvidence.revision, 'Image analysis subject evidence revision')
    validateTypedProvenance(
      analysis.subjectMaskEvidence.provenance,
      'Image analysis subject evidence provenance',
    )
  }
  if (analysis.importanceMap !== undefined) {
    const map = analysis.importanceMap
    if (Number.isInteger(map.width) === false || map.width <= 0
      || Number.isInteger(map.height) === false || map.height <= 0
      || (sourceImage !== undefined
        && (map.width !== sourceImage.width || map.height !== sourceImage.height))
      || map.weights instanceof Float32Array === false
      || map.weights.length !== map.width * map.height) {
      throw new RangeError('Image analysis importance map dimensions or typed values are invalid')
    }
    for (const entry of map.weights) unit(entry, 'Image analysis importance weight')
  }
  const regionIds = new Set<string>()
  for (const [index, region] of (analysis.semanticRegions ?? []).entries()) {
    stringValue(region.id, `Image analysis semantic region ${index} id`)
    stringValue(region.label, `Image analysis semantic region ${index} label`)
    if (regionIds.has(region.id)) throw new RangeError('Image analysis semantic region ids must be unique')
    regionIds.add(region.id)
    validateTypedMask(region.mask, `Image analysis semantic region ${index} mask`, sourceImage)
    unit(region.confidence, `Image analysis semantic region ${index} confidence`)
    if (region.importance !== undefined) unit(region.importance, `Image analysis semantic region ${index} importance`)
    validateTypedProvenance(region.provenance, `Image analysis semantic region ${index} provenance`)
  }
  const landmarkIds = new Set<string>()
  for (const [index, landmark] of (analysis.landmarks ?? []).entries()) {
    stringValue(landmark.id, `Image analysis landmark ${index} id`)
    if (landmarkIds.has(landmark.id)) throw new RangeError('Image analysis landmark ids must be unique')
    landmarkIds.add(landmark.id)
    if (landmarkKinds.has(landmark.kind) === false) throw new RangeError(`Image analysis landmark ${index} kind is invalid`)
    if (landmarkPriorities.has(landmark.priority) === false) {
      throw new RangeError(`Image analysis landmark ${index} priority is invalid`)
    }
    finite(landmark.x, `Image analysis landmark ${index} x`)
    finite(landmark.y, `Image analysis landmark ${index} y`)
    unit(landmark.confidence, `Image analysis landmark ${index} confidence`)
    if (landmark.sourceRadiusPx !== undefined) finitePositive(
      landmark.sourceRadiusPx,
      `Image analysis landmark ${index} source radius`,
    )
    if (landmark.gridRadiusCells !== undefined) finitePositive(
      landmark.gridRadiusCells,
      `Image analysis landmark ${index} grid radius`,
    )
    validateTypedProvenance(landmark.provenance, `Image analysis landmark ${index} provenance`)
  }
  if (analysis.suggestedCrop !== undefined) {
    finite(analysis.suggestedCrop.x, 'Image analysis crop x')
    finite(analysis.suggestedCrop.y, 'Image analysis crop y')
    finitePositive(analysis.suggestedCrop.width, 'Image analysis crop width')
    finitePositive(analysis.suggestedCrop.height, 'Image analysis crop height')
  }
  if (analysis.suggestedCropConfidence !== undefined) {
    unit(analysis.suggestedCropConfidence, 'Image analysis crop confidence')
  }
  if (analysis.suggestedCropSource !== undefined
    && analysis.suggestedCropSource !== 'automatic'
    && analysis.suggestedCropSource !== 'manual') {
    throw new RangeError('Image analysis crop source is invalid')
  }
  for (const [name, version] of Object.entries(analysis.modelVersions ?? {})) {
    stringValue(name, 'Image analysis model version key')
    stringValue(version, `Image analysis model version ${name}`)
  }
  validateTypedProvenance(analysis.provenance, 'Image analysis provenance')
}

function sameIdentity(actual: ModelManifest, expected: ModelManifest): boolean {
  return actual.providerId === expected.providerId
    && actual.modelId === expected.modelId
    && actual.modelVersion === expected.modelVersion
    && actual.sourceRevision === expected.sourceRevision
    && actual.weightRevision === expected.weightRevision
}

export function validateProviderResult(
  result: ModelProviderResult,
  provider: AIModelProvider,
  requestedCapabilities: readonly AICapability[],
  sourceImage?: PixelImage,
): void {
  if (result.providerId !== provider.manifest.providerId || sameIdentity(result.model, provider.manifest) === false) {
    throw new RangeError('Provider result model identity differs from the pinned manifest')
  }
  unit(result.confidence, 'Provider result confidence')
  if (Number.isFinite(result.elapsedMs) === false || result.elapsedMs < 0) {
    throw new RangeError('Provider result elapsed time must be finite and non-negative')
  }
  if (result.capabilities.length === 0
    || new Set(result.capabilities).size !== result.capabilities.length
    || result.capabilities.some((capability) => requestedCapabilities.includes(capability) === false)) {
    throw new RangeError('Provider result capabilities must match the request')
  }
  if (result.analysis !== undefined) validateImageAnalysis(result.analysis, sourceImage)
  for (const proposal of result.learnedProposals ?? []) validateLearnedProposal(proposal)
  if (result.preferenceFeatures !== undefined) validatePreferenceFeatures(result.preferenceFeatures)
}

interface RegisteredProvider {
  provider: AIModelProvider
  priority: number
  order: number
}

export class AIProviderRegistry {
  readonly #providers = new Map<string, RegisteredProvider>()
  #order = 0

  register(provider: AIModelProvider, priority = 0): void {
    validateModelManifest(provider.manifest)
    if (this.#providers.has(provider.manifest.providerId)) {
      throw new RangeError(`Provider ${provider.manifest.providerId} is already registered`)
    }
    if (Number.isFinite(priority) === false) throw new RangeError('Provider priority must be finite')
    this.#providers.set(provider.manifest.providerId, { provider, priority, order: this.#order++ })
  }

  get(providerId: string): AIModelProvider | undefined {
    return this.#providers.get(providerId)?.provider
  }

  select(
    requested: readonly AICapability[],
    providerIds?: readonly string[],
  ): readonly AIModelProvider[] {
    const candidates = [...this.#providers.values()]
      .filter((entry) => providerIds === undefined || providerIds.includes(entry.provider.manifest.providerId))
      .sort((first, second) => second.priority - first.priority || first.order - second.order)
    const uncovered = new Set(requested)
    const selected: AIModelProvider[] = []
    for (const entry of candidates) {
      if (entry.provider.manifest.capabilities.some((capability) => uncovered.has(capability)) === false) continue
      selected.push(entry.provider)
      for (const capability of entry.provider.manifest.capabilities) uncovered.delete(capability)
      if (uncovered.size === 0) break
    }
    return selected
  }

  list(): readonly AIModelProvider[] {
    return [...this.#providers.values()]
      .sort((first, second) => second.priority - first.priority || first.order - second.order)
      .map((entry) => entry.provider)
  }
}

function providerRequestFor(
  request: CompositeAnalysisRequest,
  provider: AIModelProvider,
): ModelProviderRequest {
  const selected = request.capabilities.filter((capability) =>
    provider.manifest.capabilities.includes(capability),
  )
  return {
    image: request.image,
    capabilities: selected,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.targetGrid === undefined ? {} : { targetGrid: request.targetGrid }),
    ...(request.paletteId === undefined ? {} : { paletteId: request.paletteId }),
    ...(request.styleId === undefined ? {} : { styleId: request.styleId }),
    ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
    ...(request.sourceId === undefined ? {} : { sourceId: request.sourceId }),
  }
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 500) || 'Provider failed'
}

async function runProvider(
  provider: AIModelProvider,
  request: ModelProviderRequest,
): Promise<ModelProviderResult> {
  validateProviderRequest(request, provider.manifest)
  request.signal?.throwIfAborted()
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(request.signal?.reason)
  request.signal?.addEventListener('abort', forwardAbort, { once: true })
  const timeoutMs = request.timeoutMs ?? provider.manifest.failurePolicy.timeoutMs
  const timeout = setTimeout(() => controller.abort(new Error('Provider request timed out')), timeoutMs)
  const providerRequest = { ...request, signal: controller.signal }
  try {
    const abort = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
    })
    const result = await Promise.race([provider.analyze(providerRequest), abort])
    validateProviderResult(result, provider, request.capabilities, request.image)
    return result
  } finally {
    clearTimeout(timeout)
    request.signal?.removeEventListener('abort', forwardAbort)
  }
}

export class CompositeImageAnalyzer {
  readonly #registry: AIProviderRegistry

  constructor(registry: AIProviderRegistry) {
    this.#registry = registry
  }

  async analyze(request: CompositeAnalysisRequest): Promise<CompositeAnalysisResult> {
    if (request.route === 'deterministic') {
      if (request.capabilities.length > 0) {
        throw new RangeError('Deterministic analysis route cannot request neural capabilities')
      }
      return {
        route: 'deterministic',
        analysis: {},
        learnedProposals: [],
        preferenceFeatures: [],
        contributions: [],
        uncoveredCapabilities: [],
      }
    }
    if (request.capabilities.length === 0 || new Set(request.capabilities).size !== request.capabilities.length) {
      throw new RangeError('Composite analysis requires unique capabilities')
    }
    const providers = this.#registry.select(request.capabilities, request.providerIds)
    const covered = new Set(providers.flatMap((provider) => provider.manifest.capabilities))
    const uncoveredCapabilities = request.capabilities.filter((capability) => covered.has(capability) === false)
    if ((request.failureMode ?? 'best-effort') === 'strict' && uncoveredCapabilities.length > 0) {
      throw new Error(`No provider covers ${uncoveredCapabilities.join(', ')}`)
    }
    const analyses: ImageAnalysis[] = []
    const learnedProposals: LearnedProposal[] = []
    const preferenceFeatures: PreferenceFeatures[] = []
    const contributions: ProviderContribution[] = []
    for (const provider of providers) {
      const providerRequest = providerRequestFor(request, provider)
      const startedAt = performance.now()
      try {
        const result = await runProvider(provider, providerRequest)
        if (result.analysis !== undefined) analyses.push(result.analysis)
        learnedProposals.push(...(result.learnedProposals ?? []))
        if (result.preferenceFeatures !== undefined) preferenceFeatures.push(result.preferenceFeatures)
        contributions.push({
          providerId: provider.manifest.providerId,
          modelId: provider.manifest.modelId,
          capabilities: result.capabilities,
          status: 'used',
          confidence: result.confidence,
          elapsedMs: result.elapsedMs,
        })
      } catch (error) {
        if (request.signal?.aborted === true) throw request.signal.reason
        if ((request.failureMode ?? 'best-effort') === 'strict') throw error
        contributions.push({
          providerId: provider.manifest.providerId,
          modelId: provider.manifest.modelId,
          capabilities: providerRequest.capabilities,
          status: 'failed',
          elapsedMs: Math.max(0, performance.now() - startedAt),
          message: boundedMessage(error),
        })
      }
    }
    return {
      route: request.route,
      analysis: analyses.length === 0 ? {} : fuseImageAnalyses(analyses),
      learnedProposals,
      preferenceFeatures,
      contributions,
      uncoveredCapabilities,
    }
  }
}
