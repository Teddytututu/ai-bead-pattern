import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { workspacePath } from '../src/paths.mjs'

describe('auto-eval workspace paths', () => {
  it('resolves defaults from the repository root under pnpm package execution', () => {
    assert.match(workspacePath('work/auto-eval/candidates').replaceAll('\\', '/'), /ai-bead-pattern\/work\/auto-eval\/candidates$/)
  })
})
