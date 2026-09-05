import { generateCandidateBatch } from '../src/candidate-runner.mjs'
import { candidateProviderOptions } from '../src/candidate-provider-options.mjs'
import { commandArguments, workspacePath } from '../src/paths.mjs'

const values = commandArguments(process.argv.slice(2))
const result = await generateCandidateBatch({
  manifestPath: workspacePath(values.manifest ?? 'work/full-evaluation/holdout/manifest.json'),
  sidecarDirectory: workspacePath(values.sidecars ?? 'work/full-evaluation/holdout-sidecars'),
  palettePath: workspacePath(values.palette ?? 'assets/palettes/generic-24.json'),
  outputDirectory: workspacePath(values.output ?? 'work/auto-eval/candidates'),
  ...(values.category === undefined ? {} : { category: values.category }),
  ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
  ...(values.model === undefined ? {} : { modelPath: workspacePath(values.model) }),
  ...candidateProviderOptions(values, process.env),
})
console.log(JSON.stringify({ indexPath: result.indexPath, generations: result.index.generations.length, batchSheets: result.index.batchSheets }, null, 2))
