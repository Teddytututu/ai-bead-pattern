#!/usr/bin/env node

import { parseArgs } from 'node:util'

import { resolveCliPath } from '../src/cli-path.mjs'
import { runMaskGatePilot } from '../src/pilot.mjs'

const { values } = parseArgs({
  options: {
    manifest: { type: 'string' },
    sidecars: { type: 'string' },
    output: { type: 'string' },
    'fixture-epoch': { type: 'string' },
  },
})

if (values.manifest === undefined || values.sidecars === undefined || values.output === undefined) {
  throw new Error(
    'Usage: run-pilot --manifest <manifest.json> --sidecars <directory> --output <directory> '
      + '[--fixture-epoch <milliseconds>]',
  )
}

const fixtureEpochMs = values['fixture-epoch'] === undefined
  ? undefined
  : Number(values['fixture-epoch'])
const result = await runMaskGatePilot({
  manifestPath: resolveCliPath(values.manifest),
  sidecarDirectory: resolveCliPath(values.sidecars),
  outputDirectory: resolveCliPath(values.output),
  ...(fixtureEpochMs === undefined ? {} : { fixtureEpochMs }),
})
console.log(
  `Generated ${result.interactionCount} Pilot interactions, ${result.preferenceCount} preferences, and ${result.replayedConfirmedCount} confirmed replays.`,
)
