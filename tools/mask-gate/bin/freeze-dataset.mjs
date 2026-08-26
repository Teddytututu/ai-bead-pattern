#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { freezeMaskGateDatasetFiles } from '../src/dataset.mjs'
import { resolveCliPath } from '../src/cli-path.mjs'

const { values } = parseArgs({
  options: {
    pool: { type: 'string' },
    output: { type: 'string' },
  },
})

if (values.pool === undefined || values.output === undefined) {
  throw new Error('Usage: freeze-dataset --pool <candidate-pool.json> --output <directory>')
}

const poolPath = resolveCliPath(values.pool)
const outputDirectory = resolveCliPath(values.output)
const pool = JSON.parse(await readFile(poolPath, 'utf8'))
const frozen = await freezeMaskGateDatasetFiles(pool, outputDirectory)
console.log(`Frozen ${frozen.manifest.samples.length} samples in ${outputDirectory}`)
