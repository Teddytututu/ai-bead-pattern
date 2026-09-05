import type {
  BinaryMask,
  EvidenceOrigin,
  EvidenceProvenance,
  ImageAnalysis,
  ImageLandmark,
  ImageType,
  LandmarkKind,
  LandmarkObservationState,
  LandmarkPriority,
  PixelImage,
  SemanticRegion,
  SubjectMaskEvidence,
  SubjectMaskSource,
  StructuralRole,
} from '@ai-bead-pattern/pattern-core'

import { fuseImageAnalyses } from './analysis-fusion.js'
import { enrichPetGeometryAnalysis } from './pet-geometry-fusion.js'
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
  | 'preference-scoring'

export interface NormalizedPoint {
  x: number
  y: number
}

export interface NormalizedBox {
  x: number
  y: number
  width: number
  height: number
}

/** Coarse user or detector guidance for selecting one subject instance. */
export interface InstancePrompt {
  lasso?: readonly NormalizedPoint[]
  box?: NormalizedBox
  positivePoints?: readonly NormalizedPoint[]
  negativePoints?: readonly NormalizedPoint[]
  labels?: readonly string[]
  selectedInstanceId?: string
}

/** COCO uncompressed RLE in column-major order, with size stored as [height, width]. */
export interface CocoUncompressedRle {
  size: readonly [number, number]
  counts: readonly number[]
}

export interface InstanceProposalDiagnostics {
  promptSource: string
  positivePointCount: number
  negativePointCount: number
  maskAreaRatio: number
  lassoContainment: number
  inferenceMs: number
  device: string
}

export interface InstanceProposal {
  id: string
  instanceId: string
  label?: string
  bbox: NormalizedBox
  maskRle: CocoUncompressedRle
  confidence: number
  detectionScore?: number
  predictedIoU: number
  stabilityScore: number
  promptAgreement: number
  selected: boolean
  diagnostics: InstanceProposalDiagnostics
}

export interface ModelProviderRequest {
  image: PixelImage
  /** Original source image used to score the primary image as a candidate pair. */
  referenceImage?: PixelImage
  capabilities: readonly AICapability[]
  imageTypeHint?: ImageType
  signal?: AbortSignal
  timeoutMs?: number
  targetGrid?: Readonly<{ width: number; height: number }>
  paletteId?: string
  styleId?: string
  prompt?: string
  instancePrompt?: InstancePrompt
  /** Detector-derived instances processed as one bounded provider batch. */
  instancePrompts?: readonly InstancePrompt[]
  sourceId?: string
  candidateId?: string
}

/** Exact source-image rectangle carried through a proposal's contain fit. */
export interface ProposalSourceFrame {
  fit: 'contain'
  sourceWidth: number
  sourceHeight: number
  /** Rectangle edges in proposal-image pixel coordinates. */
  x: number
  y: number
  width: number
  height: number
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
  sourceFrame: ProposalSourceFrame
}

export type PreferenceView = 'global' | 'subject' | 'head' | 'critical-local'

export interface RegionalPreferenceComparison {
  view: PreferenceView
  identitySimilarity: number
  patchCorrespondence: number
  criticalPatchRetention: number
  regionalCoverage: number
  confidence: number
}

export interface PreferenceFeatures {
  modelId: string
  names: readonly string[]
  values: Float32Array
  confidence: number
  scope?: 'source' | 'candidate' | 'pair'
  candidateId?: string
  regionalComparisons?: readonly RegionalPreferenceComparison[]
}

