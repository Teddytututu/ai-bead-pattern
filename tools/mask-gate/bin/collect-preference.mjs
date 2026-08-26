#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { createIndependentMaskGatePreferenceRecord } from '../src/record.mjs'
import { resolveCliPath } from '../src/cli-path.mjs'

const { values } = parseArgs({
  options: {
    interaction: { type: 'string' },
    rater: { type: 'string' },
    choice: { type: 'string' },
    output: { type: 'string' },
  },
})

if (values.interaction === undefined || values.rater === undefined
  || values.choice === undefined || values.output === undefined) {
  throw new Error(
    'Usage: collect-preference --interaction <interaction.json> --rater <id> '
      + '--choice <left|right|tie> --output <preferences.jsonl>',
  )
}

const interaction = JSON.parse(await readFile(resolveCliPath(values.interaction), 'utf8'))
const preference = await createIndependentMaskGatePreferenceRecord({
  interaction,
  raterId: values.rater,
  choice: values.choice,
  ratedAt: Date.now(),
})
let existing = ''
const outputPath = resolveCliPath(values.output)
try {
  existing = await readFile(outputPath, 'utf8')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
for (const line of existing.split(/\r?\n/)) {
  if (line.trim().length > 0 && JSON.parse(line).preferenceId === preference.preferenceId) {
    throw new RangeError(`Duplicate preferenceId in ${outputPath}: ${preference.preferenceId}`)
  }
}
await appendFile(outputPath, `${JSON.stringify(preference)}\n`)
console.log(`Recorded ${preference.preferenceId}: ${preference.patternPreference}`)
