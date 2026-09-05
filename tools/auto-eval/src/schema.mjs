export const visionJudgeSchemaVersion = 'vision-judge-v1'

export const visionJudgeAxes = Object.freeze([
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
])

export const visionJudgeIssues = Object.freeze([
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
])

const subjectKinds = new Set(['person', 'pet', 'object', 'scene'])
const issues = new Set(visionJudgeIssues)

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value
}

function text(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RangeError(`${label} must be a non-empty string`)
  }
  return value
}

function finite(value, label) {
  if (typeof value !== 'number' || Number.isFinite(value) === false) {
    throw new RangeError(`${label} must be finite`)
  }
  return value
}

function unit(value, label) {
  const result = finite(value, label)
  if (result < 0 || result > 1) throw new RangeError(`${label} must stay within 0..1`)
  return result
}

function integer(value, label, minimum, maximum) {
  if (Number.isInteger(value) === false || value < minimum || value > maximum) {
    throw new RangeError(`${label} must stay within ${minimum}..${maximum}`)
  }
  return value
}

function validateScores(value, candidateIds) {
  const scores = object(value, 'candidateScores')
  if (Object.keys(scores).length !== candidateIds.size) {
    throw new RangeError('candidateScores must cover every candidate')
  }
  for (const candidateId of candidateIds) {
    const axes = object(scores[candidateId], `candidateScores.${candidateId}`)
    if (Object.keys(axes).length !== visionJudgeAxes.length
      || visionJudgeAxes.some((axis) => Object.hasOwn(axes, axis) === false)) {
      throw new RangeError(`candidateScores.${candidateId} must cover every axis`)
    }
    for (const axis of visionJudgeAxes) {
      const score = finite(axes[axis], `candidateScores.${candidateId}.${axis}`)
      if (score < 1 || score > 5) {
        throw new RangeError(`candidateScores.${candidateId}.${axis} must stay within 1..5`)
      }
    }
  }
}

function validateSelection(value, grid, label) {
  if (value.region !== undefined) {
    const region = object(value.region, `${label}.region`)
    for (const key of ['x', 'y', 'width', 'height']) integer(region[key], `${label}.region.${key}`, 0, 4096)
    if (region.width < 1 || region.height < 1
      || region.x + region.width > grid.width || region.y + region.height > grid.height) {
      throw new RangeError(`${label}.region must stay inside the candidate grid`)
    }
  }
  if (value.cells !== undefined) {
    if (Array.isArray(value.cells) === false || value.cells.length === 0) {
      throw new RangeError(`${label}.cells must contain grid cells`)
    }
    for (const [index, cellValue] of value.cells.entries()) {
      const cell = object(cellValue, `${label}.cells[${index}]`)
      integer(cell.x, `${label}.cells[${index}].x`, 0, grid.width - 1)
      integer(cell.y, `${label}.cells[${index}].y`, 0, grid.height - 1)
    }
  }
}

