export const preferenceSessionStorageKey = 'ai-bead-pattern.preference-session.v2'

export const preferenceAxes = Object.freeze([
  { id: 'recognition', label: '主体辨识' },
  { id: 'silhouette', label: '剪影' },
  { id: 'identity', label: '身份特征' },
  { id: 'composition', label: '构图比例' },
  { id: 'value', label: '明度层次' },
  { id: 'palette', label: '配色' },
  { id: 'contour', label: '轮廓节奏' },
  { id: 'cluster', label: '像素簇' },
  { id: 'material', label: '材质' },
  { id: 'style', label: '风格符合度' },
  { id: 'craft', label: '制作难度' },
])

export const preferenceIssueTags = Object.freeze([
  { id: 'facial-feature-loss', label: '五官丢失' },
  { id: 'marking-loss', label: '花纹丢失' },
  { id: 'thin-structure-collapse', label: '细线坍缩' },
  { id: 'jagged-contour', label: '轮廓锯齿' },
  { id: 'isolated-cell', label: '孤立格' },
  { id: 'color-banding', label: '色带' },
  { id: 'texture-noise', label: '纹理噪声' },
  { id: 'value-confusion', label: '明度混乱' },
  { id: 'palette-deviation', label: '色板偏差' },
  { id: 'proportion-distortion', label: '比例变形' },
  { id: 'background-dominance', label: '背景抢主体' },
  { id: 'too-many-colors', label: '颜色过多' },
  { id: 'fragile-thin-structure', label: '细长结构脆弱' },
  { id: 'craft-complexity', label: '制作复杂' },
])

export function candidateIdentity(candidate) {
  const paletteId = candidate.pattern.metadata.paletteId
  const paletteVersion = candidate.pattern.metadata.paletteVersion
  return {
    id: candidate.id,
    generationId: candidate.generationId,
    variantId: candidate.variantId,
    style: candidate.style,
    pattern: { width: candidate.pattern.width, height: candidate.pattern.height },
    source: {
      route: candidate.proposalSource?.route ?? 'deterministic',
      model: candidate.proposalSource?.model ?? 'pattern-core',
      version: candidate.pattern.metadata.algorithmVersion,
    },
    palette: {
      id: typeof paletteId === 'string' && paletteId.length > 0 ? paletteId : 'unknown-palette',
      version: typeof paletteVersion === 'string' && paletteVersion.length > 0
        ? paletteVersion
        : 'unknown',
    },
    metrics: candidate.metrics,
  }
}

const axisIds = new Set(preferenceAxes.map((axis) => axis.id))
const issueIds = new Set(preferenceIssueTags.map((tag) => tag.id))
const comparisonChoices = new Set(['first', 'second', 'tie', 'composite'])

