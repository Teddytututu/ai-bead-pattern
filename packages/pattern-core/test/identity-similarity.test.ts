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

  it('gives identity-critical cells more influence than broad body tone', () => {
    const source: RGB[] = [
      [20, 20, 20], [230, 230, 230],
      [80, 80, 80], [160, 160, 160],
    ]
    const facePreserved: RGB[] = [
      [20, 20, 20], [230, 230, 230],
      [160, 160, 160], [80, 80, 80],
    ]
    const bodyPreserved: RGB[] = [
      [230, 230, 230], [20, 20, 20],
      [80, 80, 80], [160, 160, 160],
    ]
    const activeMask = new Uint8Array(4).fill(1)
    const importance = new Float32Array([4, 4, 1, 1])

    assert.ok(
      identityAppearanceSimilarity(source, facePreserved, activeMask, 2, 2, importance)
      > identityAppearanceSimilarity(source, bodyPreserved, activeMask, 2, 2, importance) + 0.25,
    )
  })

  it('penalizes chromatic identity swaps with the same luminance layout', () => {
    const source: RGB[] = [
      [210, 45, 45], [45, 210, 80],
      [210, 45, 45], [45, 210, 80],
    ]
    const hueSwapped: RGB[] = source.map(([red, green, blue]) => [green, red, blue] as RGB)
    const activeMask = new Uint8Array(4).fill(1)

    assert.ok(
      identityAppearanceSimilarity(source, source, activeMask, 2, 2)
        > identityAppearanceSimilarity(source, hueSwapped, activeMask, 2, 2) + 0.12,
    )
  })
})
