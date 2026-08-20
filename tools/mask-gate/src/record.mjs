const preferences = new Set(['before', 'after', 'tie', 'unrated'])
const deviceClasses = new Set(['desktop', 'mobile', 'tablet'])
const outcomes = new Set(['confirmed', 'cancelled', 'error'])

function finite(value, name) {
  if (Number.isFinite(value) === false) throw new TypeError(`${name} must be finite`)
  return value
}

function unit(value, name) {
  finite(value, name)
  if (value < 0 || value > 1) throw new RangeError(`${name} must be within 0..1`)
  return value
}

function text(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function boolean(value, name) {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be boolean`)
  return value
}

function validateSession(session) {
  if (session === null || typeof session !== 'object') {
    throw new TypeError('session must be an object')
  }
  text(session.baseRevision, 'session.baseRevision')
  if (Array.isArray(session.strokes) === false) {
    throw new TypeError('session.strokes must be an array')
  }
  if (Number.isInteger(session.cursor) === false
    || session.cursor < 0 || session.cursor > session.strokes.length) {
    throw new RangeError('session.cursor must select a valid stroke prefix')
  }
  for (const [index, stroke] of session.strokes.entries()) {
    text(stroke?.id, `session.strokes[${index}].id`)
    if (stroke.mode !== 'add' && stroke.mode !== 'erase') {
      throw new RangeError(`session.strokes[${index}].mode has an unsupported value`)
    }
  }
  return session
}

export function correctionAreaRatio(baseValues, correctedValues, threshold = 1 / 255) {
  if (baseValues?.length === undefined || correctedValues?.length === undefined
    || baseValues.length === 0 || baseValues.length !== correctedValues.length) {
    throw new RangeError('Mask buffers must have the same positive length')
  }
  finite(threshold, 'threshold')
  if (threshold < 0 || threshold > 1) throw new RangeError('threshold must be within 0..1')
  let changed = 0
  for (let index = 0; index < baseValues.length; index += 1) {
    if (Math.abs(baseValues[index] - correctedValues[index]) >= threshold) changed += 1
  }
  return changed / baseValues.length
}

export function createMaskGateRecord(input) {
  const session = validateSession(input.session)
  const sourceRevision = text(input.sourceEvidence?.revision, 'sourceEvidence.revision')
  if (session.baseRevision !== sourceRevision) {
    throw new RangeError('session.baseRevision must match sourceEvidence.revision')
  }
  const startedAt = finite(input.correctionStartedAt, 'correctionStartedAt')
  const endedAt = finite(input.correctionEndedAt, 'correctionEndedAt')
  if (endedAt < startedAt) {
    throw new RangeError('correctionEndedAt must be greater than or equal to correctionStartedAt')
  }
  const activeStrokes = session.strokes.slice(0, session.cursor)
  const addStrokeCount = activeStrokes.filter((stroke) => stroke.mode === 'add').length
  const eraseStrokeCount = activeStrokes.length - addStrokeCount
  const preference = text(input.patternPreference, 'patternPreference')
  if (preferences.has(preference) === false) {
    throw new RangeError('patternPreference has an unsupported value')
  }
  const deviceClass = text(input.deviceClass, 'deviceClass')
  if (deviceClasses.has(deviceClass) === false) {
    throw new RangeError('deviceClass has an unsupported value')
  }
  const outcome = text(input.outcome, 'outcome')
  if (outcomes.has(outcome) === false) {
    throw new RangeError('outcome has an unsupported value')
  }
  if (outcome === 'confirmed' && preference === 'unrated') {
    throw new RangeError('Confirmed attempts require a pattern preference')
  }
  const confirmedRevision = input.confirmedRevision === undefined
    ? undefined
    : text(input.confirmedRevision, 'confirmedRevision')
  const afterGenerationId = input.afterGenerationId === undefined
    ? undefined
    : text(input.afterGenerationId, 'afterGenerationId')
  if (outcome === 'confirmed' && (confirmedRevision === undefined || afterGenerationId === undefined)) {
    throw new RangeError('Confirmed attempts require revision and after-generation identity')
  }
  const subjectAcceptable = boolean(input.subjectAcceptable, 'subjectAcceptable')
  if (outcome !== 'confirmed' && (
    preference !== 'unrated'
    || subjectAcceptable
    || confirmedRevision !== undefined
    || afterGenerationId !== undefined
  )) {
    throw new RangeError('Cancelled and error outcomes require unrated fields without confirmation artifacts')
  }

  return {
    schemaVersion: 1,
    datasetId: text(input.datasetId, 'datasetId'),
    imageId: text(input.sample?.imageId, 'sample.imageId'),
    category: text(input.sample?.category, 'sample.category'),
    cohort: text(input.sample?.cohort, 'sample.cohort'),
    failureType: text(input.sample?.failureType, 'sample.failureType'),
    sourceRevision,
    sourceConfidence: unit(input.sourceEvidence?.confidence, 'sourceEvidence.confidence'),
    correctionStartedAt: startedAt,
    correctionEndedAt: endedAt,
    correctionDurationMs: endedAt - startedAt,
    strokeCount: activeStrokes.length,
    addStrokeCount,
    eraseStrokeCount,
    correctionAreaRatio: correctionAreaRatio(input.baseMaskValues, input.correctedMaskValues),
    beforeGenerationId: text(input.beforeGenerationId, 'beforeGenerationId'),
    ...(confirmedRevision === undefined ? {} : { confirmedRevision }),
    ...(afterGenerationId === undefined ? {} : { afterGenerationId }),
    initialSubjectAcceptable: boolean(input.initialSubjectAcceptable, 'initialSubjectAcceptable'),
    subjectAcceptable,
    patternPreference: preference,
    deviceClass,
    outcome,
    session,
  }
}

export function validateMaskGateRecord(value) {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('Mask gate record must be an object')
  }
  const reconstructed = createMaskGateRecord({
    sample: value,
    datasetId: value.datasetId,
    sourceEvidence: { revision: value.sourceRevision, confidence: value.sourceConfidence },
    session: value.session,
    confirmedRevision: value.confirmedRevision,
    correctionStartedAt: value.correctionStartedAt,
    correctionEndedAt: value.correctionEndedAt,
    beforeGenerationId: value.beforeGenerationId,
    afterGenerationId: value.afterGenerationId,
    initialSubjectAcceptable: value.initialSubjectAcceptable,
    subjectAcceptable: value.subjectAcceptable,
    patternPreference: value.patternPreference,
    deviceClass: value.deviceClass,
    outcome: value.outcome,
    baseMaskValues: Float32Array.from([0]),
    correctedMaskValues: Float32Array.from([value.correctionAreaRatio > 0 ? 1 : 0]),
  })
  finite(value.correctionDurationMs, 'correctionDurationMs')
  if (value.correctionDurationMs !== reconstructed.correctionDurationMs) {
    throw new RangeError('correctionDurationMs must match the recorded timestamps')
  }
  if (value.strokeCount !== reconstructed.strokeCount
    || value.addStrokeCount !== reconstructed.addStrokeCount
    || value.eraseStrokeCount !== reconstructed.eraseStrokeCount) {
    throw new RangeError('Stroke counts must match the active session prefix')
  }
  unit(value.correctionAreaRatio, 'correctionAreaRatio')
  return { ...value }
}
