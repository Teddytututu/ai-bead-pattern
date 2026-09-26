import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { workspacePath } from '../src/paths.mjs'

describe('auto-eval workspace paths', () => {
  it('resolves defaults from the repository root under pnpm package execution', () => {
    assert.equal(workspacePath('work/auto-eval/candidates'),
      fileURLToPath(new URL('../../../work/auto-eval/candidates', import.meta.url)))
  })
})
