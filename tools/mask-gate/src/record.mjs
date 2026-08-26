import {
  createBlindComparison,
  maskGateProtocolVersion,
  resolveBlindPreference,
} from './protocol.mjs'

const deviceClasses = new Set(['desktop', 'mobile', 'tablet'])
const inputModalities = new Set(['touch', 'pen', 'mouse'])
const outcomes = new Set(['accepted', 'confirmed', 'cancelled', 'error'])

function finite(value, name) {
  if (Number.isFinite(value) === false) throw new TypeError(`${name} must be finite`)
  return value
}

function unit(value, name) {
  finite(value, name)
  if (value < 0 || value > 1) throw new RangeError(`${name} must be within 0..1`)
  return value
}

function integer(value, name, minimum = 0) {
  if (Number.isInteger(value) === false || value < minimum) {
    throw new RangeError(`${name} must be an integer greater than or equal to ${minimum}`)
  }
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

function optionalText(value, name) {
  return value === undefined ? undefined : text(value, name)
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

function validateSnapshot(value, name) {
  if (value === null || typeof value !== 'object') throw new TypeError(`${name} must be an object`)
  return {
    generationId: text(value.generationId, `${name}.generationId`),
    candidateId: text(value.candidateId, `${name}.candidateId`),
    patternHash: text(value.patternHash, `${name}.patternHash`),
    optionsHash: text(value.optionsHash, `${name}.optionsHash`),
    width: integer(value.width, `${name}.width`, 1),
    height: integer(value.height, `${name}.height`, 1),
    colorCount: integer(value.colorCount, `${name}.colorCount`),
    totalBeads: integer(value.totalBeads, `${name}.totalBeads`),
  }
}

function validateDevice(value) {
  if (value === null || typeof value !== 'object') throw new TypeError('device must be an object')
  const deviceClass = text(value.class, 'device.class')
  if (deviceClasses.has(deviceClass) === false) {
    throw new RangeError('device.class has an unsupported value')
  }
  const inputModality = text(value.inputModality, 'device.inputModality')
  if (inputModalities.has(inputModality) === false) {
    throw new RangeError('device.inputModality has an unsupported value')
  }
  return {
    class: deviceClass,
    inputModality,
    viewportWidth: integer(value.viewportWidth, 'device.viewportWidth', 1),
    viewportHeight: integer(value.viewportHeight, 'device.viewportHeight', 1),
    devicePixelRatio: finite(value.devicePixelRatio, 'device.devicePixelRatio'),
    maxTouchPoints: integer(value.maxTouchPoints, 'device.maxTouchPoints'),
    platform: text(value.platform, 'device.platform'),
  }
}

function validateFailureTags(value) {
  if (Array.isArray(value) === false || value.length === 0) {
    throw new RangeError('sample.failureTags must contain at least one value')
  }
  const tags = value.map((tag, index) => text(tag, `sample.failureTags[${index}]`))
  if (new Set(tags).size !== tags.length) {
    throw new RangeError('sample.failureTags must contain unique values')
  }
  return tags
}

function identity(input) {
  const protocolVersion = text(input.protocolVersion, 'protocolVersion')
  if (protocolVersion !== maskGateProtocolVersion) {
    throw new RangeError(`protocolVersion must equal ${maskGateProtocolVersion}`)
  }
  return {
    protocolVersion,
    attemptId: text(input.attemptId, 'attemptId'),
    datasetId: text(input.datasetId, 'datasetId'),
    manifestFingerprint: text(input.manifestFingerprint, 'manifestFingerprint'),
    imageId: text(input.sample?.imageId, 'sample.imageId'),
    category: text(input.sample?.category, 'sample.category'),
    cohort: text(input.sample?.cohort, 'sample.cohort'),
    failureTags: validateFailureTags(input.sample?.failureTags),
    raterId: text(input.raterId, 'raterId'),
    sampleOrder: integer(input.sampleOrder, 'sampleOrder', 1),
    sampleOrderSeed: text(input.sampleOrderSeed, 'sampleOrderSeed'),
    coreCommit: text(input.coreCommit, 'coreCommit'),
    demoCommit: text(input.demoCommit, 'demoCommit'),
    gatewayCommit: text(input.gatewayCommit, 'gatewayCommit'),
    modelConfigurationId: text(input.modelConfigurationId, 'modelConfigurationId'),
  }
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

function correctionFields(input, outcome, sourceRevision) {
  if (outcome === 'accepted' || (outcome === 'error' && input.correctionStartedAt === undefined)) {
    return {
      strokeCount: 0,
      addStrokeCount: 0,
      eraseStrokeCount: 0,
      correctionAreaRatio: 0,
    }
  }
  const session = validateSession(input.session)
  if (session.baseRevision !== sourceRevision) {
    throw new RangeError('session.baseRevision must match sourceEvidence.revision')
  }
  const startedAt = finite(input.correctionStartedAt, 'correctionStartedAt')
  const endedAt = finite(input.correctionEndedAt, 'correctionEndedAt')
  if (endedAt < startedAt) {
    throw new RangeError('correctionEndedAt must follow correctionStartedAt')
  }
  const activeStrokes = session.strokes.slice(0, session.cursor)
  const addStrokeCount = activeStrokes.filter((stroke) => stroke.mode === 'add').length
  return {
    correctionStartedAt: startedAt,
    correctionEndedAt: endedAt,
    correctionDurationMs: endedAt - startedAt,
    strokeCount: activeStrokes.length,
    addStrokeCount,
    eraseStrokeCount: activeStrokes.length - addStrokeCount,
    correctionAreaRatio: correctionAreaRatio(input.baseMaskValues, input.correctedMaskValues),
    session,
  }
}

export function createMaskGateInteractionRecord(input) {
  const recordIdentity = identity(input)
  const sourceRevision = text(input.sourceEvidence?.revision, 'sourceEvidence.revision')
  const outcome = text(input.outcome, 'outcome')
  if (outcomes.has(outcome) === false) throw new RangeError('outcome has an unsupported value')
  const initialSubjectAcceptable = boolean(
    input.initialSubjectAcceptable,
    'initialSubjectAcceptable',
  )
  if (outcome === 'accepted' && initialSubjectAcceptable === false) {
    throw new RangeError('accepted outcome requires an acceptable initial subject')
  }
  if (outcome !== 'accepted' && initialSubjectAcceptable) {
    throw new RangeError('edited and error outcomes require an initial failure rating')
  }
  const correction = correctionFields(input, outcome, sourceRevision)
  const confirmedRevision = optionalText(input.confirmedRevision, 'confirmedRevision')
  const afterSnapshot = input.afterSnapshot === undefined
    ? undefined
    : validateSnapshot(input.afterSnapshot, 'afterSnapshot')
  const subjectAcceptable = input.subjectAcceptable === undefined
    ? undefined
    : boolean(input.subjectAcceptable, 'subjectAcceptable')
  if (outcome === 'confirmed'
    && (confirmedRevision === undefined || afterSnapshot === undefined
      || subjectAcceptable === undefined)) {
    throw new RangeError('confirmed outcome requires correction result artifacts')
  }
  if (outcome !== 'confirmed'
    && (confirmedRevision !== undefined || afterSnapshot !== undefined
      || subjectAcceptable !== undefined)) {
    throw new RangeError('terminal outcome contains confirmation-only artifacts')
  }
  const error = input.error === undefined
    ? undefined
    : {
      code: text(input.error.code, 'error.code'),
      message: text(input.error.message, 'error.message'),
    }
  if ((outcome === 'error') !== (error !== undefined)) {
    throw new RangeError('error outcome must align with error details')
  }

  return {
    schemaVersion: 2,
    ...recordIdentity,
    sourceRevision,
    sourceConfidence: unit(input.sourceEvidence?.confidence, 'sourceEvidence.confidence'),
    initialRatingAt: finite(input.initialRatingAt, 'initialRatingAt'),
    initialSubjectAcceptable,
    outcome,
    outcomeAt: finite(input.outcomeAt, 'outcomeAt'),
    beforeSnapshot: validateSnapshot(input.beforeSnapshot, 'beforeSnapshot'),
    device: validateDevice(input.device),
    ...correction,
    ...(confirmedRevision === undefined ? {} : { confirmedRevision }),
    ...(afterSnapshot === undefined ? {} : { afterSnapshot }),
    ...(subjectAcceptable === undefined ? {} : { subjectAcceptable }),
    ...(error === undefined ? {} : { error }),
  }
}

export function createMaskGatePreferenceRecord(input) {
  const recordIdentity = identity(input)
  const blindComparison = {
    leftVariant: input.blindComparison?.leftVariant,
    choice: input.blindComparison?.choice,
    seed: text(input.blindComparison?.seed, 'blindComparison.seed'),
  }
  const patternPreference = resolveBlindPreference(blindComparison)
  return {
    schemaVersion: 2,
    protocolVersion: recordIdentity.protocolVersion,
    preferenceId: `${recordIdentity.imageId}:${recordIdentity.raterId}`,
    attemptId: recordIdentity.attemptId,
    datasetId: recordIdentity.datasetId,
    manifestFingerprint: recordIdentity.manifestFingerprint,
    imageId: recordIdentity.imageId,
    category: recordIdentity.category,
    cohort: recordIdentity.cohort,
    failureTags: recordIdentity.failureTags,
    raterId: recordIdentity.raterId,
    sampleOrder: recordIdentity.sampleOrder,
    sampleOrderSeed: recordIdentity.sampleOrderSeed,
    coreCommit: recordIdentity.coreCommit,
    demoCommit: recordIdentity.demoCommit,
    gatewayCommit: recordIdentity.gatewayCommit,
    modelConfigurationId: recordIdentity.modelConfigurationId,
    beforeSnapshot: validateSnapshot(input.beforeSnapshot, 'beforeSnapshot'),
    afterSnapshot: validateSnapshot(input.afterSnapshot, 'afterSnapshot'),
    blindComparison,
    patternPreference,
    ratedAt: finite(input.ratedAt, 'ratedAt'),
  }
}

export async function createIndependentMaskGatePreferenceRecord({
  interaction,
  raterId,
  choice,
  ratedAt,
}) {
  const validated = validateMaskGateInteractionRecord(interaction)
  if (validated.outcome !== 'confirmed') {
    throw new RangeError('Independent preference requires a confirmed interaction')
  }
  const blindComparison = await createBlindComparison({
    protocolVersion: validated.protocolVersion,
    datasetId: validated.datasetId,
    imageId: validated.imageId,
    raterId,
  })
  return createMaskGatePreferenceRecord({
    ...validated,
    sample: validated,
    raterId,
    beforeSnapshot: validated.beforeSnapshot,
    afterSnapshot: validated.afterSnapshot,
    blindComparison: { ...blindComparison, choice },
    ratedAt,
  })
}

export function validateMaskGateInteractionRecord(value) {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('Mask gate interaction record must be an object')
  }
  const reconstructed = createMaskGateInteractionRecord({
    ...value,
    sample: value,
    sourceEvidence: { revision: value.sourceRevision, confidence: value.sourceConfidence },
    baseMaskValues: Float32Array.from([0]),
    correctedMaskValues: Float32Array.from([value.correctionAreaRatio > 0 ? 1 : 0]),
  })
  if (value.schemaVersion !== 2) throw new RangeError('interaction schemaVersion must equal 2')
  if (value.strokeCount !== reconstructed.strokeCount
    || value.addStrokeCount !== reconstructed.addStrokeCount
    || value.eraseStrokeCount !== reconstructed.eraseStrokeCount) {
    throw new RangeError('Stroke counts must match the active session prefix')
  }
  if (value.correctionDurationMs !== reconstructed.correctionDurationMs) {
    throw new RangeError('correctionDurationMs must match the recorded timestamps')
  }
  unit(value.correctionAreaRatio, 'correctionAreaRatio')
  return { ...value }
}

export function validateMaskGatePreferenceRecord(value) {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('Mask gate preference record must be an object')
  }
  const reconstructed = createMaskGatePreferenceRecord({ ...value, sample: value })
  if (value.schemaVersion !== 2) throw new RangeError('preference schemaVersion must equal 2')
  if (value.preferenceId !== reconstructed.preferenceId
    || value.patternPreference !== reconstructed.patternPreference) {
    throw new RangeError('Preference identity must match the blind comparison')
  }
  return { ...value }
}

export const createMaskGateRecord = createMaskGateInteractionRecord
export const validateMaskGateRecord = validateMaskGateInteractionRecord
