import { createHash } from 'node:crypto'

import { normalizePreferenceRecordV2 } from '@ai-bead-pattern/pattern-core'

import { validateVisionJudgment } from './schema.mjs'

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

export function buildVisionPreferenceRecord(judgmentValue, candidateValues) {
  const candidates = [...candidateValues].sort((first, second) => first.id.localeCompare(second.id))
  const judgment = validateVisionJudgment(judgmentValue, candidates)
  const comparisons = []
  for (let first = 0; first < judgment.ranking.length; first += 1) {
    for (let second = first + 1; second < judgment.ranking.length; second += 1) {
      comparisons.push({
        candidateAId: judgment.ranking[first],
        candidateBId: judgment.ranking[second],
        choice: 'a',
        weight: Math.max(0.05, judgment.judge.confidence),
      })
    }
  }
  const record = {
    schemaVersion: 2,
    id: `vision-${fingerprint({ judgment, candidateIds: candidates.map((candidate) => candidate.id) })}`,
    generationId: judgment.generationId,
    source: { ...judgment.source },
    candidates,
    annotator: {
      anonymousId: `vision:${judgment.judge.providerId}:${judgment.judge.modelId}`,
      cohort: 'automatic-vision-v1',
      raterType: 'vision-model',
      confidence: judgment.judge.confidence,
      elapsedMs: judgment.judge.elapsedMs,
      model: {
        name: judgment.judge.modelId,
        version: judgment.judge.modelVersion,
        weightSource: judgment.judge.weightSource,
        license: judgment.judge.license,
      },
    },
    axisScores: Object.fromEntries(Object.entries(judgment.candidateScores)
      .sort(([first], [second]) => first.localeCompare(second))),
    issueAnnotations: judgment.issues.map((issue, index) => ({
      id: `vision-issue-${fingerprint({ generationId: judgment.generationId, issue, index })}`,
      candidateId: issue.candidateId,
      issue: issue.issue,
      severity: issue.severity,
      confidence: Math.round(issue.confidence * judgment.judge.confidence * 1_000_000) / 1_000_000,
      ...(issue.region === undefined ? {} : { region: issue.region }),
      ...(issue.cells === undefined ? {} : { cells: issue.cells }),
      ...(issue.note === undefined ? {} : { note: issue.note }),
    })),
    comparisons,
    ranking: [...judgment.ranking],
    bestCandidateId: judgment.bestCandidateId,
    eliminations: judgment.eliminations.map((entry) => ({ ...entry })),
    createdAt: judgment.createdAt,
    updatedAt: judgment.createdAt,
  }
  return normalizePreferenceRecordV2(record)
}
