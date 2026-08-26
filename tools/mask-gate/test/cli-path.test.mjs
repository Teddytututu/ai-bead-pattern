import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { describe, it } from 'node:test'

import { resolveCliPath } from '../src/cli-path.mjs'

describe('Mask Gate CLI paths', () => {
  it('resolves caller-relative paths into absolute paths', () => {
    const resolved = resolveCliPath('work/mask-gate/manifest.json')
    assert.equal(isAbsolute(resolved), true)
    assert.match(resolved.replaceAll('\\', '/'), /work\/mask-gate\/manifest\.json$/)
  })
})
