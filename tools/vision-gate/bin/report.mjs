#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import {
  loadVisionGateManifest,
  loadVisionGatePredictions,
} from '../src/schema.mjs'
import {
  renderVisionGateReport,
  summarizeVisionGate,
} from '../src/report.mjs'
import {
  renderCalibrationBinsCsv,
  renderLandmarkErrorsCsv,
  renderRegionOverlapCsv,
  renderSampleBreakdownCsv,
} from '../src/report-exports.mjs'
import { resolveCliPath } from '../src/cli-path.mjs'

const { values } = parseArgs({
  options: {
    manifest: { type: 'string' },
    predictions: { type: 'string' },
    output: { type: 'string' },
    json: { type: 'string' },
    diagnostics: { type: 'string' },
  },
})

if (values.manifest === undefined || values.predictions === undefined) {
  throw new Error('Usage: report --manifest <manifest.json> --predictions <predictions.jsonl> [--output report.md] [--json summary.json] [--diagnostics directory]')
}

const [manifest, predictions] = await Promise.all([
  loadVisionGateManifest(resolveCliPath(values.manifest)),
  loadVisionGatePredictions(resolveCliPath(values.predictions)),
])
const summary = summarizeVisionGate(manifest, predictions)
const markdown = renderVisionGateReport(summary)
if (values.output === undefined) process.stdout.write(markdown)
else await writeFile(resolveCliPath(values.output), markdown)
if (values.json !== undefined) await writeFile(resolveCliPath(values.json), `${JSON.stringify(summary, null, 2)}\n`)
if (values.diagnostics !== undefined) {
  const directory = resolveCliPath(values.diagnostics)
  await mkdir(directory, { recursive: true })
  await Promise.all([
    writeFile(join(directory, 'sample-breakdown.csv'), renderSampleBreakdownCsv(summary)),
    writeFile(join(directory, 'landmark-errors.csv'), renderLandmarkErrorsCsv(summary)),
    writeFile(join(directory, 'region-overlap.csv'), renderRegionOverlapCsv(summary)),
    writeFile(join(directory, 'calibration-bins.csv'), renderCalibrationBinsCsv(summary)),
  ])
}
