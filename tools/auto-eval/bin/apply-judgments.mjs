import { applyVisionJudgments } from '../src/apply-judgments.mjs'
import { commandArguments, workspacePath } from '../src/paths.mjs'

const values = commandArguments(process.argv.slice(2))
if (values.judgments === undefined) throw new Error('Usage: apply-judgments --judgments <judgments.jsonl> [--index <candidate-index.json>] [--output <directory>]')
const result = await applyVisionJudgments({
  candidateIndexPath: workspacePath(values.index ?? 'work/auto-eval/candidates/candidate-index.json'),
  judgmentsPath: workspacePath(values.judgments),
  outputDirectory: workspacePath(values.output ?? 'work/auto-eval/learning'),
  ...(values.minimumSamples === undefined ? {} : { minimumTrainingSamples: Number(values.minimumSamples) }),
})
console.log(JSON.stringify({
  records: result.records.length,
  train: result.split.recordIds.train.length,
  holdout: result.split.recordIds.holdout.length,
  comparison: result.comparison,
  selection: result.iteration.selection,
  selectedVersion: result.iteration.selectedModel.version,
  generationOptions: result.generationOptions,
}, null, 2))
