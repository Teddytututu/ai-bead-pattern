#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs, promisify } from 'node:util'

import { buildWikimediaCandidatePool } from '../src/wikimedia-pool.mjs'
import { resolveCliPath } from '../src/cli-path.mjs'

const execFileAsync = promisify(execFile)
const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    pool: { type: 'string' },
  },
})

if (values.output === undefined || values.pool === undefined) {
  throw new Error('Usage: build-wikimedia-pool --output <image-directory> --pool <candidate-pool.json>')
}

let commit = 'unknown'
try {
  commit = (await execFileAsync('git', ['rev-parse', 'HEAD'])).stdout.trim()
} catch {
  // The pool remains explicit about unavailable source identity.
}
const outputDirectory = resolveCliPath(values.output)
const poolPath = resolveCliPath(values.pool)
await mkdir(dirname(poolPath), { recursive: true })
const pool = await buildWikimediaCandidatePool({
  outputDirectory,
  poolPath,
  commits: { core: commit, demo: commit, gateway: commit },
  onProgress: (message) => console.log(message),
})
console.log(`Downloaded ${pool.candidates.length} licensed Wikimedia candidates`)
