export const preferenceStorageKey = 'ai-bead-pattern.preferences.v1'

function text(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)]
    .map((entry) => entry.toString(16).padStart(2, '0'))
    .join('')
}

function validateRecord(record) {
  if (record === null || typeof record !== 'object') {
    throw new TypeError('Preference record must be an object')
  }
  const choice = text(record.choice, 'choice')
  if (['a', 'b', 'tie'].includes(choice) === false) {
    throw new RangeError('choice has an unsupported value')
  }
  const candidateAId = text(record.candidateAId, 'candidateAId')
  const candidateBId = text(record.candidateBId, 'candidateBId')
  if (candidateAId === candidateBId) {
    throw new RangeError('Preference record requires distinct candidates')
  }
  return {
    id: text(record.id, 'id'),
    sourceId: text(record.sourceId, 'sourceId'),
    raterId: text(record.raterId, 'raterId'),
    candidateAId,
    candidateBId,
    choice,
  }
}

export async function createBlindCandidatePair(input) {
  const generationId = text(input.generationId, 'generationId')
  const candidateAId = text(input.candidateAId, 'candidateAId')
  const candidateBId = text(input.candidateBId, 'candidateBId')
  const raterId = text(input.raterId, 'raterId')
  if (candidateAId === candidateBId) {
    throw new RangeError('Blind comparison requires distinct candidates')
  }
  const seed = await sha256([generationId, candidateAId, candidateBId, raterId].join('\0'))
  const candidateAFirst = Number.parseInt(seed.slice(0, 8), 16) % 2 === 0
  return {
    generationId,
    candidateAId,
    candidateBId,
    raterId,
    leftCandidateId: candidateAFirst ? candidateAId : candidateBId,
    rightCandidateId: candidateAFirst ? candidateBId : candidateAId,
    seed,
  }
}

export function resolveCandidatePreference(pair, blindChoice) {
  const choice = text(blindChoice, 'blindChoice')
  if (['left', 'right', 'tie'].includes(choice) === false) {
    throw new RangeError('blindChoice has an unsupported value')
  }
  const selectedCandidateId = choice === 'left'
    ? pair.leftCandidateId
    : choice === 'right'
      ? pair.rightCandidateId
      : undefined
  return validateRecord({
    id: pair.seed,
    sourceId: pair.generationId,
    raterId: pair.raterId,
    candidateAId: pair.candidateAId,
    candidateBId: pair.candidateBId,
    choice: selectedCandidateId === undefined
      ? 'tie'
      : selectedCandidateId === pair.candidateAId ? 'a' : 'b',
  })
}

export function loadPreferenceRecords(storage = globalThis.localStorage) {
  try {
    const encoded = storage?.getItem(preferenceStorageKey)
    if (encoded === null || encoded === undefined) return []
    const parsed = JSON.parse(encoded)
    if (Array.isArray(parsed) === false) return []
    return parsed.map(validateRecord)
  } catch {
    return []
  }
}

export function savePreferenceRecords(storage = globalThis.localStorage, records) {
  const validated = records.map(validateRecord)
  storage?.setItem(preferenceStorageKey, JSON.stringify(validated))
  return validated
}
