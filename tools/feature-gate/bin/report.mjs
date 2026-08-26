#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { resolveCliPath } from '../src/cli-path.mjs'
import {
  renderCollisionBreakdownCsv,
  renderFeatureBreakdownCsv,
  renderSampleBreakdownCsv,
  renderSizeBreakdownCsv,
} from '../src/report-exports.mjs'
import { renderFeatureGateReport, summarizeFeatureGate } from '../src/report.mjs'
import { loadFeatureGateManifest, loadFeatureGateRecords } from '../src/schema.mjs'

const { values } = parseArgs({ options: {
  manifest: { type: 'string' },
  records: { type: 'string' },
  output: { type: 'string' },
  json: { type: 'string' },
  diagnostics: { type: 'string' },
} })
if (values.manifest === undefined || values.records === undefined) {
  throw new Error('Usage: report --manifest <manifest.json> --records <records.jsonl> [--output report.md] [--json summary.json] [--diagnostics directory]')
}
const [manifest, records] = await Promise.all([
  loadFeatureGateManifest(resolveCliPath(values.manifest)),
  loadFeatureGateRecords(resolveCliPath(values.records)),
])
const summary = summarizeFeatureGate(manifest, records)
const markdown = renderFeatureGateReport(summary)
if (values.output === undefined) process.stdout.write(markdown)
else await writeFile(resolveCliPath(values.output), markdown)
if (values.json !== undefined) await writeFile(resolveCliPath(values.json), `${JSON.stringify(summary, null, 2)}\n`)
if (values.diagnostics !== undefined) {
  const directory = resolveCliPath(values.diagnostics)
  await mkdir(directory, { recursive: true })
  await Promise.all([
    writeFile(join(directory, 'sample-breakdown.csv'), renderSampleBreakdownCsv(summary)),
    writeFile(join(directory, 'feature-breakdown.csv'), renderFeatureBreakdownCsv(summary)),
    writeFile(join(directory, 'collision-breakdown.csv'), renderCollisionBreakdownCsv(summary)),
    writeFile(join(directory, 'size-breakdown.csv'), renderSizeBreakdownCsv(summary)),
  ])
}