export interface ModelProviderResult {
  providerId: string
  model: ModelManifest
  capabilities: readonly AICapability[]
  confidence: number
  elapsedMs: number
  analysis?: ImageAnalysis
  instanceProposals?: readonly InstanceProposal[]
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
  instanceProposals: readonly InstanceProposal[]
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
const landmarkObservationStates = new Set<LandmarkObservationState>(['observed', 'inferred', 'missing'])
const structuralRoles = new Set<StructuralRole>([
  'eye-center', 'ear-tip', 'ear-root', 'nose-tip', 'mouth-corner', 'upper-jaw', 'lower-jaw',
  'neck-base', 'shoulder', 'chest-center', 'back-middle', 'tail-root', 'hip',
  'front-knee', 'front-paw', 'rear-knee', 'rear-paw', 'tail-tip',
])
const learnedProposalKinds = new Set<LearnedProposal['kind']>([
  'learned-pixelization',
  'generative-proposal',
])
const preferenceViews = new Set<PreferenceView>([
  'global',
  'subject',
  'head',
  'critical-local',
])
const regionalMetricNames = [
  'identitySimilarity',
  'patchCorrespondence',
  'criticalPatchRetention',
  'regionalCoverage',
] as const

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

type ImageDimensions = Readonly<{ width: number; height: number }>

function validatedDimensions(value: ImageDimensions, label: string): ImageDimensions {
  return {
    width: integerPositive(value.width, `${label}.width`),
    height: integerPositive(value.height, `${label}.height`),
  }
}

export function createContainSourceFrame(
  source: ImageDimensions,
  proposal: ImageDimensions,
): ProposalSourceFrame {
  const sourceSize = validatedDimensions(source, 'Source image')
  const proposalSize = validatedDimensions(proposal, 'Proposal image')
  const scale = Math.min(
    proposalSize.width / sourceSize.width,
    proposalSize.height / sourceSize.height,
  )
  const width = sourceSize.width * scale
  const height = sourceSize.height * scale
  return {
    fit: 'contain',
    sourceWidth: sourceSize.width,
    sourceHeight: sourceSize.height,
    x: (proposalSize.width - width) / 2,
    y: (proposalSize.height - height) / 2,
    width,
    height,
  }
}

export function hydrateProposalSourceFrame(
  value: unknown,
  proposalImage: ImageDimensions,
  sourceImage?: ImageDimensions,
): ProposalSourceFrame {
  const input = record(value, 'Learned proposal source frame')
  if (input.fit !== 'contain') {
    throw new RangeError('Learned proposal source frame fit must use contain')
  }
  const sourceWidth = integerPositive(
    input.sourceWidth,
    'Learned proposal source frame sourceWidth',
  )
  const sourceHeight = integerPositive(
    input.sourceHeight,
    'Learned proposal source frame sourceHeight',
  )
  if (sourceImage !== undefined
    && (sourceWidth !== sourceImage.width || sourceHeight !== sourceImage.height)) {
    throw new RangeError('Learned proposal source frame source dimensions differ from the request')
  }
  const proposalSize = validatedDimensions(proposalImage, 'Learned proposal image')
  const frame: ProposalSourceFrame = {
    fit: 'contain',
    sourceWidth,
    sourceHeight,
    x: finite(input.x, 'Learned proposal source frame x'),
    y: finite(input.y, 'Learned proposal source frame y'),
    width: finitePositive(input.width, 'Learned proposal source frame width'),
    height: finitePositive(input.height, 'Learned proposal source frame height'),
  }
  if (frame.x < 0 || frame.y < 0
    || frame.x + frame.width > proposalSize.width + 1e-6
    || frame.y + frame.height > proposalSize.height + 1e-6) {
    throw new RangeError('Learned proposal source frame must stay inside the proposal image')
  }
  const expected = createContainSourceFrame(
    { width: sourceWidth, height: sourceHeight },
    proposalSize,
  )
  const tolerance = Math.max(0.01, Math.max(proposalSize.width, proposalSize.height) / 512)
  if (Math.abs(frame.x - expected.x) > tolerance
    || Math.abs(frame.y - expected.y) > tolerance
    || Math.abs(frame.width - expected.width) > tolerance
    || Math.abs(frame.height - expected.height) > tolerance) {
    throw new RangeError('Learned proposal source frame must describe a centered contain mapping')
  }
  return frame
}

export function validateProposalSourceFrame(
  value: ProposalSourceFrame,
  proposalImage: ImageDimensions,
  sourceImage?: ImageDimensions,
): void {
  hydrateProposalSourceFrame(value, proposalImage, sourceImage)
}

function normalizedPoint(value: unknown, label: string): NormalizedPoint {
  const input = record(value, label)
  const x = unit(input.x, `${label}.x`)
  const y = unit(input.y, `${label}.y`)
  return { x, y }
}

function normalizedPoints(
  value: unknown,
  label: string,
  minimumLength: number,
): readonly NormalizedPoint[] | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value) === false || value.length < minimumLength || value.length > 64) {
    throw new RangeError(`${label} must contain ${minimumLength}..64 normalized points`)
  }
  return value.map((entry, index) => normalizedPoint(entry, `${label}[${index}]`))
}

function polygonArea(points: readonly NormalizedPoint[]): number {
  let twiceArea = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!
    const next = points[(index + 1) % points.length]!
    twiceArea += current.x * next.y - next.x * current.y
  }
  return Math.abs(twiceArea) / 2
}

