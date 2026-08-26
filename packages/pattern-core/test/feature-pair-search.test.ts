import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  searchFeaturePairs,
  type ResolvedFeaturePlacement,
} from '../src/experimental.js'

function placement(
  featureId: string,
  templateId: string,
  center: readonly [number, number],
  occupiedCells: readonly number[],
  score = 1,
): ResolvedFeaturePlacement {
  return {
    featureId,
    kind: 'eye',
    templateId,
    center,
    occupiedCells,
    roles: occupiedCells.map((cell) => ({ cell, role: 'eye-dark' })),
    shift: [0, 0],
    score,
  }
}

describe('paired eye search', () => {
  it('prefers aligned, non-overlapping, template-consistent eyes', () => {
    const result = searchFeaturePairs({
      leftCandidates: [
        placement('left-eye', 'eye-e1', [16, 18], [18 * 48 + 16], 0.95),
        placement('left-eye', 'eye-e2-h', [16.5, 20], [20 * 48 + 16, 20 * 48 + 17], 1),
      ],
      rightCandidates: [
        placement('right-eye', 'eye-e1', [30, 18], [18 * 48 + 30], 0.95),
        placement('right-eye', 'eye-e2-h', [29.5, 17], [17 * 48 + 29, 17 * 48 + 30], 1),
      ],
      expectedLeftCenter: [16, 18],
      expectedRightCenter: [30, 18],
    })

    assert.equal(result[0]?.left.templateId, 'eye-e1')
    assert.equal(result[0]?.right.templateId, 'eye-e1')
    assert.equal(result[0]?.heightError, 0)
    assert.equal(result[0]?.overlap, false)
  })

  it('removes pairs whose occupied cells collide', () => {
    const result = searchFeaturePairs({
      leftCandidates: [placement('left-eye', 'eye-e1', [20, 20], [980])],
      rightCandidates: [placement('right-eye', 'eye-e1', [20, 20], [980])],
      expectedLeftCenter: [20, 20],
      expectedRightCenter: [28, 20],
    })

    assert.deepEqual(result, [])
  })

  it('removes crossed eye assignments even when spacing matches', () => {
    const result = searchFeaturePairs({
      leftCandidates: [placement('left-eye', 'eye-e1', [30, 18], [894])],
      rightCandidates: [placement('right-eye', 'eye-e1', [16, 18], [880])],
      expectedLeftCenter: [16, 18],
      expectedRightCenter: [30, 18],
    })

    assert.deepEqual(result, [])
  })
})
