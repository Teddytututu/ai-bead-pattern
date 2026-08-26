#!/usr/bin/env node

import { parseArgs } from 'node:util'

import { resolveCliPath } from '../src/cli-path.mjs'
import { writeVisionGateProtocolFixtures } from '../src/protocol-fixtures.mjs'

const { values } = parseArgs({ options: { output: { type: 'string' } } })
if (values.output === undefined) {
  throw new Error('Usage: create-protocol-fixtures --output <directory>')
}
const result = await writeVisionGateProtocolFixtures(resolveCliPath(values.output))
process.stdout.write(`Wrote Vision Gate protocol fixtures to ${result.directory}\n`)