export function validateInstancePrompt(value: InstancePrompt): void {
  const input = record(value, 'Instance prompt')
  const lasso = normalizedPoints(input.lasso, 'Instance prompt lasso', 3)
  if (lasso !== undefined && polygonArea(lasso) < 0.0001) {
    throw new RangeError('Instance prompt lasso must enclose an area')
  }
  const positivePoints = normalizedPoints(input.positivePoints, 'Instance prompt positivePoints', 1)
  const negativePoints = normalizedPoints(input.negativePoints, 'Instance prompt negativePoints', 1)
  if (input.box !== undefined) {
    const box = record(input.box, 'Instance prompt box')
    const x = unit(box.x, 'Instance prompt box.x')
    const y = unit(box.y, 'Instance prompt box.y')
    const width = finitePositive(box.width, 'Instance prompt box.width')
    const height = finitePositive(box.height, 'Instance prompt box.height')
    if (x + width > 1 || y + height > 1) {
      throw new RangeError('Instance prompt box must stay within normalized image bounds')
    }
  }
  let labels: readonly unknown[] | undefined
  if (input.labels !== undefined) {
    if (Array.isArray(input.labels) === false || input.labels.length === 0 || input.labels.length > 16) {
      throw new RangeError('Instance prompt labels must contain 1..16 entries')
    }
    labels = input.labels
    const parsed = labels.map((entry, index) => stringValue(entry, `Instance prompt labels[${index}]`))
    if (new Set(parsed).size !== parsed.length) {
      throw new RangeError('Instance prompt labels must be unique')
    }
  }
  const selectedInstanceId = optionalString(input.selectedInstanceId, 'Instance prompt selected instance id')
  if (lasso === undefined && input.box === undefined && positivePoints === undefined
    && negativePoints === undefined && labels === undefined && selectedInstanceId === undefined) {
    throw new RangeError('Instance prompt requires instance guidance')
  }
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

function uint8UnitArray(value: unknown, expectedLength: number, label: string): Float32Array {
  const encoded = stringValue(value, label)
  if (/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) === false) {
    throw new RangeError(`${label} must use base64`)
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== expectedLength) {
    throw new RangeError(`${label} length differs from dimensions`)
  }
  return Float32Array.from(bytes, (entry) => entry / 255)
}

function integerNonNegative(value: unknown, label: string): number {
  const parsed = finite(value, label)
  if (Number.isSafeInteger(parsed) === false || parsed < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
  return parsed
}

function hydrateCocoUncompressedRle(
  value: unknown,
  expectedWidth: number,
  expectedHeight: number,
  label: string,
): CocoUncompressedRle {
  const input = record(value, label)
  if (Array.isArray(input.size) === false || input.size.length !== 2) {
    throw new RangeError(`${label}.size must contain [height, width]`)
  }
  const height = integerPositive(input.size[0], `${label}.size[0]`)
  const width = integerPositive(input.size[1], `${label}.size[1]`)
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new RangeError(`${label} dimensions differ from the mask`)
  }
  if (Array.isArray(input.counts) === false || input.counts.length === 0
    || input.counts.length > width * height + 1) {
    throw new RangeError(`${label}.counts must be a bounded array`)
  }
  const counts = input.counts.map((entry, index) =>
    integerNonNegative(entry, `${label}.counts[${index}]`),
  )
  if (counts.some((count, index) => count === 0 && index !== 0)) {
    throw new RangeError(`${label}.counts may contain a zero run only at the beginning`)
  }
  if (counts.reduce((sum, count) => sum + count, 0) !== width * height) {
    throw new RangeError('RLE counts differ from dimensions')
  }
  return { size: [height, width], counts }
}

function decodeCocoUncompressedRle(value: CocoUncompressedRle): Float32Array {
  const [height, width] = value.size
  const result = new Float32Array(width * height)
  let columnMajorOffset = 0
  let foreground = false
  for (const count of value.counts) {
    if (foreground) {
      for (let runOffset = 0; runOffset < count; runOffset += 1) {
        const flat = columnMajorOffset + runOffset
        const x = Math.floor(flat / height)
        const y = flat % height
        result[y * width + x] = 1
      }
    }
    columnMajorOffset += count
    foreground = !foreground
  }
  return result
}

function hydrateMask(value: unknown, label: string): BinaryMask {
  const input = record(value, label)
  const width = integerPositive(input.width, `${label}.width`)
  const height = integerPositive(input.height, `${label}.height`)
  const hasValues = input.values !== undefined
  const hasRle = input.rle !== undefined
  if (hasValues === hasRle) {
    throw new RangeError(`${label} requires exactly one values or RLE payload`)
  }
  const values = hasRle
    ? decodeCocoUncompressedRle(hydrateCocoUncompressedRle(input.rle, width, height, `${label}.rle`))
    : numericArray(input.values, width * height, `${label}.values`)
  return {
    width,
    height,
    values,
  }
}

function hydrateNormalizedBox(value: unknown, label: string): NormalizedBox {
  const input = record(value, label)
  const x = unit(input.x, `${label}.x`)
  const y = unit(input.y, `${label}.y`)
  const width = finitePositive(input.width, `${label}.width`)
  const height = finitePositive(input.height, `${label}.height`)
  if (width > 1 || height > 1 || x + width > 1 + 1e-9 || y + height > 1 + 1e-9) {
    throw new RangeError(`${label} must stay within normalized image bounds`)
  }
  return { x, y, width, height }
}

