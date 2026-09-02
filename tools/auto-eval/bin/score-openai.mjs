import { appendFile, readFile } from 'node:fs/promises'

import { OpenAIResponsesVisionJudge } from '../src/openai-vision-judge.mjs'
import { commandArguments, workspacePath } from '../src/paths.mjs'
import { validateVisionJudgment, visionJudgeSchemaVersion } from '../src/schema.mjs'

async function encoded(path) {
  const extension = path.toLowerCase().endsWith('.jpg') || path.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
  return { mimeType: extension, base64: (await readFile(path)).toString('base64') }
}

const values = commandArguments(process.argv.slice(2))
const apiKey = process.env.OPENAI_API_KEY
const model = values.model ?? process.env.OPENAI_VISION_MODEL
if (apiKey === undefined || model === undefined) throw new Error('OPENAI_API_KEY and OPENAI_VISION_MODEL are required')
const index = JSON.parse(await readFile(workspacePath(values.index ?? 'work/auto-eval/candidates/candidate-index.json'), 'utf8'))
const outputPath = workspacePath(values.output ?? 'work/auto-eval/judgments.jsonl')
const judge = new OpenAIResponsesVisionJudge({ apiKey, model })
for (const generation of index.generations) {
  const raw = await judge.score({
    generationId: generation.generationId,
    sourceId: generation.source.id,
    subjectKind: generation.source.subjectKind,
    sourceImage: await encoded(generation.source.imagePath),
    candidates: await Promise.all(generation.candidates.map(async (candidate) => ({
      id: candidate.id, grid: candidate.grid, image: await encoded(candidate.imagePath),
    }))),
  })
  const judgment = {
    schemaVersion: visionJudgeSchemaVersion,
    generationId: generation.generationId,
    source: {
      id: generation.source.id,
      groupId: generation.source.groupId,
      subjectKind: generation.source.subjectKind,
    },
    judge: {
      providerId: 'openai-responses', modelId: model, modelVersion: model,
      weightSource: 'openai-managed', license: 'OpenAI service terms',
      confidence: raw.confidence, elapsedMs: raw.elapsedMs,
    },
    candidateScores: raw.candidateScores,
    issues: raw.issues,
    ranking: raw.ranking,
    bestCandidateId: raw.bestCandidateId,
    eliminations: raw.eliminations,
    createdAt: new Date().toISOString(),
  }
  validateVisionJudgment(judgment, generation.candidates)
  await appendFile(outputPath, `${JSON.stringify(judgment)}\n`)
  console.log(`Scored ${generation.source.id}`)
}