function requiredText(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function finiteRange(value, minimum, maximum, label) {
  if (Number.isFinite(value) === false || value < minimum || value > maximum) {
    throw new RangeError(`${label} must stay within ${minimum}..${maximum}`)
  }
  return value
}

function integerRange(value, minimum, maximum, label) {
  if (Number.isInteger(value) === false || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer within ${minimum}..${maximum}`)
  }
  return value
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

function stableStringify(value, indentation = 0) {
  return JSON.stringify(stableValue(value), null, indentation)
}

function editableSnapshot(session) {
  const { history: _history, future: _future, ...content } = session
  return structuredClone(content)
}

function applyEdit(session, change) {
  const current = editableSnapshot(session)
  const next = change(structuredClone(current))
  return {
    ...next,
    updatedAt: Math.max(Date.now(), Number(next.updatedAt ?? 0)),
    history: [...session.history, current].slice(-100),
    future: [],
  }
}

function validateCandidate(candidate, generationId) {
  const id = requiredText(candidate?.id, 'candidate.id')
  if (candidate.generationId !== undefined && candidate.generationId !== generationId) {
    throw new RangeError('Candidate generation identity must match the session')
  }
  const width = integerRange(candidate?.pattern?.width, 1, 512, 'candidate.pattern.width')
  const height = integerRange(candidate?.pattern?.height, 1, 512, 'candidate.pattern.height')
  return {
    id,
    generationId,
    variantId: requiredText(candidate.variantId ?? id, 'candidate.variantId'),
    style: requiredText(candidate.style ?? 'faithful', 'candidate.style'),
    pattern: { width, height },
    source: stableValue(candidate.source ?? { route: 'deterministic' }),
    palette: stableValue(candidate.palette ?? {}),
    metrics: stableValue(candidate.metrics ?? {}),
  }
}

function emptyAxisScores() {
  return Object.fromEntries(preferenceAxes.map((axis) => [axis.id, null]))
}

export function createPreferenceSession(input) {
  const generationId = requiredText(input?.generationId, 'generationId')
  const candidates = (input?.candidates ?? []).map((candidate) => validateCandidate(candidate, generationId))
  if (candidates.length < 2 || candidates.length > 4) {
    throw new RangeError('Preference session requires two to four candidates')
  }
  const candidateOrder = candidates.map((candidate) => candidate.id)
  if (new Set(candidateOrder).size !== candidateOrder.length) {
    throw new RangeError('Preference session candidate ids must be unique')
  }
  const createdAt = finiteRange(input.createdAt ?? Date.now(), 0, Number.MAX_SAFE_INTEGER, 'createdAt')
  return {
    schemaVersion: 'preference-session-v2',
    generationId,
    source: stableValue({ ...input.source, id: requiredText(input?.source?.id, 'source.id') }),
    annotatorId: requiredText(input?.annotatorId, 'annotatorId'),
    candidates: Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate])),
    candidateOrder,
    axisScores: Object.fromEntries(candidateOrder.map((candidateId) => [candidateId, emptyAxisScores()])),
    annotations: [],
    comparisons: [],
    ranking: {
      order: [...candidateOrder],
      bestCandidateId: undefined,
      eliminated: [],
      compositeCandidateIds: [],
      updatedAt: createdAt,
    },
    createdAt,
    updatedAt: createdAt,
    history: [],
    future: [],
  }
}

function candidateFor(session, candidateId) {
  const candidate = session.candidates[candidateId]
  if (candidate === undefined) throw new RangeError('Annotation references an unknown candidate')
  return candidate
}

export function setCandidateAxisScore(session, candidateId, axisId, score) {
  candidateFor(session, candidateId)
  if (axisIds.has(axisId) === false) throw new RangeError('Axis score uses an unsupported axis')
  integerRange(score, 1, 5, 'axis score')
  return applyEdit(session, (next) => {
    next.axisScores[candidateId][axisId] = score
    return next
  })
}

function normalizedCells(candidate, cells = []) {
  const seen = new Set()
  return cells.map((cell) => {
    const x = integerRange(cell.x, 0, candidate.pattern.width - 1, 'Annotation cell x on board')
    const y = integerRange(cell.y, 0, candidate.pattern.height - 1, 'Annotation cell y on board')
    const key = `${x},${y}`
    if (seen.has(key)) throw new RangeError('Annotation cells must be unique')
    seen.add(key)
    return { x, y }
  }).sort((first, second) => first.y - second.y || first.x - second.x)
}

function normalizedRegion(region) {
  if (region === undefined) return undefined
  return {
    x: finiteRange(region.x, 0, 1, 'region.x'),
    y: finiteRange(region.y, 0, 1, 'region.y'),
    width: finiteRange(region.width, 0, 1, 'region.width'),
    height: finiteRange(region.height, 0, 1, 'region.height'),
  }
}

function normalizedIssue(session, issue, fallbackId) {
  const candidate = candidateFor(session, issue.candidateId)
  if (issueIds.has(issue.tag) === false) throw new RangeError('Issue annotation uses an unsupported tag')
  const createdAt = finiteRange(issue.createdAt ?? Date.now(), 0, Number.MAX_SAFE_INTEGER, 'issue.createdAt')
  return {
    id: requiredText(issue.id ?? fallbackId, 'issue.id'),
    candidateId: candidate.id,
    tag: issue.tag,
    severity: integerRange(issue.severity, 1, 3, 'issue.severity'),
    confidence: finiteRange(issue.confidence, 0, 1, 'issue.confidence'),
    note: typeof issue.note === 'string' ? issue.note.trim().slice(0, 500) : '',
    region: normalizedRegion(issue.region),
    cells: normalizedCells(candidate, issue.cells),
    createdAt,
    updatedAt: createdAt,
  }
}

export function addLocalizedIssue(session, issue) {
  const id = issue.id ?? `${issue.candidateId}:${issue.tag}:${issue.createdAt ?? Date.now()}:${session.annotations.length}`
  const normalized = normalizedIssue(session, issue, id)
  if (session.annotations.some((entry) => entry.id === normalized.id)) {
    throw new RangeError('Issue annotation id must be unique')
  }
  return applyEdit(session, (next) => {
    next.annotations.push(normalized)
    return next
  })
}

export function updateLocalizedIssue(session, issueId, patch) {
  const current = session.annotations.find((entry) => entry.id === issueId)
  if (current === undefined) throw new RangeError('Issue annotation id is unknown')
  const normalized = normalizedIssue(session, {
    ...current,
    ...patch,
    id: current.id,
    candidateId: current.candidateId,
    createdAt: current.createdAt,
  }, current.id)
  normalized.updatedAt = Number(patch.updatedAt ?? Date.now())
  return applyEdit(session, (next) => {
    next.annotations = next.annotations.map((entry) => entry.id === issueId ? normalized : entry)
    return next
  })
}

export function removeLocalizedIssue(session, issueId) {
  if (session.annotations.some((entry) => entry.id === issueId) === false) {
    throw new RangeError('Issue annotation id is unknown')
  }
  return applyEdit(session, (next) => {
    next.annotations = next.annotations.filter((entry) => entry.id !== issueId)
    return next
  })
}

export function recordCandidateComparison(session, comparison) {
  const candidateIds = [...new Set(comparison.candidateIds ?? [])]
  if (candidateIds.length < 2 || candidateIds.length > 4) {
    throw new RangeError('Comparison requires two to four candidates')
  }
  candidateIds.forEach((candidateId) => candidateFor(session, candidateId))
  if (comparisonChoices.has(comparison.choice) === false) {
    throw new RangeError('Comparison choice has an unsupported value')
  }
  const strengths = [...new Set(comparison.strengths ?? [])]
  strengths.forEach((candidateId) => candidateFor(session, candidateId))
  const createdAt = finiteRange(comparison.createdAt ?? Date.now(), 0, Number.MAX_SAFE_INTEGER, 'comparison.createdAt')
  const record = {
    id: requiredText(comparison.id ?? `${candidateIds.join(':')}:${createdAt}`, 'comparison.id'),
    candidateIds,
    choice: comparison.choice,
    strengths,
    eliminatedReasons: stableValue(comparison.eliminatedReasons ?? {}),
    createdAt,
  }
  return applyEdit(session, (next) => {
    next.comparisons = [...next.comparisons.filter((entry) => entry.id !== record.id), record]
    return next
  })
}

export function setCandidateRanking(session, ranking) {
  const order = [...ranking.order]
  if (order.length !== session.candidateOrder.length
    || new Set(order).size !== order.length
    || order.some((candidateId) => session.candidates[candidateId] === undefined)) {
    throw new RangeError('Ranking order must contain every candidate exactly once')
  }
  if (ranking.bestCandidateId !== undefined) candidateFor(session, ranking.bestCandidateId)
  const eliminated = (ranking.eliminated ?? []).map((entry) => ({
    candidateId: candidateFor(session, entry.candidateId).id,
    reasons: [...new Set(entry.reasons ?? [])].map((reason) => requiredText(reason, 'elimination reason')).sort(),
  }))
  const compositeCandidateIds = [...new Set(ranking.compositeCandidateIds ?? [])]
  compositeCandidateIds.forEach((candidateId) => candidateFor(session, candidateId))
  return applyEdit(session, (next) => {
    next.ranking = {
      order,
      bestCandidateId: ranking.bestCandidateId,
      eliminated,
      compositeCandidateIds,
      updatedAt: finiteRange(ranking.updatedAt ?? Date.now(), 0, Number.MAX_SAFE_INTEGER, 'ranking.updatedAt'),
    }
    return next
  })
}

export function undoPreferenceEdit(session) {
  if (session.history.length === 0) return session
  const previous = structuredClone(session.history.at(-1))
  return {
    ...previous,
    history: session.history.slice(0, -1),
    future: [editableSnapshot(session), ...session.future].slice(0, 100),
  }
}

export function redoPreferenceEdit(session) {
  if (session.future.length === 0) return session
  const [next, ...remaining] = session.future
  return {
    ...structuredClone(next),
    history: [...session.history, editableSnapshot(session)].slice(-100),
    future: remaining,
  }
}

function storageKey(generationId) {
  return `${preferenceSessionStorageKey}:${generationId}`
}

export function savePreferenceSession(storage = globalThis.localStorage, session) {
  const encoded = exportPreferenceSession(session, 'json')
  storage?.setItem(storageKey(session.generationId), encoded)
  return session
}

export function loadPreferenceSession(storage = globalThis.localStorage, generationId) {
  const encoded = storage?.getItem(storageKey(requiredText(generationId, 'generationId')))
  if (encoded === null || encoded === undefined) return undefined
  const parsed = JSON.parse(encoded)
  if (parsed.schemaVersion !== 'preference-session-v2' || parsed.generationId !== generationId) {
    throw new RangeError('Stored preference session schema or generation identity is incompatible')
  }
  return { ...parsed, history: [], future: [] }
}

export function preferenceCompletion(session) {
  const totalScores = session.candidateOrder.length * preferenceAxes.length
  const scored = session.candidateOrder.reduce((sum, candidateId) => sum
    + Object.values(session.axisScores[candidateId]).filter((value) => value !== null).length, 0)
  const ranking = session.ranking.bestCandidateId === undefined ? 0 : 1
  return {
    scored,
    totalScores,
    annotations: session.annotations.length,
    comparisons: session.comparisons.length,
    percent: Math.round((scored + ranking) / Math.max(1, totalScores + 1) * 100),
  }
}

export function exportPreferenceSession(session, format = 'json') {
  const record = editableSnapshot(session)
  if (format === 'json') return `${stableStringify(record, 2)}\n`
  if (format === 'jsonl') return `${stableStringify(record)}\n`
  throw new RangeError('Preference export format has an unsupported value')
}

export function exportPreferenceRecord(session, converter, format = 'json') {
  if (typeof converter !== 'function') throw new TypeError('Preference V2 export requires a converter')
  const record = converter(editableSnapshot(session), {
    recordId: `workbench-${session.generationId}-${session.annotatorId}`,
  })
  if (format === 'json') return `${stableStringify(record, 2)}\n`
  if (format === 'jsonl') return `${stableStringify(record)}\n`
  throw new RangeError('Preference V2 export format has an unsupported value')
}