export function hydrateInstanceProposal(
  value: unknown,
  sourceImage: PixelImage,
  index: number,
): InstanceProposal {
  const label = `instanceProposals[${index}]`
  const input = record(value, label)
  if (typeof input.selected !== 'boolean') {
    throw new TypeError(`${label}.selected must be boolean`)
  }
  const diagnosticsInput = record(input.diagnostics, `${label}.diagnostics`)
  const proposalLabel = optionalString(input.label, `${label}.label`)
  const proposal: InstanceProposal = {
    id: stringValue(input.id, `${label}.id`),
    instanceId: stringValue(input.instanceId, `${label}.instanceId`),
    ...(proposalLabel === undefined ? {} : { label: proposalLabel }),
    bbox: hydrateNormalizedBox(input.bbox, `${label}.bbox`),
    maskRle: hydrateCocoUncompressedRle(
      input.maskRle,
      sourceImage.width,
      sourceImage.height,
      `${label}.maskRle`,
    ),
    confidence: unit(input.confidence, `${label}.confidence`),
    ...(input.detectionScore === undefined ? {} : {
      detectionScore: unit(input.detectionScore, `${label}.detectionScore`),
    }),
    predictedIoU: unit(input.predictedIoU, `${label}.predictedIoU`),
    stabilityScore: unit(input.stabilityScore, `${label}.stabilityScore`),
    promptAgreement: unit(input.promptAgreement, `${label}.promptAgreement`),
    selected: input.selected,
    diagnostics: {
      promptSource: stringValue(diagnosticsInput.promptSource, `${label}.diagnostics.promptSource`),
      positivePointCount: integerNonNegative(
        diagnosticsInput.positivePointCount,
        `${label}.diagnostics.positivePointCount`,
      ),
      negativePointCount: integerNonNegative(
        diagnosticsInput.negativePointCount,
        `${label}.diagnostics.negativePointCount`,
      ),
      maskAreaRatio: unit(diagnosticsInput.maskAreaRatio, `${label}.diagnostics.maskAreaRatio`),
      lassoContainment: unit(
        diagnosticsInput.lassoContainment,
        `${label}.diagnostics.lassoContainment`,
      ),
      inferenceMs: integerOrFiniteNonNegative(
        diagnosticsInput.inferenceMs,
        `${label}.diagnostics.inferenceMs`,
      ),
      device: stringValue(diagnosticsInput.device, `${label}.diagnostics.device`),
    },
  }
  validateInstanceProposal(proposal, sourceImage)
  return proposal
}

