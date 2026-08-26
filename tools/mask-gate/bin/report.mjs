#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import {
  loadMaskGateRecords,
  loadMaskGatePreferences,
  renderMaskGateReport,
  summarizeMaskGate,
} from '../src/report.mjs'
import { loadMaskGateManifest } from '../src/manifest.mjs'
import { resolveCliPath } from '../src/cli-path.mjs'
import {
  renderCategoryBreakdownCsv,
  renderControlPreservationCsv,
  renderDeviceBreakdownCsv,
  renderFailureTagBreakdownCsv,
} from '../src/report-exports.mjs'

const { values } = parseArgs({
  options: {
    records: { type: 'string' },
    manifest: { type: 'string' },
    preferences: { type: 'string' },
    output: { type: 'string' },
    json: { type: 'string' },
    diagnostics: { type: 'string' },
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
  loadMaskGateManifest(resolveCliPath(values.manifest)),
  loadMaskGateRecords(resolveCliPath(values.records)),
  loadMaskGatePreferences(resolveCliPath(values.preferences)),
])
const summary = summarizeMaskGate(records, preferences, undefined, manifest)
const markdown = renderMaskGateReport(summary)
if (values.output === undefined) process.stdout.write(markdown)
else await writeFile(resolveCliPath(values.output), markdown)
if (values.json !== undefined) {
  await writeFile(resolveCliPath(values.json), `${JSON.stringify(summary, null, 2)}\n`)
}
if (values.diagnostics !== undefined) {
  const diagnosticsDirectory = resolveCliPath(values.diagnostics)
  await mkdir(diagnosticsDirectory, { recursive: true })
  await Promise.all([
    writeFile(join(diagnosticsDirectory, 'category-breakdown.csv'), renderCategoryBreakdownCsv(records)),
    writeFile(join(diagnosticsDirectory, 'failure-tag-breakdown.csv'), renderFailureTagBreakdownCsv(records)),
    writeFile(join(diagnosticsDirectory, 'device-breakdown.csv'), renderDeviceBreakdownCsv(records)),
    writeFile(join(diagnosticsDirectory, 'control-preservation.csv'), renderControlPreservationCsv(records)),
  ])
}
