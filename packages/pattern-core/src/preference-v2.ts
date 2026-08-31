import type { GridSize, PatternStyle } from './types.js'
import type { PairwisePreferenceRecord } from './preference.js'

export const PREFERENCE_RECORD_SCHEMA_VERSION = 2 as const

export type PreferenceSubjectKind = 'person' | 'pet' | 'object' | 'scene'
export type PreferenceCandidateRoute = 'deterministic' | 'learned-pixelization' | 'generative-proposal'
export type PreferenceAxis =
  | 'subjectRecognition'
  | 'silhouette'
  | 'identityFeatures'
  | 'composition'
  | 'valueHierarchy'
  | 'palette'
  | 'contourRhythm'
  | 'pixelClusters'
  | 'material'
  | 'styleFit'
  | 'craftEase'
export type PreferenceIssue =
  | 'facial-feature-loss'
  | 'marking-loss'
  | 'pattern-loss'
  | 'thin-structure-collapse'
  | 'jagged-contour'
  | 'isolated-cell'
  | 'color-stripe'
  | 'color-banding'
  | 'texture-noise'
  | 'value-confusion'
  | 'palette-deviation'
  | 'proportion-distortion'
  | 'background-dominance'
  | 'too-many-colors'
  | 'fragile-thin-structure'
  | 'craft-complexity'

export type PreferenceFeatureName =
  | 'silhouette'
  | 'identityFeatures'
  | 'composition'
  | 'valueOrder'
  | 'colorFidelity'
  | 'pixelClusters'
  | 'contourRhythm'
  | 'thinStructure'
  | 'boundaryAnchors'
  | 'material'
  | 'styleFit'
  | 'craftEase'

export type PreferenceFeatureVector = Readonly<Record<PreferenceFeatureName, number>>
export type PreferenceAxisScores = Readonly<Record<PreferenceAxis, number>>

export interface PreferenceModelIdentity {
  name: string
  version: string
  weightSource: string
  license: string
}

export interface PreferenceCandidateV2 {
  id: string
  route: PreferenceCandidateRoute
  style: PatternStyle
  paletteId: string
  grid: GridSize
  model?: PreferenceModelIdentity
  features: PreferenceFeatureVector
}

export interface PreferenceSourceIdentity {
  id: string
  groupId?: string
  digest?: string
  subjectKind: PreferenceSubjectKind
}

export interface PreferenceAnnotatorIdentity {
  anonymousId: string
  cohort?: string
}

export interface PreferenceCellSelection {
  x: number
  y: number
}

export interface PreferenceRegionSelection {
  x: number
  y: number
  width: number
  height: number
}

export interface PreferenceIssueAnnotation {
  id: string
  candidateId: string
  issue: PreferenceIssue
  severity: 1 | 2 | 3 | 4 | 5
  confidence: number
  region?: PreferenceRegionSelection
  cells?: readonly PreferenceCellSelection[]
  note?: string
}

export interface PreferenceComparisonV2 {
  candidateAId: string
  candidateBId: string
  choice: 'a' | 'b' | 'tie'
  weight?: number
}

export interface PreferenceElimination {
  candidateId: string
  reason: string
}

export interface PreferenceCompositeChoice {
  candidateIds: readonly string[]
  note?: string
}

export interface PreferenceRecordV2 {
  schemaVersion: 2
  id: string
  generationId: string
  source: PreferenceSourceIdentity
  candidates: readonly PreferenceCandidateV2[]
  annotator: PreferenceAnnotatorIdentity
  axisScores: Readonly<Record<string, PreferenceAxisScores>>
  issueAnnotations: readonly PreferenceIssueAnnotation[]
  comparisons: readonly PreferenceComparisonV2[]
  ranking?: readonly string[]
  bestCandidateId?: string
  eliminations: readonly PreferenceElimination[]
  compositeChoice?: PreferenceCompositeChoice
  createdAt: string
  updatedAt: string
}

export interface PreferenceReplayResult {
  record: PreferenceRecordV2
  canonicalJson: string
  fingerprint: string
}

