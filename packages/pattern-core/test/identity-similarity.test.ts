import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { identityAppearanceSimilarity, type RGB } from '../src/index.js'

describe('identity appearance similarity', () => {
  it('rewards the same coarse facial value layout over a flattened candidate', () => {
    const source: RGB[] = [
      [180, 180, 180], [25, 25, 25], [180, 180, 180], [25, 25, 25],
      [180, 180, 180], [180, 180, 180], [80, 80, 80], [180, 180, 180],
      [120, 120, 120], [120, 120, 120], [120, 120, 120], [120, 120, 120],
      [90, 90, 90], [90, 90, 90], [90, 90, 90], [90, 90, 90],
    ]
    const matching = source.map((rgb) => [...rgb] as RGB)
    const flattened = source.map(() => [130, 130, 130] as RGB)
    const activeMask = new Uint8Array(16).fill(1)

    assert.ok(
      identityAppearanceSimilarity(source, matching, activeMask, 4, 4)
      > identityAppearanceSimilarity(source, flattened, activeMask, 4, 4) + 0.35,
    )
  })
})
