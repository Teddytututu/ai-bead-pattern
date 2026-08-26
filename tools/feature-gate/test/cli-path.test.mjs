import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { describe, it } from 'node:test'

import { resolveCliPath } from '../src/cli-path.mjs'

describe('Feature Gate CLI paths', () => {
  it('resolves paths relative to the pnpm caller directory', () => {
    const previous = process.env.INIT_CWD
    process.env.INIT_CWD = 'C:\\workspace\\ai-bead-pattern'
    try {
      const resolved = resolveCliPath('work/feature-gate/manifest.json')
      assert.equal(isAbsolute(resolved), true)
      assert.match(resolved.replaceAll('\\', '/'), /ai-bead-pattern\/work\/feature-gate\/manifest\.json$/)
    } finally {
      if (previous === undefined) delete process.env.INIT_CWD
      else process.env.INIT_CWD = previous
    }
  })
})
