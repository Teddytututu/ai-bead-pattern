#!/usr/bin/env node

import { parseArgs } from 'node:util'

import { resolveCliPath } from '../src/cli-path.mjs'
import { writeFeatureGateProtocolFixtures } from '../src/protocol-fixtures.mjs'

const { values } = parseArgs({ options: { output: { type: 'string' } } })
if (values.output === undefined) throw new Error('Usage: create-protocol-fixtures --output <directory>')
const result = await writeFeatureGateProtocolFixtures(resolveCliPath(values.output))
process.stdout.write(`Wrote Feature Gate protocol fixtures to ${result.directory}\n`)
