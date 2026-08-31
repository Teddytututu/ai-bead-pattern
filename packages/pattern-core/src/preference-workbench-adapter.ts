import {
  PREFERENCE_FEATURES,
  PREFERENCE_ISSUES,
  normalizePreferenceRecordV2,
  type PreferenceAxis,
  type PreferenceAxisScores,
  type PreferenceCandidateRoute,
  type PreferenceCandidateV2,
  type PreferenceElimination,
  type PreferenceFeatureVector,
  type PreferenceIssue,
  type PreferenceIssueAnnotation,
  type PreferenceRecordV2,
  type PreferenceRegionSelection,
  type PreferenceSourceIdentity,
  type PreferenceSubjectKind,
  type PreferenceWorkbenchConversionOptions,
} from './preference-v2.js'
import type { PatternStyle } from './types.js'

const axisMapping: Readonly<Record<string, PreferenceAxis>> = {
  recognition: 'subjectRecognition',
  silhouette: 'silhouette',
  identity: 'identityFeatures',
  composition: 'composition',
  value: 'valueHierarchy',
  palette: 'palette',
  contour: 'contourRhythm',
  cluster: 'pixelClusters',
  material: 'material',
  style: 'styleFit',
  craft: 'craftEase',
}

const styleIds = new Set<PatternStyle>(['faithful', 'cute', 'simple', 'high-contrast', 'soft'])

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RangeError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function positiveInteger(value: unknown, label: string): number {
  if (Number.isInteger(value) === false || (value as number) <= 0) {
    throw new RangeError(`${label} must be a positive integer`)
  }
  return value as number
}

function unitValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || Number.isFinite(value) === false || value < 0 || value > 1) {
    throw new RangeError(`${label} must stay within 0..1`)
  }
  return value
}

function timestampValue(value: unknown, label: string): string {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) === false || value < 0) throw new RangeError(`${label} is invalid`)
    return new Date(value).toISOString()
  }
  const text = textValue(value, label)
  const parsed = Date.parse(text)
  if (Number.isFinite(parsed) === false || new Date(parsed).toISOString() !== text) {
    throw new RangeError(`${label} must be an ISO timestamp or epoch milliseconds`)
  }
  return text
}

function subjectKind(value: unknown): PreferenceSubjectKind {
  const mapping: Readonly<Record<string, PreferenceSubjectKind>> = {
    person: 'person',
    portrait: 'person',
    pet: 'pet',
    object: 'object',
    general: 'object',
    illustration: 'object',
    scene: 'scene',
    landscape: 'scene',
  }
  return typeof value === 'string' ? mapping[value] ?? 'object' : 'object'
}

function candidateRoute(value: unknown): PreferenceCandidateRoute {
  if (value === 'learned-pixelization' || value === 'generative-proposal') return value
  return 'deterministic'
}

