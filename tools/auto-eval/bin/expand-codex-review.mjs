import { readFile, writeFile } from 'node:fs/promises'

import { expandCodexReview } from '../src/codex-review.mjs'
import { commandArguments, workspacePath } from '../src/paths.mjs'

const values = commandArguments(process.argv.slice(2))
if (values.reviews === undefined) throw new Error('Usage: expand-codex-review --reviews <reviews.json> [--index <candidate-index.json>] [--output <judgments.jsonl>]')
const index = JSON.parse(await readFile(workspacePath(values.index ?? 'work/auto-eval/candidates/candidate-index.json'), 'utf8'))
const reviewFile = JSON.parse(await readFile(workspacePath(values.reviews), 'utf8'))
const reviewBySource = new Map(reviewFile.reviews.map((review) => [review.sourceId, review]))
const judgments = index.generations.map((generation) => {
  const review = reviewBySource.get(generation.source.id)
  if (review === undefined) throw new RangeError(`Review file lacks source ${generation.source.id}`)
  return expandCodexReview(generation, review, {
    modelId: reviewFile.modelId,
    modelVersion: reviewFile.modelVersion,
    createdAt: reviewFile.createdAt,
  })
})
const output = workspacePath(values.output ?? 'work/auto-eval/judgments.jsonl')
await writeFile(output, `${judgments.map((judgment) => JSON.stringify(judgment)).join('\n')}\n`)
console.log(JSON.stringify({ output, judgments: judgments.length }, null, 2))