export interface PreferenceV1MigrationContext {
  generationId: string
  source: PreferenceSourceIdentity
  candidates: readonly PreferenceCandidateV2[]
  timestamp: string
}

export interface PreferenceWorkbenchConversionOptions {
  recordId?: string
  modelLicenses?: Readonly<Record<string, string>>
  modelWeightSources?: Readonly<Record<string, string>>
}

export const PREFERENCE_AXES = [
  'subjectRecognition',
  'silhouette',
  'identityFeatures',
  'composition',
  'valueHierarchy',
  'palette',
  'contourRhythm',
  'pixelClusters',
  'material',
  'styleFit',
  'craftEase',
] as const satisfies readonly PreferenceAxis[]

export const PREFERENCE_FEATURES = [
  'silhouette',
  'identityFeatures',
  'composition',
  'valueOrder',
  'colorFidelity',
  'pixelClusters',
  'contourRhythm',
  'thinStructure',
  'boundaryAnchors',
  'material',
  'styleFit',
  'craftEase',
] as const satisfies readonly PreferenceFeatureName[]

export const PREFERENCE_ISSUES = [
  'facial-feature-loss',
  'marking-loss',
  'pattern-loss',
  'thin-structure-collapse',
  'jagged-contour',
  'isolated-cell',
  'color-stripe',
  'color-banding',
  'texture-noise',
  'value-confusion',
  'palette-deviation',
  'proportion-distortion',
  'background-dominance',
  'too-many-colors',
  'fragile-thin-structure',
  'craft-complexity',
] as const satisfies readonly PreferenceIssue[]

const subjectKinds = new Set<PreferenceSubjectKind>(['person', 'pet', 'object', 'scene'])
const candidateRoutes = new Set<PreferenceCandidateRoute>([
  'deterministic',
  'learned-pixelization',
  'generative-proposal',
])
const patternStyles = new Set<PatternStyle>(['faithful', 'cute', 'simple', 'high-contrast', 'soft'])
const preferenceIssues = new Set<PreferenceIssue>(PREFERENCE_ISSUES)
const choices = new Set<PreferenceComparisonV2['choice']>(['a', 'b', 'tie'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (isRecord(value) === false) throw new TypeError(`${label} must be an object`)
}

function assertKnownKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys)
  const unknown = Object.keys(value).find((key) => allowed.has(key) === false)
  if (unknown !== undefined) throw new RangeError(`${label} contains unknown field ${unknown}`)
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RangeError(`${label} must be a non-empty string`)
  }
}

function assertFinite(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || Number.isFinite(value) === false) {
    throw new RangeError(`${label} must be finite`)
  }
}

function assertUnit(value: unknown, label: string): asserts value is number {
  assertFinite(value, label)
  if (value < 0 || value > 1) throw new RangeError(`${label} must stay within 0..1`)
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (Number.isInteger(value) === false || (value as number) <= 0) {
    throw new RangeError(`${label} must be a positive integer`)
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label)
  const parsed = Date.parse(value)
  if (Number.isFinite(parsed) === false || new Date(parsed).toISOString() !== value) {
    throw new RangeError(`${label} must be an ISO timestamp`)
  }
}

function assertStringArray(value: unknown, label: string): asserts value is readonly string[] {
  if (Array.isArray(value) === false) throw new TypeError(`${label} must be an array`)
  for (const entry of value) assertNonEmptyString(entry, label)
  if (new Set(value).size !== value.length) throw new RangeError(`${label} must contain unique ids`)
}

function validateModelIdentity(input: unknown, label: string): void {
  assertRecord(input, label)
  assertKnownKeys(input, ['name', 'version', 'weightSource', 'license'], label)
  for (const key of ['name', 'version', 'weightSource', 'license'] as const) {
    assertNonEmptyString(input[key], `${label} ${key}`)
  }
}

function validateFeatureVector(input: unknown, label: string): void {
  assertRecord(input, label)
  assertKnownKeys(input, PREFERENCE_FEATURES, label)
  for (const name of PREFERENCE_FEATURES) assertUnit(input[name], `${label} ${name}`)
}