function metricValue(metrics: Readonly<Record<string, unknown>>, names: readonly string[]): number | undefined {
  for (const name of names) {
    const value = metrics[name]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function mean(values: readonly (number | undefined)[], fallback = 0.5): number {
  const available = values.filter((value): value is number => value !== undefined)
  return available.length === 0
    ? fallback
    : available.reduce((sum, value) => sum + value, 0) / available.length
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function featureVector(candidate: Readonly<Record<string, unknown>>, width: number, height: number): PreferenceFeatureVector {
  if (candidate.features !== undefined) {
    const direct = objectValue(candidate.features, 'Workbench candidate features')
    const entries = PREFERENCE_FEATURES.map((name) => [name, unitValue(direct[name], `Workbench feature ${name}`)])
    return Object.fromEntries(entries) as unknown as PreferenceFeatureVector
  }
  const metrics = candidate.metrics === undefined ? {} : objectValue(candidate.metrics, 'Workbench candidate metrics')
  const cells = width * height
  const silhouette = clampUnit(mean([
    metricValue(metrics, ['silhouetteBoundaryIoU']),
    metricValue(metrics, ['subjectCoverageIoU']),
    metricValue(metrics, ['sourceBoundaryAgreement']),
  ]))
  const identityFeatures = clampUnit(mean([
    metricValue(metrics, ['featureCoverage']),
    metricValue(metrics, ['featurePurity']),
    metricValue(metrics, ['featureConnectivity']),
    metricValue(metrics, ['featureVisibilityConfidence']),
  ]))
  const occupancy = metricValue(metrics, ['subjectOccupancyRatio'])
  const composition = occupancy === undefined ? 0.5 : clampUnit(1 - Math.abs(occupancy - 0.65) / 0.65)
  const valueOrder = clampUnit(metricValue(metrics, ['valueOrderAccuracy']) ?? 0.5)
  const colorDistance = metricValue(metrics, ['referenceMeanColorDistance', 'meanColorDistance'])
  const colorFidelity = colorDistance === undefined ? 0.5 : clampUnit(1 - colorDistance / 50)
  const isolated = Math.max(0, metricValue(metrics, ['isolatedCells']) ?? 0)
  const stripes = Math.max(0, metricValue(metrics, ['thinStripes']) ?? 0)
  const pixelClusters = clampUnit(1 - (isolated + stripes) / Math.max(1, cells * 0.04))
  const contourRhythm = clampUnit(mean([
    metricValue(metrics, ['sourceBoundaryAgreement']),
    metricValue(metrics, ['planBoundaryAgreement']),
    silhouette,
  ]))
  const thinStructure = clampUnit(mean([
    metricValue(metrics, ['featureConnectivity']),
    1 - stripes / Math.max(1, cells * 0.025),
  ]))
  const boundaryAnchors = clampUnit(mean([
    metricValue(metrics, ['sourceBoundaryAgreement']),
    metricValue(metrics, ['planBoundaryAgreement']),
    silhouette,
  ]))
  const material = clampUnit(metricValue(metrics, ['paletteRoleConsistency']) ?? 0.5)
  const styleFit = clampUnit(metricValue(metrics, ['styleFit']) ?? 0.5)
  const colors = Math.max(0, metricValue(metrics, ['uniqueColors']) ?? 0)
  const beads = Math.max(0, metricValue(metrics, ['totalBeads']) ?? 0)
  const craftEase = clampUnit(1 - 0.5 * Math.min(1, colors / 48)
    - 0.2 * Math.min(1, beads / cells)
    - 0.3 * Math.min(1, (isolated + stripes) / Math.max(1, cells * 0.04)))
  return {
    silhouette,
    identityFeatures,
    composition,
    valueOrder,
    colorFidelity,
    pixelClusters,
    contourRhythm,
    thinStructure,
    boundaryAnchors,
    material,
    styleFit,
    craftEase,
  }
}

function convertCandidate(
  input: unknown,
  options: PreferenceWorkbenchConversionOptions,
): PreferenceCandidateV2 {
  const candidate = objectValue(input, 'Workbench candidate')
  const pattern = objectValue(candidate.pattern, 'Workbench candidate pattern')
  const width = positiveInteger(pattern.width, 'Workbench candidate width')
  const height = positiveInteger(pattern.height, 'Workbench candidate height')
  const source = candidate.source === undefined ? {} : objectValue(candidate.source, 'Workbench candidate source')
  const palette = candidate.palette === undefined ? {} : objectValue(candidate.palette, 'Workbench candidate palette')
  const style = styleIds.has(candidate.style as PatternStyle) ? candidate.style as PatternStyle : 'faithful'
  const modelName = typeof source.model === 'string' && source.model.trim().length > 0
    ? source.model.trim()
    : undefined
  const result: PreferenceCandidateV2 = {
    id: textValue(candidate.id, 'Workbench candidate id'),
    route: candidateRoute(source.route),
    style,
    paletteId: typeof palette.id === 'string' && palette.id.trim().length > 0
      ? palette.id.trim()
      : 'unknown-palette',
    grid: { width, height },
    features: featureVector(candidate, width, height),
  }
  if (modelName !== undefined) {
    result.model = {
      name: modelName,
      version: typeof source.version === 'string' && source.version.trim().length > 0
        ? source.version.trim()
        : 'unknown',
      weightSource: options.modelWeightSources?.[modelName] ?? 'workbench-session',
      license: options.modelLicenses?.[modelName] ?? 'unknown',
    }
  }
  return result
}

function convertScores(input: unknown, candidates: readonly PreferenceCandidateV2[]): Readonly<Record<string, PreferenceAxisScores>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {}
  const source = input as Record<string, unknown>
  const output: Record<string, PreferenceAxisScores> = {}
  for (const candidate of candidates) {
    if (typeof source[candidate.id] !== 'object' || source[candidate.id] === null) return {}
    const candidateScores = source[candidate.id] as Record<string, unknown>
    const entries: [PreferenceAxis, number][] = []
    for (const [sessionAxis, recordAxis] of Object.entries(axisMapping)) {
      const score = candidateScores[sessionAxis]
      if (Number.isInteger(score) === false || (score as number) < 1 || (score as number) > 5) return {}
      entries.push([recordAxis, score as number])
    }
    output[candidate.id] = Object.fromEntries(entries) as unknown as PreferenceAxisScores
  }
  return output
}

function convertRegion(input: unknown, candidate: PreferenceCandidateV2): PreferenceRegionSelection | undefined {
  if (input === undefined) return undefined
  const region = objectValue(input, 'Workbench issue region')
  const xRatio = unitValue(region.x, 'Workbench issue region x')
  const yRatio = unitValue(region.y, 'Workbench issue region y')
  const widthRatio = unitValue(region.width, 'Workbench issue region width')
  const heightRatio = unitValue(region.height, 'Workbench issue region height')
  if (widthRatio === 0 || heightRatio === 0 || xRatio + widthRatio > 1 || yRatio + heightRatio > 1) {
    throw new RangeError('Workbench issue region must stay inside the normalized image')
  }
  const x = Math.min(candidate.grid.width - 1, Math.floor(xRatio * candidate.grid.width))
  const y = Math.min(candidate.grid.height - 1, Math.floor(yRatio * candidate.grid.height))
  const endX = Math.max(x + 1, Math.ceil((xRatio + widthRatio) * candidate.grid.width))
  const endY = Math.max(y + 1, Math.ceil((yRatio + heightRatio) * candidate.grid.height))
  return { x, y, width: endX - x, height: endY - y }
}

export function preferenceRecordFromWorkbenchSession(
  input: unknown,
  options: PreferenceWorkbenchConversionOptions = {},
): PreferenceRecordV2 {
  const session = objectValue(input, 'Preference workbench session')
  if (session.schemaVersion !== 'preference-session-v2') {
    throw new RangeError('Preference workbench session schema is unsupported')
  }
  const generationId = textValue(session.generationId, 'Preference workbench generation id')
  const sourceInput = objectValue(session.source, 'Preference workbench source')
  const annotatorId = textValue(session.annotatorId, 'Preference workbench annotator id')
  const candidateInputs = objectValue(session.candidates, 'Preference workbench candidates')
  if (Array.isArray(session.candidateOrder) === false || session.candidateOrder.length < 2
    || session.candidateOrder.length > 4) {
    throw new RangeError('Preference workbench requires 2..4 ordered candidates')
  }
  const candidateOrder = session.candidateOrder.map((id) => textValue(id, 'Preference workbench candidate id'))
  if (new Set(candidateOrder).size !== candidateOrder.length) {
    throw new RangeError('Preference workbench candidate ids must be unique')
  }
  const candidates = candidateOrder.map((candidateId) => {
    const candidate = candidateInputs[candidateId]
    if (candidate === undefined) throw new RangeError('Preference workbench candidate order references an unknown candidate')
    return convertCandidate(candidate, options)
  })
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  const annotations: PreferenceIssueAnnotation[] = []
  if (session.annotations !== undefined) {
    if (Array.isArray(session.annotations) === false) throw new TypeError('Preference workbench annotations must be an array')
    for (const raw of session.annotations) {
      const annotation = objectValue(raw, 'Preference workbench annotation')
      const candidateId = textValue(annotation.candidateId, 'Preference workbench annotation candidate id')
      const candidate = candidateById.get(candidateId)
      if (candidate === undefined) throw new RangeError('Preference workbench annotation references an unknown candidate')
      if (PREFERENCE_ISSUES.includes(annotation.tag as PreferenceIssue) === false) {
        throw new RangeError('Preference workbench annotation issue is unsupported')
      }
      if (Number.isInteger(annotation.severity) === false
        || (annotation.severity as number) < 1 || (annotation.severity as number) > 3) {
        throw new RangeError('Preference workbench annotation severity must stay within 1..3')
      }
      const converted: PreferenceIssueAnnotation = {
        id: textValue(annotation.id, 'Preference workbench annotation id'),
        candidateId,
        issue: annotation.tag as PreferenceIssue,
        severity: ([1, 3, 5] as const)[(annotation.severity as number) - 1]!,
        confidence: unitValue(annotation.confidence, 'Preference workbench annotation confidence'),
      }
      const region = convertRegion(annotation.region, candidate)
      if (region !== undefined) converted.region = region
      if (Array.isArray(annotation.cells) && annotation.cells.length > 0) {
        converted.cells = annotation.cells.map((rawCell) => {
          const cell = objectValue(rawCell, 'Preference workbench annotation cell')
          return { x: cell.x as number, y: cell.y as number }
        })
      }
      if (typeof annotation.note === 'string' && annotation.note.trim().length > 0) {
        converted.note = annotation.note.trim()
      }
      annotations.push(converted)
    }
  }
  const comparisons: PreferenceRecordV2['comparisons'][number][] = []
  const compositeIds = new Set<string>()
  if (session.comparisons !== undefined) {
    if (Array.isArray(session.comparisons) === false) throw new TypeError('Preference workbench comparisons must be an array')
    for (const raw of session.comparisons) {
      const comparison = objectValue(raw, 'Preference workbench comparison')
      if (Array.isArray(comparison.candidateIds) === false || comparison.candidateIds.length < 2) {
        throw new RangeError('Preference workbench comparison requires two candidates')
      }
      const ids = comparison.candidateIds.map((id) => textValue(id, 'Preference workbench comparison candidate id'))
      ids.forEach((id) => {
        if (candidateById.has(id) === false) throw new RangeError('Preference workbench comparison references an unknown candidate')
      })
      if (comparison.choice === 'composite') {
        ids.forEach((id) => compositeIds.add(id))
        continue
      }
      const choice = comparison.choice === 'first' ? 'a'
        : comparison.choice === 'second' ? 'b'
          : comparison.choice === 'tie' ? 'tie' : undefined
      if (choice === undefined) throw new RangeError('Preference workbench comparison choice is unsupported')
      comparisons.push({ candidateAId: ids[0]!, candidateBId: ids[1]!, choice })
    }
  }
  const eliminations: PreferenceElimination[] = []
  let ranking: readonly string[] | undefined
  let bestCandidateId: string | undefined
  if (session.ranking !== undefined) {
    const rankingInput = objectValue(session.ranking, 'Preference workbench ranking')
    if (Array.isArray(rankingInput.order) === false) throw new TypeError('Preference workbench ranking order must be an array')
    ranking = rankingInput.order.map((id) => textValue(id, 'Preference workbench ranking candidate id'))
    if (rankingInput.bestCandidateId !== undefined) {
      bestCandidateId = textValue(rankingInput.bestCandidateId, 'Preference workbench best candidate id')
    }
    if (Array.isArray(rankingInput.eliminated)) {
      for (const raw of rankingInput.eliminated) {
        const elimination = objectValue(raw, 'Preference workbench elimination')
        const reasons = Array.isArray(elimination.reasons)
          ? elimination.reasons.filter((reason): reason is string => typeof reason === 'string' && reason.trim().length > 0)
          : []
        eliminations.push({
          candidateId: textValue(elimination.candidateId, 'Preference workbench elimination candidate id'),
          reason: reasons.length === 0 ? 'workbench-eliminated' : reasons.map((reason) => reason.trim()).join('; '),
        })
      }
    }
    if (Array.isArray(rankingInput.compositeCandidateIds)) {
      rankingInput.compositeCandidateIds.forEach((id) => {
        if (typeof id === 'string' && id.trim().length > 0) compositeIds.add(id.trim())
      })
    }
  }
  const source: PreferenceSourceIdentity = {
    id: textValue(sourceInput.id, 'Preference workbench source id'),
    subjectKind: subjectKind(sourceInput.subjectKind ?? sourceInput.kind),
  }
  if (typeof sourceInput.groupId === 'string' && sourceInput.groupId.trim().length > 0) {
    source.groupId = sourceInput.groupId.trim()
  }
  if (typeof sourceInput.digest === 'string' && sourceInput.digest.trim().length > 0) {
    source.digest = sourceInput.digest.trim()
  }
  const createdAt = timestampValue(session.createdAt, 'Preference workbench created timestamp')
  const updatedAt = timestampValue(session.updatedAt, 'Preference workbench updated timestamp')
  const record: PreferenceRecordV2 = {
    schemaVersion: 2,
    id: options.recordId ?? `workbench-${generationId}-${updatedAt}`,
    generationId,
    source,
    candidates,
    annotator: { anonymousId: annotatorId },
    axisScores: convertScores(session.axisScores, candidates),
    issueAnnotations: annotations,
    comparisons,
    eliminations,
    createdAt,
    updatedAt,
  }
  if (ranking !== undefined) record.ranking = ranking
  if (bestCandidateId !== undefined) record.bestCandidateId = bestCandidateId
  if (compositeIds.size >= 2) record.compositeChoice = { candidateIds: [...compositeIds].sort() }
  return normalizePreferenceRecordV2(record)
}
