export const maskGateProtocolVersion = 'mask-gate-v2'

const terminalOutcomes = new Set(['accepted', 'confirmed', 'cancelled', 'error'])
const blindChoices = new Set(['left', 'right', 'tie'])

function text(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function finite(value, name) {
  if (Number.isFinite(value) === false) throw new TypeError(`${name} must be finite`)
  return value
}

function integer(value, name, minimum = 0) {
  if (Number.isInteger(value) === false || value < minimum) {
    throw new RangeError(`${name} must be an integer greater than or equal to ${minimum}`)
  }
  return value
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

async function sha256Text(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function createBlindComparison(input) {
  const datasetId = text(input.datasetId, 'datasetId')
  const imageId = text(input.imageId, 'imageId')
  const raterId = text(input.raterId, 'raterId')
  const protocolVersion = text(
    input.protocolVersion ?? maskGateProtocolVersion,
    'protocolVersion',
  )
  const seed = await sha256Text(`${datasetId}\0${imageId}\0${raterId}\0${protocolVersion}`)
  return {
    leftVariant: Number.parseInt(seed.slice(0, 2), 16) % 2 === 0 ? 'before' : 'after',
    choice: undefined,
    seed,
  }
}

export function resolveBlindPreference(comparison) {
  if (comparison?.leftVariant !== 'before' && comparison?.leftVariant !== 'after') {
    throw new RangeError('leftVariant has an unsupported value')
  }
  if (blindChoices.has(comparison.choice) === false) {
    throw new RangeError('choice has an unsupported value')
  }
  if (comparison.choice === 'tie') return 'tie'
  if (comparison.choice === 'left') return comparison.leftVariant
  return comparison.leftVariant === 'before' ? 'after' : 'before'
}

export function createGateProtocolState(input) {
  const blindComparison = input.blindComparison
  if (blindComparison?.leftVariant !== 'before' && blindComparison?.leftVariant !== 'after') {
    throw new RangeError('blindComparison.leftVariant has an unsupported value')
  }
  return {
    protocolVersion: text(input.protocolVersion ?? maskGateProtocolVersion, 'protocolVersion'),
    attemptId: text(input.attemptId ?? crypto.randomUUID(), 'attemptId'),
    datasetId: text(input.datasetId, 'datasetId'),
    manifestFingerprint: text(input.manifestFingerprint, 'manifestFingerprint'),
    imageId: text(input.imageId, 'imageId'),
    raterId: text(input.raterId, 'raterId'),
    sampleOrder: integer(input.sampleOrder, 'sampleOrder'),
    sampleOrderSeed: text(input.sampleOrderSeed, 'sampleOrderSeed'),
    coreCommit: text(input.coreCommit, 'coreCommit'),
    demoCommit: text(input.demoCommit, 'demoCommit'),
    gatewayCommit: text(input.gatewayCommit, 'gatewayCommit'),
    modelConfigurationId: text(input.modelConfigurationId, 'modelConfigurationId'),
    beforeSnapshot: validateSnapshot(input.beforeSnapshot, 'beforeSnapshot'),
    blindComparison: { ...blindComparison },
    stage: 'sample-loaded',
  }
}

function requireStage(state, expected, event) {
  const allowed = Array.isArray(expected) ? expected : [expected]
  if (allowed.includes(state.stage) === false) {
    throw new RangeError(`${event} cannot run from stage ${state.stage}`)
  }
}

export function transitionGateProtocol(state, event) {
  if (state === null || typeof state !== 'object') throw new TypeError('state must be an object')
  const at = finite(event.at, `${event.type}.at`)
  switch (event.type) {
    case 'rate-initial': {
      requireStage(state, 'sample-loaded', event.type)
      if (typeof event.acceptable !== 'boolean') {
        throw new TypeError('rate-initial.acceptable must be boolean')
      }
      return {
        ...state,
        stage: 'initial-rated',
        initialRatingAt: at,
        initialSubjectAcceptable: event.acceptable,
      }
    }
    case 'accept-original': {
      requireStage(state, 'initial-rated', event.type)
      if (state.initialSubjectAcceptable !== true) {
        throw new RangeError('accept-original requires an acceptable initial subject')
      }
      return { ...state, stage: 'accepted', outcome: 'accepted', outcomeAt: at }
    }
    case 'start-editing': {
      requireStage(state, 'initial-rated', event.type)
      if (state.initialSubjectAcceptable !== false) {
        throw new RangeError('start-editing requires an initial failure rating')
      }
      return { ...state, stage: 'editing', correctionStartedAt: at }
    }
    case 'confirm-editing': {
      requireStage(state, 'editing', event.type)
      return {
        ...state,
        stage: 'confirmed',
        outcome: 'confirmed',
        outcomeAt: at,
        correctionEndedAt: at,
        session: event.session,
        afterSnapshot: validateSnapshot(event.afterSnapshot, 'afterSnapshot'),
      }
    }
    case 'cancel-editing': {
      requireStage(state, 'editing', event.type)
      return {
        ...state,
        stage: 'cancelled',
        outcome: 'cancelled',
        outcomeAt: at,
        correctionEndedAt: at,
        session: event.session,
      }
    }
    case 'record-error': {
      requireStage(state, ['initial-rated', 'editing', 'confirmed'], event.type)
      return {
        ...state,
        stage: 'error',
        outcome: 'error',
        outcomeAt: at,
        ...(state.stage === 'editing' ? { correctionEndedAt: at } : {}),
        ...(event.session === undefined ? {} : { session: event.session }),
        error: {
          code: text(event.code, 'record-error.code'),
          message: text(event.message, 'record-error.message'),
        },
      }
    }
    case 'rate-corrected-mask': {
      requireStage(state, 'confirmed', event.type)
      if (typeof event.acceptable !== 'boolean') {
        throw new TypeError('rate-corrected-mask.acceptable must be boolean')
      }
      return {
        ...state,
        stage: 'corrected-mask-rated',
        correctedMaskRatingAt: at,
        subjectAcceptable: event.acceptable,
      }
    }
    case 'rate-blind-pattern': {
      requireStage(state, 'corrected-mask-rated', event.type)
      if (blindChoices.has(event.choice) === false) {
        throw new RangeError('rate-blind-pattern.choice has an unsupported value')
      }
      return {
        ...state,
        stage: 'blind-pattern-rated',
        blindPatternRatingAt: at,
        blindComparison: { ...state.blindComparison, choice: event.choice },
      }
    }
    case 'export': {
      requireStage(state, ['accepted', 'cancelled', 'error', 'blind-pattern-rated'], event.type)
      if (terminalOutcomes.has(state.outcome) === false) {
        throw new RangeError('export requires a terminal outcome')
      }
      return { ...state, stage: 'exported', exportedAt: at }
    }
    default:
      throw new RangeError(`Unsupported gate protocol event: ${event.type}`)
  }
}

