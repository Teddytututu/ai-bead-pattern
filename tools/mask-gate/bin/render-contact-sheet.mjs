#!/usr/bin/env node

import { parseArgs } from 'node:util'

import { resolveCliPath } from '../src/cli-path.mjs'
import { renderMaskGateContactSheetFromPool } from '../src/contact-sheet.mjs'

const { values } = parseArgs({
  options: {
    pool: { type: 'string' },
    images: { type: 'string' },
    output: { type: 'string' },
    columns: { type: 'string' },
    thumbnail: { type: 'string' },
  },
})

if (values.pool === undefined || values.output === undefined) {
  throw new Error(
    'Usage: render-contact-sheet --pool <candidate-pool.json> '
      + '[--images <directory>] --output <contact-sheet.png>',
  )
}

const result = await renderMaskGateContactSheetFromPool({
  poolPath: resolveCliPath(values.pool),
  imageDirectory: resolveCliPath(values.images),
  outputPath: resolveCliPath(values.output),
  columns: values.columns === undefined ? undefined : Number(values.columns),
  thumbnailSize: values.thumbnail === undefined ? undefined : Number(values.thumbnail),
})
console.log(`Rendered ${result.columns} columns x ${result.rows} rows`)