export function validateVisionJudgment(value, candidates) {
  const input = object(value, 'vision judgment')
  if (input.schemaVersion !== visionJudgeSchemaVersion) {
    throw new RangeError(`schemaVersion must equal ${visionJudgeSchemaVersion}`)
  }
  text(input.generationId, 'generationId')
  const source = object(input.source, 'source')
  text(source.id, 'source.id')
  if (source.groupId !== undefined) text(source.groupId, 'source.groupId')
  if (source.digest !== undefined) text(source.digest, 'source.digest')
  if (subjectKinds.has(source.subjectKind) === false) throw new RangeError('source.subjectKind is invalid')
  const judge = object(input.judge, 'judge')
  for (const key of ['providerId', 'modelId', 'modelVersion', 'weightSource', 'license']) {
    text(judge[key], `judge.${key}`)
  }
  unit(judge.confidence, 'judge.confidence')
  if (finite(judge.elapsedMs, 'judge.elapsedMs') < 0) throw new RangeError('judge.elapsedMs must be zero or positive')
  if (Array.isArray(candidates) === false || candidates.length < 2 || candidates.length > 12) {
    throw new RangeError('vision judgment requires 2..12 candidates')
  }
  const candidateById = new Map(candidates.map((candidate) => [text(candidate.id, 'candidate.id'), candidate]))
  if (candidateById.size !== candidates.length) throw new RangeError('candidate ids must be unique')
  validateScores(input.candidateScores, new Set(candidateById.keys()))
  if (Array.isArray(input.issues) === false) throw new TypeError('issues must be an array')
  for (const [index, issueValue] of input.issues.entries()) {
    const issue = object(issueValue, `issues[${index}]`)
    const candidate = candidateById.get(text(issue.candidateId, `issues[${index}].candidateId`))
    if (candidate === undefined) throw new RangeError(`issues[${index}] references an unknown candidate`)
    if (issues.has(issue.issue) === false) throw new RangeError(`issues[${index}].issue is invalid`)
    integer(issue.severity, `issues[${index}].severity`, 1, 5)
    unit(issue.confidence, `issues[${index}].confidence`)
    if (issue.note !== undefined) text(issue.note, `issues[${index}].note`)
    validateSelection(issue, candidate.grid, `issues[${index}]`)
  }
  if (Array.isArray(input.ranking) === false || input.ranking.length !== candidates.length
    || new Set(input.ranking).size !== candidates.length
    || input.ranking.some((candidateId) => candidateById.has(candidateId) === false)) {
    throw new RangeError('ranking must cover every candidate')
  }
  text(input.bestCandidateId, 'bestCandidateId')
  if (input.bestCandidateId !== input.ranking[0]) throw new RangeError('bestCandidateId must lead the ranking')
  if (Array.isArray(input.eliminations) === false) throw new TypeError('eliminations must be an array')
  for (const [index, eliminationValue] of input.eliminations.entries()) {
    const elimination = object(eliminationValue, `eliminations[${index}]`)
    if (candidateById.has(text(elimination.candidateId, `eliminations[${index}].candidateId`)) === false) {
      throw new RangeError(`eliminations[${index}] references an unknown candidate`)
    }
    text(elimination.reason, `eliminations[${index}].reason`)
  }
  const timestamp = text(input.createdAt, 'createdAt')
  if (new Date(timestamp).toISOString() !== timestamp) throw new RangeError('createdAt must be an ISO timestamp')
  return input
}

export function visionJudgmentJsonSchema(candidateIds) {
  const axisSchema = {
    type: 'object',
    properties: Object.fromEntries(visionJudgeAxes.map((axis) => [axis, { type: 'number', minimum: 1, maximum: 5 }])),
    required: [...visionJudgeAxes],
    additionalProperties: false,
  }
  const scoreProperties = Object.fromEntries(candidateIds.map((candidateId) => [candidateId, axisSchema]))
  return {
    type: 'object',
    properties: {
      candidateScores: { type: 'object', properties: scoreProperties, required: [...candidateIds], additionalProperties: false },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            candidateId: { type: 'string', enum: [...candidateIds] },
            issue: { type: 'string', enum: [...visionJudgeIssues] },
            severity: { type: 'integer', minimum: 1, maximum: 5 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            note: { type: 'string' },
          },
          required: ['candidateId', 'issue', 'severity', 'confidence', 'note'],
          additionalProperties: false,
        },
      },
      ranking: { type: 'array', items: { type: 'string', enum: [...candidateIds] }, minItems: candidateIds.length, maxItems: candidateIds.length },
      bestCandidateId: { type: 'string', enum: [...candidateIds] },
      eliminations: {
        type: 'array',
        items: {
          type: 'object',
          properties: { candidateId: { type: 'string', enum: [...candidateIds] }, reason: { type: 'string' } },
          required: ['candidateId', 'reason'],
          additionalProperties: false,
        },
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['candidateScores', 'issues', 'ranking', 'bestCandidateId', 'eliminations', 'confidence'],
    additionalProperties: false,
  }
}