function validateCandidate(input: unknown, label: string): asserts input is PreferenceCandidateV2 {
  assertRecord(input, label)
  assertKnownKeys(input, ['id', 'route', 'style', 'paletteId', 'grid', 'model', 'features'], label)
  assertNonEmptyString(input.id, `${label} id`)
  if (candidateRoutes.has(input.route as PreferenceCandidateRoute) === false) {
    throw new RangeError(`${label} route is invalid`)
  }
  if (patternStyles.has(input.style as PatternStyle) === false) throw new RangeError(`${label} style is invalid`)
  assertNonEmptyString(input.paletteId, `${label} palette id`)
  assertRecord(input.grid, `${label} grid`)
  assertKnownKeys(input.grid, ['width', 'height'], `${label} grid`)
  assertPositiveInteger(input.grid.width, `${label} grid width`)
  assertPositiveInteger(input.grid.height, `${label} grid height`)
  if (input.model !== undefined) validateModelIdentity(input.model, `${label} model`)
  validateFeatureVector(input.features, `${label} features`)
}

function validateAxisScores(input: unknown, candidateIds: ReadonlySet<string>): void {
  assertRecord(input, 'Preference axis scores')
  const scoredIds = Object.keys(input)
  if (scoredIds.length > 0 && scoredIds.length !== candidateIds.size) {
    throw new RangeError('Preference axis scores must cover every candidate')
  }
  for (const [candidateId, scores] of Object.entries(input)) {
    if (candidateIds.has(candidateId) === false) throw new RangeError('Preference axis scores reference an unknown candidate')
    assertRecord(scores, `Preference axis scores ${candidateId}`)
    assertKnownKeys(scores, PREFERENCE_AXES, `Preference axis scores ${candidateId}`)
    if (Object.keys(scores).length !== PREFERENCE_AXES.length) {
      throw new RangeError(`Preference axis scores ${candidateId} must cover every axis`)
    }
    for (const axis of PREFERENCE_AXES) {
      assertFinite(scores[axis], `Preference axis score ${candidateId} ${axis}`)
      if ((scores[axis] as number) < 1 || (scores[axis] as number) > 5) {
        throw new RangeError(`Preference axis score ${candidateId} ${axis} must stay within 1..5`)
      }
    }
  }
}

function validateIssueAnnotation(
  input: unknown,
  candidateById: ReadonlyMap<string, PreferenceCandidateV2>,
  label: string,
): void {
  assertRecord(input, label)
  assertKnownKeys(input, ['id', 'candidateId', 'issue', 'severity', 'confidence', 'region', 'cells', 'note'], label)
  assertNonEmptyString(input.id, `${label} id`)
  assertNonEmptyString(input.candidateId, `${label} candidate id`)
  const candidate = candidateById.get(input.candidateId)
  if (candidate === undefined) throw new RangeError(`${label} references an unknown candidate`)
  if (preferenceIssues.has(input.issue as PreferenceIssue) === false) throw new RangeError(`${label} issue is invalid`)
  if (Number.isInteger(input.severity) === false || (input.severity as number) < 1 || (input.severity as number) > 5) {
    throw new RangeError(`${label} severity must stay within 1..5`)
  }
  assertUnit(input.confidence, `${label} confidence`)
  if (input.note !== undefined) assertNonEmptyString(input.note, `${label} note`)
  if (input.region !== undefined) {
    assertRecord(input.region, `${label} region`)
    assertKnownKeys(input.region, ['x', 'y', 'width', 'height'], `${label} region`)
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      if (Number.isInteger(input.region[key]) === false) throw new RangeError(`${label} region must use grid integers`)
    }
    const region = input.region as unknown as PreferenceRegionSelection
    if (region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0
      || region.x + region.width > candidate.grid.width
      || region.y + region.height > candidate.grid.height) {
      throw new RangeError(`${label} region must stay inside the candidate grid`)
    }
  }
  if (input.cells !== undefined) {
    if (Array.isArray(input.cells) === false || input.cells.length === 0) {
      throw new RangeError(`${label} cells must contain grid positions`)
    }
    const seen = new Set<string>()
    for (const [index, cell] of input.cells.entries()) {
      assertRecord(cell, `${label} cell ${index}`)
      assertKnownKeys(cell, ['x', 'y'], `${label} cell ${index}`)
      if (Number.isInteger(cell.x) === false || Number.isInteger(cell.y) === false
        || (cell.x as number) < 0 || (cell.y as number) < 0
        || (cell.x as number) >= candidate.grid.width || (cell.y as number) >= candidate.grid.height) {
        throw new RangeError(`${label} cell ${index} must stay inside the candidate grid`)
      }
      const key = `${cell.x},${cell.y}`
      if (seen.has(key)) throw new RangeError(`${label} cells must be unique`)
      seen.add(key)
    }
  }
}