function integerOrFiniteNonNegative(value: unknown, label: string): number {
  const parsed = finite(value, label)
  if (parsed < 0) throw new RangeError(`${label} must be non-negative`)
  return parsed
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
    const observationState = input.observationState === undefined
      ? undefined
      : stringValue(input.observationState, `analysis.landmarks[${index}].observationState`) as LandmarkObservationState
    if (observationState !== undefined && landmarkObservationStates.has(observationState) === false) {
      throw new RangeError(`analysis.landmarks[${index}].observationState is invalid`)
    }
    const structuralRole = input.structuralRole === undefined
      ? undefined
      : stringValue(input.structuralRole, `analysis.landmarks[${index}].structuralRole`) as StructuralRole
    if (structuralRole !== undefined && structuralRoles.has(structuralRole) === false) {
      throw new RangeError(`analysis.landmarks[${index}].structuralRole is invalid`)
    }
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
      ...(observationState === undefined ? {} : { observationState }),
      ...(structuralRole === undefined ? {} : { structuralRole }),
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
    const hasWeights = map.weights !== undefined
    const hasUint8 = map.uint8Base64 !== undefined
    if (hasWeights === hasUint8) {
      throw new RangeError('analysis.importanceMap requires exactly one weights or uint8 payload')
    }
    importanceMap = {
      width,
      height,
      weights: hasUint8
        ? uint8UnitArray(map.uint8Base64, width * height, 'analysis.importanceMap.uint8Base64')
        : numericArray(map.weights, width * height, 'analysis.importanceMap.weights'),
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
  validateRequestImage(request.image, manifest, 'Provider image')
  if (request.referenceImage !== undefined) {
    validateRequestImage(request.referenceImage, manifest, 'Provider reference image')
    if (request.candidateId === undefined) {
      throw new RangeError('Provider pair request requires a candidate id')
    }
  }
  optionalString(request.sourceId, 'Provider source id')
  optionalString(request.candidateId, 'Provider candidate id')
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
  if (request.imageTypeHint !== undefined && imageTypes.has(request.imageTypeHint) === false) {
    throw new RangeError('Provider image type hint is invalid')
  }
  if (request.instancePrompt !== undefined && request.instancePrompts !== undefined) {
    throw new RangeError('Provider request must select singular or batched instance prompts')
  }
  if (request.instancePrompt !== undefined) validateInstancePrompt(request.instancePrompt)
  if (request.instancePrompts !== undefined) {
    if (request.instancePrompts.length === 0 || request.instancePrompts.length > 64) {
      throw new RangeError('Provider instance prompts must contain 1..64 entries')
    }
    const instanceIds = new Set<string>()
    for (const [index, prompt] of request.instancePrompts.entries()) {
      validateInstancePrompt(prompt)
      if (prompt.box === undefined || prompt.selectedInstanceId === undefined) {
        throw new RangeError(`Provider instance prompts[${index}] requires a box and instance id`)
      }
      if (instanceIds.has(prompt.selectedInstanceId)) {
        throw new RangeError('Provider instance prompt ids must be unique')
      }
      instanceIds.add(prompt.selectedInstanceId)
    }
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

function validateRequestImage(image: PixelImage, manifest: ModelManifest, label: string): void {
  if (Number.isInteger(image.width) === false || Number.isInteger(image.height) === false
    || image.width <= 0 || image.height <= 0
    || image.data instanceof Uint8ClampedArray === false
    || image.data.length !== image.width * image.height * 4) {
    throw new RangeError(`${label} must contain valid RGBA dimensions`)
  }
  if (image.width < manifest.input.minimumWidth || image.height < manifest.input.minimumHeight
    || image.width > manifest.input.maximumWidth || image.height > manifest.input.maximumHeight) {
    throw new RangeError(`${label} exceeds the model input limit`)
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
  if (value.scope !== undefined
    && value.scope !== 'source' && value.scope !== 'candidate' && value.scope !== 'pair') {
    throw new RangeError('Preference feature scope is invalid')
  }
  const candidateId = optionalString(value.candidateId, 'Preference feature candidate id')
  if ((value.scope === 'candidate' || value.scope === 'pair') && candidateId === undefined) {
    throw new RangeError(`Preference feature ${value.scope} scope requires a candidate id`)
  }
  if (value.scope === 'source' && candidateId !== undefined) {
    throw new RangeError('Preference feature source scope cannot bind a candidate id')
  }
  if (value.regionalComparisons !== undefined) {
    if (value.regionalComparisons.length !== preferenceViews.size) {
      throw new RangeError('Preference regional comparisons must contain all four views')
    }
    const seen = new Set<PreferenceView>()
    for (const comparison of value.regionalComparisons) {
      if (preferenceViews.has(comparison.view) === false || seen.has(comparison.view)) {
        throw new RangeError('Preference regional comparisons must use unique supported views')
      }
      seen.add(comparison.view)
      unit(comparison.identitySimilarity, `Preference ${comparison.view} identity similarity`)
      unit(comparison.patchCorrespondence, `Preference ${comparison.view} patch correspondence`)
      unit(comparison.criticalPatchRetention, `Preference ${comparison.view} critical patch retention`)
      unit(comparison.regionalCoverage, `Preference ${comparison.view} regional coverage`)
      unit(comparison.confidence, `Preference ${comparison.view} confidence`)
      for (const metric of regionalMetricNames) {
        const name = `${comparison.view}.${metric}`
        const index = value.names.indexOf(name)
        if (index < 0 || Math.abs(value.values[index]! - comparison[metric]) > 1e-5) {
          throw new RangeError('Preference regional comparisons must align with flat feature values')
        }
      }
    }
  }
}

export function validateLearnedProposal(
  value: LearnedProposal,
  sourceImage?: ImageDimensions,
): void {
  stringValue(value.id, 'Learned proposal id')
  stringValue(value.modelId, 'Learned proposal model id')
  if (learnedProposalKinds.has(value.kind) === false) {
    throw new RangeError('Learned proposal kind is invalid')
  }
  unit(value.confidence, 'Learned proposal confidence')
  if (Number.isInteger(value.image.width) === false || value.image.width <= 0
    || Number.isInteger(value.image.height) === false || value.image.height <= 0
    || value.image.data instanceof Uint8ClampedArray === false
    || value.image.data.length !== value.image.width * value.image.height * 4) {
    throw new RangeError('Learned proposal image must contain valid RGBA data')
  }
  if (value.targetGrid !== undefined
    && (Number.isInteger(value.targetGrid.width) === false
      || Number.isInteger(value.targetGrid.height) === false
      || value.targetGrid.width <= 0 || value.targetGrid.height <= 0)) {
    throw new RangeError('Learned proposal target grid must use positive integer dimensions')
  }
  optionalString(value.paletteId, 'Learned proposal palette id')
  optionalString(value.styleId, 'Learned proposal style id')
  if (value.seed !== undefined && (Number.isSafeInteger(value.seed) === false || value.seed < 0)) {
    throw new RangeError('Learned proposal seed must use a non-negative safe integer')
  }
  validateProposalSourceFrame(value.sourceFrame, value.image, sourceImage)
}

export function validateInstanceProposal(
  value: InstanceProposal,
  sourceImage?: PixelImage,
): void {
  stringValue(value.id, 'Instance proposal id')
  stringValue(value.instanceId, 'Instance proposal instance id')
  optionalString(value.label, 'Instance proposal label')
  hydrateNormalizedBox(value.bbox, 'Instance proposal bbox')
  const expectedWidth = sourceImage?.width ?? value.maskRle.size[1]
  const expectedHeight = sourceImage?.height ?? value.maskRle.size[0]
  hydrateCocoUncompressedRle(
    value.maskRle,
    expectedWidth,
    expectedHeight,
    'Instance proposal mask RLE',
  )
  unit(value.confidence, 'Instance proposal confidence')
  if (value.detectionScore !== undefined) {
    unit(value.detectionScore, 'Instance proposal detection score')
  }
  unit(value.predictedIoU, 'Instance proposal predicted IoU')
  unit(value.stabilityScore, 'Instance proposal stability score')
  unit(value.promptAgreement, 'Instance proposal prompt agreement')
  if (typeof value.selected !== 'boolean') {
    throw new TypeError('Instance proposal selected flag must be boolean')
  }
  stringValue(value.diagnostics.promptSource, 'Instance proposal prompt source')
  integerNonNegative(value.diagnostics.positivePointCount, 'Instance proposal positive point count')
  integerNonNegative(value.diagnostics.negativePointCount, 'Instance proposal negative point count')
  unit(value.diagnostics.maskAreaRatio, 'Instance proposal mask area ratio')
  unit(value.diagnostics.lassoContainment, 'Instance proposal lasso containment')
  integerOrFiniteNonNegative(value.diagnostics.inferenceMs, 'Instance proposal inference time')
  stringValue(value.diagnostics.device, 'Instance proposal device')
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
    if (landmark.observationState !== undefined
      && landmarkObservationStates.has(landmark.observationState) === false) {
      throw new RangeError(`Image analysis landmark ${index} observation state is invalid`)
    }
    if (landmark.structuralRole !== undefined && structuralRoles.has(landmark.structuralRole) === false) {
      throw new RangeError(`Image analysis landmark ${index} structural role is invalid`)
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

function projectedScalarField(
  values: Float32Array,
  frame: ProposalSourceFrame,
  proposal: ImageDimensions,
  interpolation: 'nearest' | 'bilinear',
): Float32Array {
  const output = new Float32Array(proposal.width * proposal.height)
  const scaleX = frame.sourceWidth / frame.width
  const scaleY = frame.sourceHeight / frame.height
  for (let y = 0; y < proposal.height; y += 1) {
    const proposalCenterY = y + 0.5
    if (proposalCenterY < frame.y || proposalCenterY >= frame.y + frame.height) continue
    const sourceY = (proposalCenterY - frame.y) * scaleY - 0.5
    for (let x = 0; x < proposal.width; x += 1) {
      const proposalCenterX = x + 0.5
      if (proposalCenterX < frame.x || proposalCenterX >= frame.x + frame.width) continue
      const sourceX = (proposalCenterX - frame.x) * scaleX - 0.5
      if (interpolation === 'nearest') {
        const nearestX = Math.max(0, Math.min(frame.sourceWidth - 1, Math.round(sourceX)))
        const nearestY = Math.max(0, Math.min(frame.sourceHeight - 1, Math.round(sourceY)))
        output[y * proposal.width + x] = values[nearestY * frame.sourceWidth + nearestX]!
        continue
      }
      const clampedSourceX = Math.max(0, Math.min(frame.sourceWidth - 1, sourceX))
      const clampedSourceY = Math.max(0, Math.min(frame.sourceHeight - 1, sourceY))
      const left = Math.floor(clampedSourceX)
      const top = Math.floor(clampedSourceY)
      const right = Math.min(frame.sourceWidth - 1, left + 1)
      const bottom = Math.min(frame.sourceHeight - 1, top + 1)
      const xWeight = clampedSourceX - left
      const yWeight = clampedSourceY - top
      const topValue = values[top * frame.sourceWidth + left]!
        * (1 - xWeight) + values[top * frame.sourceWidth + right]! * xWeight
      const bottomValue = values[bottom * frame.sourceWidth + left]!
        * (1 - xWeight) + values[bottom * frame.sourceWidth + right]! * xWeight
      output[y * proposal.width + x] = topValue * (1 - yWeight) + bottomValue * yWeight
    }
  }
  return output
}

function projectedMask(
  mask: BinaryMask,
  frame: ProposalSourceFrame,
  proposal: ImageDimensions,
): BinaryMask {
  return {
    width: proposal.width,
    height: proposal.height,
    values: projectedScalarField(mask.values, frame, proposal, 'nearest'),
  }
}

/** Re-expresses source-image evidence in the learned proposal's pixel coordinate space. */
export function projectSourceAnalysisToProposal(
  sourceAnalysis: ImageAnalysis,
  proposal: LearnedProposal,
): ImageAnalysis {
  validateLearnedProposal(proposal)
  const frame = proposal.sourceFrame
  const sourceShape = {
    width: frame.sourceWidth,
    height: frame.sourceHeight,
    data: new Uint8ClampedArray(0),
  }
  validateImageAnalysis(sourceAnalysis, sourceShape)
  const scaleX = frame.width / frame.sourceWidth
  const scaleY = frame.height / frame.sourceHeight
  const projected: ImageAnalysis = {
    ...sourceAnalysis,
    ...(sourceAnalysis.subjectMask === undefined ? {} : {
      subjectMask: projectedMask(sourceAnalysis.subjectMask, frame, proposal.image),
    }),
    ...(sourceAnalysis.subjectMaskEvidence === undefined ? {} : {
      subjectMaskEvidence: {
        ...sourceAnalysis.subjectMaskEvidence,
        mask: projectedMask(sourceAnalysis.subjectMaskEvidence.mask, frame, proposal.image),
      },
    }),
    ...(sourceAnalysis.semanticRegions === undefined ? {} : {
      semanticRegions: sourceAnalysis.semanticRegions.map((region) => ({
        ...region,
        mask: projectedMask(region.mask, frame, proposal.image),
      })),
    }),
    ...(sourceAnalysis.importanceMap === undefined ? {} : {
      importanceMap: {
        width: proposal.image.width,
        height: proposal.image.height,
        weights: projectedScalarField(
          sourceAnalysis.importanceMap.weights,
          frame,
          proposal.image,
          'bilinear',
        ),
      },
    }),
    ...(sourceAnalysis.landmarks === undefined ? {} : {
      landmarks: sourceAnalysis.landmarks.map((landmark) => ({
        ...landmark,
        x: frame.x + (landmark.x + 0.5) * scaleX - 0.5,
        y: frame.y + (landmark.y + 0.5) * scaleY - 0.5,
        ...(landmark.sourceRadiusPx === undefined ? {} : {
          sourceRadiusPx: landmark.sourceRadiusPx * (scaleX + scaleY) / 2,
        }),
        ...(landmark.radius === undefined ? {} : {
          radius: landmark.radius * (scaleX + scaleY) / 2,
        }),
      })),
    }),
    ...(sourceAnalysis.suggestedCrop === undefined ? {} : {
      suggestedCrop: {
        x: frame.x + sourceAnalysis.suggestedCrop.x * scaleX,
        y: frame.y + sourceAnalysis.suggestedCrop.y * scaleY,
        width: sourceAnalysis.suggestedCrop.width * scaleX,
        height: sourceAnalysis.suggestedCrop.height * scaleY,
      },
    }),
  }
  validateImageAnalysis(projected, proposal.image)
  return projected
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
  request?: ModelProviderRequest,
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
  const proposalIds = new Set<string>()
  const selectedInstanceIds = new Set<string>()
  for (const proposal of result.instanceProposals ?? []) {
    validateInstanceProposal(proposal, sourceImage)
    if (proposalIds.has(proposal.id)) throw new RangeError('Instance proposal ids must be unique')
    proposalIds.add(proposal.id)
    if (proposal.selected) {
      if (selectedInstanceIds.has(proposal.instanceId)) {
        throw new RangeError('Provider result can select at most one proposal per instance')
      }
      selectedInstanceIds.add(proposal.instanceId)
    }
  }
  const requestedInstanceIds = [
    ...(request?.instancePrompt?.selectedInstanceId === undefined
      ? []
      : [request.instancePrompt.selectedInstanceId]),
    ...(request?.instancePrompts ?? []).flatMap((prompt) =>
      prompt.selectedInstanceId === undefined ? [] : [prompt.selectedInstanceId]),
  ]
  if (requestedInstanceIds.length > 0 && selectedInstanceIds.size > 0) {
    const requested = new Set(requestedInstanceIds)
    for (const instanceId of selectedInstanceIds) {
      if (requested.has(instanceId) === false) {
        throw new RangeError('Selected instance proposal differs from the request')
      }
    }
    for (const instanceId of requested) {
      if (selectedInstanceIds.has(instanceId) === false) {
        throw new RangeError('Provider result omits a requested selected instance')
      }
    }
  }
  for (const proposal of result.learnedProposals ?? []) validateLearnedProposal(proposal, sourceImage)
  if (result.preferenceFeatures !== undefined) {
    validatePreferenceFeatures(result.preferenceFeatures)
    if (result.preferenceFeatures.modelId !== provider.manifest.modelId) {
      throw new RangeError('Provider preference feature model identity differs from the pinned manifest')
    }
  }
  validatePreferenceFeatureBinding(result.preferenceFeatures, request)
}

function validatePreferenceFeatureBinding(
  features: PreferenceFeatures | undefined,
  request: ModelProviderRequest | undefined,
): void {
  if (request === undefined) return
  if (request.referenceImage !== undefined) {
    if (features === undefined) {
      if (request.capabilities.includes('preference-scoring')) {
        throw new RangeError('Provider pair response must include preference features')
      }
      return
    }
    if (features.scope !== 'pair') {
      throw new RangeError('Provider pair response must use pair scope')
    }
    if (features.candidateId !== request.candidateId) {
      throw new RangeError('Provider pair response candidate identity differs from the request')
    }
    return
  }
  if (features?.scope === 'pair') {
    throw new RangeError('Provider pair response requires a reference image')
  }
  if (features?.candidateId !== undefined && request.candidateId !== undefined
    && features.candidateId !== request.candidateId) {
    throw new RangeError('Provider preference feature candidate identity differs from the request')
  }
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
    if (providerIds !== undefined) {
      return providerIds
        .map((providerId) => this.#providers.get(providerId)?.provider)
        .filter((provider): provider is AIModelProvider => provider !== undefined
          && provider.manifest.capabilities.some((capability) => requested.includes(capability)))
    }
    const candidates = [...this.#providers.values()]
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
    ...(request.referenceImage === undefined ? {} : { referenceImage: request.referenceImage }),
    capabilities: selected,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.timeoutMs === undefined ? {} : {
      timeoutMs: Math.min(request.timeoutMs, provider.manifest.failurePolicy.timeoutMs),
    }),
    ...(request.targetGrid === undefined ? {} : { targetGrid: request.targetGrid }),
    ...(request.paletteId === undefined ? {} : { paletteId: request.paletteId }),
    ...(request.styleId === undefined ? {} : { styleId: request.styleId }),
    ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
    ...(request.imageTypeHint === undefined ? {} : { imageTypeHint: request.imageTypeHint }),
    ...(request.instancePrompt === undefined ? {} : { instancePrompt: request.instancePrompt }),
    ...(request.instancePrompts === undefined ? {} : { instancePrompts: request.instancePrompts }),
    ...(request.sourceId === undefined ? {} : { sourceId: request.sourceId }),
    ...(request.candidateId === undefined ? {} : { candidateId: request.candidateId }),
  }
}

function instancePromptsFromProposals(
  proposals: readonly InstanceProposal[],
): readonly InstancePrompt[] {
  const selected = new Map<string, InstanceProposal>()
  for (const proposal of proposals) {
    if (proposal.selected === false) continue
    const current = selected.get(proposal.instanceId)
    if (current === undefined || proposal.confidence > current.confidence) {
      selected.set(proposal.instanceId, proposal)
    }
  }
  return [...selected.values()]
    .sort((first, second) => first.instanceId.localeCompare(second.instanceId))
    .map((proposal) => ({
      box: proposal.bbox,
      ...(proposal.label === undefined ? {} : { labels: [proposal.label] }),
      selectedInstanceId: proposal.instanceId,
    }))
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
    validateProviderResult(result, provider, request.capabilities, request.image, request)
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
        instanceProposals: [],
        learnedProposals: [],
        preferenceFeatures: [],
        contributions: [],
        uncoveredCapabilities: [],
      }
    }
    if (request.capabilities.length === 0 || new Set(request.capabilities).size !== request.capabilities.length) {
      throw new RangeError('Composite analysis requires unique capabilities')
    }
    if (request.providerIds !== undefined) {
      if (request.providerIds.length === 0
        || new Set(request.providerIds).size !== request.providerIds.length
        || request.providerIds.some((providerId) => providerId.trim().length === 0)) {
        throw new RangeError('Composite provider ids must contain unique non-empty values')
      }
    }
    const providers = this.#registry.select(request.capabilities, request.providerIds)
    const covered = new Set(providers.flatMap((provider) => provider.manifest.capabilities))
    const uncoveredCapabilities = request.capabilities.filter((capability) => covered.has(capability) === false)
    if ((request.failureMode ?? 'best-effort') === 'strict' && uncoveredCapabilities.length > 0) {
      throw new Error(`No provider covers ${uncoveredCapabilities.join(', ')}`)
    }
    const analyses: ImageAnalysis[] = []
    const instanceProposals: InstanceProposal[] = []
    const learnedProposals: LearnedProposal[] = []
    const preferenceFeatures: PreferenceFeatures[] = []
    const contributions: ProviderContribution[] = []
    for (const provider of providers) {
      const baseRequest = providerRequestFor(request, provider)
      const derivedPrompts = provider.manifest.capabilities.includes('keypoints')
        && baseRequest.instancePrompt === undefined
        && baseRequest.instancePrompts === undefined
        ? instancePromptsFromProposals(instanceProposals)
        : []
      const providerRequest = derivedPrompts.length === 0
        ? baseRequest
        : { ...baseRequest, instancePrompts: derivedPrompts }
      const startedAt = performance.now()
      try {
        const result = await runProvider(provider, providerRequest)
        if (result.analysis !== undefined) analyses.push(result.analysis)
        instanceProposals.push(...(result.instanceProposals ?? []))
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
    const fusedAnalysis = analyses.length === 0 ? {} : fuseImageAnalyses(analyses)
    return {
      route: request.route,
      analysis: enrichPetGeometryAnalysis(request.image, fusedAnalysis, request.imageTypeHint),
      instanceProposals,
      learnedProposals,
      preferenceFeatures,
      contributions,
      uncoveredCapabilities,
    }
  }
}
