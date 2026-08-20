#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { parseArgs } from 'node:util'
import { promisify } from 'node:util'

import { RembgHttpSegmentationProvider } from '@ai-bead-pattern/ai-gateway'

import { generateMaskGateSidecars } from '../src/sidecar.mjs'

const execFileAsync = promisify(execFile)
const { values } = parseArgs({
  options: {
    manifest: { type: 'string' },
    output: { type: 'string' },
    endpoint: { type: 'string' },
    model: { type: 'string', default: 'birefnet-general-lite' },
    'raw-mask': { type: 'boolean', default: false },
  },
})

if (values.manifest === undefined || values.output === undefined) {
  throw new Error('Usage: generate-sidecars --manifest <manifest.json> --output <directory>')
}

let gatewayCommit = 'unknown'
try {
  const [head, status] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD']),
    execFileAsync('git', ['status', '--porcelain']),
  ])
  gatewayCommit = `${head.stdout.trim()}${status.stdout.trim().length > 0 ? '-dirty' : ''}`
} catch {
  // Source identity remains explicit when git metadata is unavailable.
}

const provider = new RembgHttpSegmentationProvider({
  endpoint: values.endpoint ?? process.env.REMBG_ENDPOINT ?? 'http://127.0.0.1:7000',
  defaultModel: values.model,
})
const index = await generateMaskGateSidecars({
  manifestPath: values.manifest,
  outputDirectory: values.output,
  provider,
  model: values.model,
  postProcessMask: values['raw-mask'] === false,
  gatewayCommit,
})

console.log(`Generated ${index.samples.length} BiRefNet sidecar set(s) in ${values.output}`)