function validateComparison(input: unknown, candidateIds: ReadonlySet<string>, label: string): void {
  assertRecord(input, label)
  assertKnownKeys(input, ['candidateAId', 'candidateBId', 'choice', 'weight'], label)
  assertNonEmptyString(input.candidateAId, `${label} candidate A`)
  assertNonEmptyString(input.candidateBId, `${label} candidate B`)
  if (candidateIds.has(input.candidateAId) === false || candidateIds.has(input.candidateBId) === false) {
    throw new RangeError(`${label} references an unknown candidate`)
  }
  if (input.candidateAId === input.candidateBId) throw new RangeError(`${label} requires distinct candidates`)
  if (choices.has(input.choice as PreferenceComparisonV2['choice']) === false) {
    throw new RangeError(`${label} choice is invalid`)
  }
  if (input.weight !== undefined) {
    assertFinite(input.weight, `${label} weight`)
    if (input.weight <= 0) throw new RangeError(`${label} weight must be positive`)
  }
}

export function validatePreferenceRecordV2(input: unknown): asserts input is PreferenceRecordV2 {
  assertRecord(input, 'Preference record')
  assertKnownKeys(input, [
    'schemaVersion', 'id', 'generationId', 'source', 'candidates', 'annotator', 'axisScores',
    'issueAnnotations', 'comparisons', 'ranking', 'bestCandidateId', 'eliminations',
    'compositeChoice', 'createdAt', 'updatedAt',
  ], 'Preference record')
  if (input.schemaVersion !== PREFERENCE_RECORD_SCHEMA_VERSION) {
    throw new RangeError('Preference record schema version is unsupported')
  }
  assertNonEmptyString(input.id, 'Preference record id')
  assertNonEmptyString(input.generationId, 'Preference generation id')
  assertRecord(input.source, 'Preference source')
  assertKnownKeys(input.source, ['id', 'groupId', 'digest', 'subjectKind'], 'Preference source')
  assertNonEmptyString(input.source.id, 'Preference source id')
  if (input.source.groupId !== undefined) assertNonEmptyString(input.source.groupId, 'Preference source group id')
  if (input.source.digest !== undefined) assertNonEmptyString(input.source.digest, 'Preference source digest')
  if (subjectKinds.has(input.source.subjectKind as PreferenceSubjectKind) === false) {
    throw new RangeError('Preference source subject kind is invalid')
  }
  if (Array.isArray(input.candidates) === false || input.candidates.length < 2 || input.candidates.length > 4) {
    throw new RangeError('Preference record requires 2..4 candidates')
  }
  input.candidates.forEach((candidate, index) => validateCandidate(candidate, `Preference candidate ${index}`))
  const candidates = input.candidates as unknown as readonly PreferenceCandidateV2[]
  const candidateIds = new Set(candidates.map((candidate) => candidate.id))
  if (candidateIds.size !== candidates.length) throw new RangeError('Preference candidate ids must be unique')
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  assertRecord(input.annotator, 'Preference annotator')
  assertKnownKeys(input.annotator, ['anonymousId', 'cohort'], 'Preference annotator')
  assertNonEmptyString(input.annotator.anonymousId, 'Preference annotator anonymous id')
  if (input.annotator.cohort !== undefined) assertNonEmptyString(input.annotator.cohort, 'Preference annotator cohort')
  validateAxisScores(input.axisScores, candidateIds)
  if (Array.isArray(input.issueAnnotations) === false) throw new TypeError('Preference issue annotations must be an array')
  input.issueAnnotations.forEach((annotation, index) =>
    validateIssueAnnotation(annotation, candidateById, `Preference issue annotation ${index}`))
  const annotationIds = (input.issueAnnotations as unknown as PreferenceIssueAnnotation[]).map((entry) => entry.id)
  if (new Set(annotationIds).size !== annotationIds.length) {
    throw new RangeError('Preference issue annotation ids must be unique')
  }
  if (Array.isArray(input.comparisons) === false) throw new TypeError('Preference comparisons must be an array')
  input.comparisons.forEach((comparison, index) =>
    validateComparison(comparison, candidateIds, `Preference comparison ${index}`))
  if (input.ranking !== undefined) {
    assertStringArray(input.ranking, 'Preference ranking')
    if (input.ranking.some((candidateId) => candidateIds.has(candidateId) === false)) {
      throw new RangeError('Preference ranking references an unknown candidate')
    }
    if (input.ranking.length !== candidateIds.size) {
      throw new RangeError('Preference ranking must cover every candidate')
    }
  }
  if (input.bestCandidateId !== undefined) {
    assertNonEmptyString(input.bestCandidateId, 'Preference best candidate id')
    if (candidateIds.has(input.bestCandidateId) === false) {
      throw new RangeError('Preference best candidate references an unknown candidate')
    }
    if (input.ranking !== undefined && input.ranking[0] !== input.bestCandidateId) {
      throw new RangeError('Preference best candidate must lead the ranking')
    }
  }
  if (Array.isArray(input.eliminations) === false) throw new TypeError('Preference eliminations must be an array')
  const eliminated = new Set<string>()
  for (const [index, elimination] of input.eliminations.entries()) {
    assertRecord(elimination, `Preference elimination ${index}`)
    assertKnownKeys(elimination, ['candidateId', 'reason'], `Preference elimination ${index}`)
    assertNonEmptyString(elimination.candidateId, `Preference elimination ${index} candidate id`)
    assertNonEmptyString(elimination.reason, `Preference elimination ${index} reason`)
    if (candidateIds.has(elimination.candidateId) === false) {
      throw new RangeError(`Preference elimination ${index} references an unknown candidate`)
    }
    if (eliminated.has(elimination.candidateId)) throw new RangeError('Preference eliminations must be unique')
    eliminated.add(elimination.candidateId)
  }
  if (input.compositeChoice !== undefined) {
    assertRecord(input.compositeChoice, 'Preference composite choice')
    assertKnownKeys(input.compositeChoice, ['candidateIds', 'note'], 'Preference composite choice')
    assertStringArray(input.compositeChoice.candidateIds, 'Preference composite candidate ids')
    if (input.compositeChoice.candidateIds.length < 2
      || input.compositeChoice.candidateIds.some((candidateId) => candidateIds.has(candidateId) === false)) {
      throw new RangeError('Preference composite choice requires 2..4 known candidates')
    }
    if (input.compositeChoice.note !== undefined) {
      assertNonEmptyString(input.compositeChoice.note, 'Preference composite choice note')
    }
  }
  assertTimestamp(input.createdAt, 'Preference created timestamp')
  assertTimestamp(input.updatedAt, 'Preference updated timestamp')
  if (Date.parse(input.updatedAt) < Date.parse(input.createdAt)) {
    throw new RangeError('Preference timestamp order is invalid')
  }
}

