import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  createFeatureGateProtocolFixtures,
  createFeatureGateProtocolRecords,
} from './schema.mjs'

export async function writeFeatureGateProtocolFixtures(outputDirectory) {
  const directory = resolve(outputDirectory)
  const manifestPath = join(directory, 'manifest.json')
  const recordsPath = join(directory, 'records.jsonl')
  const manifest = createFeatureGateProtocolFixtures()
  const records = createFeatureGateProtocolRecords(manifest)
  await mkdir(directory, { recursive: true })
  await Promise.all([
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(recordsPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`),
  ])
  return { directory, manifestPath, recordsPath }
}
