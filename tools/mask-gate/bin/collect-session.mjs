#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { collectMaskGateRecord } from '../src/collect.mjs'
import { loadMaskGateManifest } from '../src/manifest.mjs'

const { values } = parseArgs({
  options: {
    manifest: { type: 'string' },
    sidecar: { type: 'string' },
    input: { type: 'string' },
    records: { type: 'string' },
  },
})

if (values.manifest === undefined || values.sidecar === undefined
  || values.input === undefined || values.records === undefined) {
  throw new Error(
    'Usage: collect-session --manifest <manifest.json> --sidecar <analysis.json> '
      + '--input <attempt.json> --records <records.jsonl>',
  )
}

const [manifest, attemptSource] = await Promise.all([
  loadMaskGateManifest(values.manifest),
  readFile(values.input, 'utf8'),
])
const attempt = JSON.parse(attemptSource)
const sample = manifest.samples.find((entry) => entry.imageId === attempt.imageId)
if (sample === undefined) throw new RangeError(`Manifest sample ${attempt.imageId} is missing`)
const record = await collectMaskGateRecord({
  sample,
  datasetId: manifest.datasetId,
  sidecarPath: values.sidecar,
  attempt,
})
await appendFile(values.records, `${JSON.stringify(record)}\n`)
console.log(`Recorded ${record.imageId}: ${record.strokeCount} stroke(s), ${record.correctionDurationMs} ms`)