function normalizeCandidate(candidate: PreferenceCandidateV2): PreferenceCandidateV2 {
  const normalized: PreferenceCandidateV2 = {
    id: candidate.id.trim(),
    route: candidate.route,
    style: candidate.style,
    paletteId: candidate.paletteId.trim(),
    grid: { width: candidate.grid.width, height: candidate.grid.height },
    features: Object.fromEntries(PREFERENCE_FEATURES.map((name) => [name, candidate.features[name]])) as unknown as PreferenceFeatureVector,
  }
  if (candidate.model !== undefined) {
    normalized.model = {
      name: candidate.model.name.trim(),
      version: candidate.model.version.trim(),
      weightSource: candidate.model.weightSource.trim(),
      license: candidate.model.license.trim(),
    }
  }
  return normalized
}

function normalizeIssue(annotation: PreferenceIssueAnnotation): PreferenceIssueAnnotation {
  const normalized: PreferenceIssueAnnotation = {
    id: annotation.id.trim(),
    candidateId: annotation.candidateId.trim(),
    issue: annotation.issue,
    severity: annotation.severity,
    confidence: annotation.confidence,
  }
  if (annotation.region !== undefined) normalized.region = { ...annotation.region }
  if (annotation.cells !== undefined) {
    normalized.cells = annotation.cells
      .map((cell) => ({ x: cell.x, y: cell.y }))
      .sort((first, second) => first.y - second.y || first.x - second.x)
  }
  if (annotation.note !== undefined) normalized.note = annotation.note.trim()
  return normalized
}

