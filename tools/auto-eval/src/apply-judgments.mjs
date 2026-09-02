import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import {
  comparePreferenceModels,
  createFrozenPreferenceSplit,
  deduplicatePreferenceRecords,
  fitPreferenceModelV2,
} from '@ai-bead-pattern/pattern-core'

import { selectIteration, toGenerationOptions } from './iteration.mjs'
import { buildVisionPreferenceRecord } from './preference-record.mjs'

async function readJsonLines(path) {
  const content = await readFile(path, 'utf8')
  return content.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))
}

async function readOptionalJsonLines(path) {
  try { return await readJsonLines(path) } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function readOptionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

export async function applyVisionJudgments(options) {
  const candidateIndex = JSON.parse(await readFile(resolve(options.candidateIndexPath), 'utf8'))
  const judgments = await readJsonLines(resolve(options.judgmentsPath))
  const generationById = new Map(candidateIndex.generations.map((entry) => [entry.generationId, entry]))
  const freshRecords = judgments.map((judgment) => {
    const generation = generationById.get(judgment.generationId)
    if (generation === undefined) throw new RangeError(`Judgment references unknown generation ${judgment.generationId}`)
    return buildVisionPreferenceRecord(judgment, generation.candidates.map((candidate) => ({
      id: candidate.id,
      route: candidate.route,
      style: candidate.style,
      paletteId: candidate.paletteId,
      grid: candidate.grid,
      model: candidate.model,
      features: candidate.features,
    })))
  })
  const outputDirectory = resolve(options.outputDirectory)
  await mkdir(outputDirectory, { recursive: true })
  const recordsPath = joinPath(outputDirectory, 'records.jsonl')
  const existing = await readOptionalJsonLines(recordsPath)
  const records = deduplicatePreferenceRecords([...existing, ...freshRecords])
  const split = createFrozenPreferenceSplit(records, { seed: options.splitSeed ?? 'auto-eval-frozen-v1' })
  const train = records.filter((record) => split.recordIds.train.includes(record.id))
  const holdout = records.filter((record) => split.recordIds.holdout.includes(record.id))
  const storedBaseline = await readOptionalJson(joinPath(outputDirectory, 'model.json'))
  const baseline = storedBaseline ?? fitPreferenceModelV2([])
  const challenger = fitPreferenceModelV2(train)
  const comparison = comparePreferenceModels(baseline, challenger, holdout)
  const iteration = selectIteration({
    baseline,
    challenger,
    comparison,
    selectionOptions: {
      minimumTrainingSamples: options.minimumTrainingSamples ?? 12,
      minimumAccuracyGain: options.minimumAccuracyGain ?? 0,
      maximumLogLossRegression: options.maximumLogLossRegression ?? 0.01,
    },
  })
  const generationOptions = toGenerationOptions(iteration.selectedModel, {
    maxColors: 12,
    structure: { importanceStrength: 1, edgeStrength: 1, valueOrderStrength: 1 },
    optimization: { edgeProtection: 0.72, isolatedPixelPenalty: 1, stripePenalty: 1, localSearchIterations: 3 },
  })
  await Promise.all([
    writeFile(recordsPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`),
    writeFile(joinPath(outputDirectory, 'model.json'), `${JSON.stringify(iteration.selectedModel, null, 2)}\n`),
    writeFile(joinPath(outputDirectory, 'generation-options.json'), `${JSON.stringify(generationOptions, null, 2)}\n`),
    writeFile(joinPath(outputDirectory, 'iteration-report.json'), `${JSON.stringify({
      createdAt: new Date().toISOString(),
      recordCount: records.length,
      trainCount: train.length,
      holdoutCount: holdout.length,
      split,
      comparison,
      selection: iteration.selection,
      baselineVersion: baseline.version,
      challengerVersion: challenger.version,
      selectedVersion: iteration.selectedModel.version,
      generationOptions,
    }, null, 2)}\n`),
  ])
  return { records, split, comparison, iteration, generationOptions }
}

function joinPath(directory, name) {
  return resolve(directory, name)
}
