#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { collectMaskGateRecord } from '../src/collect.mjs'
import { resolveCliPath } from '../src/cli-path.mjs'
import { loadMaskGateManifest } from '../src/manifest.mjs'

const { values } = parseArgs({
  options: {
    manifest: { type: 'string' },
    sidecar: { type: 'string' },
    input: { type: 'string' },
    records: { type: 'string' },
    preferences: { type: 'string' },
  },
})

if (values.manifest === undefined || values.sidecar === undefined
  || values.input === undefined || values.records === undefined
  || values.preferences === undefined) {
  throw new Error(
    'Usage: collect-session --manifest <manifest.json> --sidecar <analysis.json> '
      + '--input <attempt.json> --records <records.jsonl> --preferences <preferences.jsonl>',
  )
}

async function assertUnique(path, key, value) {
  let source = ''
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  for (const line of source.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    if (JSON.parse(line)[key] === value) {
      throw new RangeError(`Duplicate ${key} in ${path}: ${value}`)
    }
  }
}

const [manifest, attemptSource] = await Promise.all([
  loadMaskGateManifest(resolveCliPath(values.manifest)),
  readFile(resolveCliPath(values.input), 'utf8'),
])
const attempt = JSON.parse(attemptSource)
const sample = manifest.samples.find((entry) => entry.imageId === attempt.imageId)
if (sample === undefined) throw new RangeError(`Manifest sample ${attempt.imageId} is missing`)
const result = await collectMaskGateRecord({
  sample,
  sidecarPath: resolveCliPath(values.sidecar),
  attempt,
})
const recordsPath = resolveCliPath(values.records)
const preferencesPath = resolveCliPath(values.preferences)
await assertUnique(recordsPath, 'imageId', result.interaction.imageId)
if (result.preference !== undefined) {
  await assertUnique(preferencesPath, 'preferenceId', result.preference.preferenceId)
}
await appendFile(recordsPath, `${JSON.stringify(result.interaction)}\n`)
if (result.preference !== undefined) {
  await appendFile(preferencesPath, `${JSON.stringify(result.preference)}\n`)
}
const duration = result.interaction.correctionDurationMs ?? 0
console.log(
  `Recorded ${result.interaction.imageId}: ${result.interaction.strokeCount} stroke(s), ${duration} ms`,
)