function normalizeComparison(comparison: PreferenceComparisonV2): PreferenceComparisonV2 {
  const swap = comparison.candidateAId.localeCompare(comparison.candidateBId) > 0
  const normalized: PreferenceComparisonV2 = {
    candidateAId: swap ? comparison.candidateBId : comparison.candidateAId,
    candidateBId: swap ? comparison.candidateAId : comparison.candidateBId,
    choice: swap
      ? comparison.choice === 'a' ? 'b' : comparison.choice === 'b' ? 'a' : 'tie'
      : comparison.choice,
  }
  if (comparison.weight !== undefined) normalized.weight = comparison.weight
  return normalized
}

export function normalizePreferenceRecordV2(input: PreferenceRecordV2): PreferenceRecordV2 {
  validatePreferenceRecordV2(input)
  const candidates = input.candidates.map(normalizeCandidate)
    .sort((first, second) => first.id.localeCompare(second.id))
  const axisScores = Object.fromEntries(candidates
    .filter((candidate) => input.axisScores[candidate.id] !== undefined)
    .map((candidate) => [candidate.id, Object.fromEntries(PREFERENCE_AXES.map((axis) => [
      axis,
      input.axisScores[candidate.id]![axis],
    ]))])) as unknown as Readonly<Record<string, PreferenceAxisScores>>
  const source: PreferenceSourceIdentity = {
    id: input.source.id.trim(),
    subjectKind: input.source.subjectKind,
  }
  if (input.source.groupId !== undefined) source.groupId = input.source.groupId.trim()
  if (input.source.digest !== undefined) source.digest = input.source.digest.trim()
  const annotator: PreferenceAnnotatorIdentity = { anonymousId: input.annotator.anonymousId.trim() }
  if (input.annotator.cohort !== undefined) annotator.cohort = input.annotator.cohort.trim()
  const normalized: PreferenceRecordV2 = {
    schemaVersion: 2,
    id: input.id.trim(),
    generationId: input.generationId.trim(),
    source,
    candidates,
    annotator,
    axisScores,
    issueAnnotations: input.issueAnnotations.map(normalizeIssue)
      .sort((first, second) => first.id.localeCompare(second.id)),
    comparisons: input.comparisons.map(normalizeComparison)
      .sort((first, second) => first.candidateAId.localeCompare(second.candidateAId)
        || first.candidateBId.localeCompare(second.candidateBId)
        || first.choice.localeCompare(second.choice)
        || (first.weight ?? 1) - (second.weight ?? 1)),
    eliminations: input.eliminations.map((entry) => ({
      candidateId: entry.candidateId.trim(),
      reason: entry.reason.trim(),
    })).sort((first, second) => first.candidateId.localeCompare(second.candidateId)),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  }
  if (input.ranking !== undefined) normalized.ranking = [...input.ranking]
  if (input.bestCandidateId !== undefined) normalized.bestCandidateId = input.bestCandidateId.trim()
  if (input.compositeChoice !== undefined) {
    normalized.compositeChoice = {
      candidateIds: [...input.compositeChoice.candidateIds].sort(),
      ...(input.compositeChoice.note === undefined ? {} : { note: input.compositeChoice.note.trim() }),
    }
  }
  return normalized
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function semanticRecord(record: PreferenceRecordV2): unknown {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...content } = record
  return content
}

