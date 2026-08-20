#!/usr/bin/env node

import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import {
  loadMaskGateRecords,
  loadMaskGatePreferences,
  renderMaskGateReport,
  summarizeMaskGate,
} from '../src/report.mjs'
import { loadMaskGateManifest } from '../src/manifest.mjs'

const { values } = parseArgs({
  options: {
    records: { type: 'string' },
    manifest: { type: 'string' },
    preferences: { type: 'string' },
    output: { type: 'string' },
    json: { type: 'string' },
  },
})

if (values.records === undefined || values.preferences === undefined
  || values.manifest === undefined) {
  throw new Error(
    'Usage: report --manifest <manifest.json> --records <records.jsonl> '
      + '--preferences <preferences.jsonl> '
      + '[--output report.md] [--json summary.json]',
  )
}

const [manifest, records, preferences] = await Promise.all([
  loadMaskGateManifest(values.manifest),
  loadMaskGateRecords(values.records),
  loadMaskGatePreferences(values.preferences),
])
const summary = summarizeMaskGate(records, preferences, undefined, manifest)
const markdown = renderMaskGateReport(summary)
if (values.output === undefined) process.stdout.write(markdown)
else await writeFile(values.output, markdown)
if (values.json !== undefined) {
  await writeFile(values.json, `${JSON.stringify(summary, null, 2)}\n`)
}
