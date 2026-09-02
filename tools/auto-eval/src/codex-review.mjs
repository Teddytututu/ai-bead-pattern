import { validateVisionJudgment, visionJudgeAxes, visionJudgeSchemaVersion } from './schema.mjs'

export function expandCodexReview(generation, review, metadata) {
  const candidateScores = Object.fromEntries(generation.candidates.map((candidate) => {
    const concise = review.scores[candidate.id]
    if (concise === undefined) throw new RangeError(`Review lacks candidate ${candidate.id}`)
    return [candidate.id, Object.fromEntries(visionJudgeAxes.map((axis) => [
      axis,
      concise[axis] ?? concise.base,
    ]))]
  }))
  const judgment = {
    schemaVersion: visionJudgeSchemaVersion,
    generationId: generation.generationId,
    source: {
      id: generation.source.id,
      groupId: generation.source.groupId,
      subjectKind: generation.source.subjectKind,
    },
    judge: {
      providerId: 'codex-built-in-vision',
      modelId: metadata.modelId,
      modelVersion: metadata.modelVersion,
      weightSource: 'openai-managed',
      license: 'OpenAI service terms',
      confidence: review.confidence,
      elapsedMs: review.elapsedMs ?? 0,
    },
    candidateScores,
    issues: review.issues,
    ranking: review.ranking,
    bestCandidateId: review.ranking[0],
    eliminations: review.eliminations,
    createdAt: metadata.createdAt,
  }
  validateVisionJudgment(judgment, generation.candidates)
  return judgment
}