export function preferenceRecordFingerprint(input: PreferenceRecordV2): string {
  return `preference-v2-${fnv1a(JSON.stringify(semanticRecord(normalizePreferenceRecordV2(input))))}`
}

export function replayPreferenceRecord(serialized: string): PreferenceReplayResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw new TypeError('Preference replay requires valid JSON')
  }
  validatePreferenceRecordV2(parsed)
  const record = normalizePreferenceRecordV2(parsed)
  return {
    record,
    canonicalJson: JSON.stringify(record),
    fingerprint: preferenceRecordFingerprint(record),
  }
}

export function deduplicatePreferenceRecords(
  records: readonly PreferenceRecordV2[],
): readonly PreferenceRecordV2[] {
  const byFingerprint = new Map<string, PreferenceRecordV2>()
  for (const record of records.map(normalizePreferenceRecordV2)
    .sort((first, second) => first.createdAt.localeCompare(second.createdAt) || first.id.localeCompare(second.id))) {
    const fingerprint = preferenceRecordFingerprint(record)
    if (byFingerprint.has(fingerprint) === false) byFingerprint.set(fingerprint, record)
  }
  return [...byFingerprint.values()].sort((first, second) => first.id.localeCompare(second.id))
}

function emptyAxisScores(): Readonly<Record<string, PreferenceAxisScores>> {
  return {}
}

export function migratePairwisePreferenceRecord(
  input: PairwisePreferenceRecord,
  context: PreferenceV1MigrationContext,
): PreferenceRecordV2 {
  const record: PreferenceRecordV2 = {
    schemaVersion: 2,
    id: input.id?.trim() || `migrated-${fnv1a(JSON.stringify(input))}`,
    generationId: context.generationId,
    source: context.source,
    candidates: context.candidates,
    annotator: { anonymousId: input.raterId?.trim() || 'anonymous-migrated' },
    axisScores: emptyAxisScores(),
    issueAnnotations: [],
    comparisons: [{
      candidateAId: input.candidateAId,
      candidateBId: input.candidateBId,
      choice: input.choice,
      ...(input.weight === undefined ? {} : { weight: input.weight }),
    }],
    eliminations: [],
    createdAt: context.timestamp,
    updatedAt: context.timestamp,
  }
  return normalizePreferenceRecordV2(record)
}

export { preferenceRecordFromWorkbenchSession } from './preference-workbench-adapter.js'

export {
  BASELINE_PREFERENCE_WEIGHTS,
  comparePreferenceModels,
  createFrozenPreferenceSplit,
  derivePreferenceGenerationParameters,
  fitPreferenceModelV2,
  rankPreferenceCandidates,
  selectActivePreferencePair,
  selectPreferenceModelVersion,
} from './preference-learning.js'
export type {
  ActivePreferencePairOptions,
  ActivePreferencePair,
  ComparedPreferencePair,
  FrozenPreferenceSplit,
  FrozenPreferenceSplitOptions,
  PreferenceCandidateRankScore,
  PreferenceEvaluationMetrics,
  PreferenceGenerationAdjustments,
  PreferenceGenerationParameters,
  PreferenceModelComparison,
  PreferenceModelContext,
  PreferenceModelOptions,
  PreferenceModelSelection,
  PreferenceModelSelectionOptions,
  PreferenceModelV2,
  PreferenceRankingResult,
  PreferenceStratumModel,
} from './preference-learning.js'
