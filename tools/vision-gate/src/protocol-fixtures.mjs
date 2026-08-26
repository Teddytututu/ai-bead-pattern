import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  createVisionGateProtocolFixtures,
  createVisionGateProtocolPredictions,
} from './schema.mjs'

function serializablePrediction(prediction) {
  return {
    ...prediction,
    regions: Object.fromEntries(Object.entries(prediction.regions).map(([id, mask]) => [
      id,
      { ...mask, values: [...mask.values] },
    ])),
  }
}

export async function writeVisionGateProtocolFixtures(outputDirectory) {
  const directory = resolve(outputDirectory)
  const manifestPath = join(directory, 'manifest.json')
  const predictionsPath = join(directory, 'predictions.jsonl')
  const manifest = createVisionGateProtocolFixtures()
  const predictions = createVisionGateProtocolPredictions(manifest)
  await mkdir(directory, { recursive: true })
  await Promise.all([
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(predictionsPath, `${predictions.map((entry) =>
      JSON.stringify(serializablePrediction(entry))).join('\n')}\n`),
  ])
  return { directory, manifestPath, predictionsPath }
}
