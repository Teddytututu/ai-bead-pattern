import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createPatternAlgorithm, type BaselineMode } from '../src/index.js'
import {
  baselineGoldenCells,
  baselineGoldenImage,
  baselineGoldenPalette,
} from './fixtures/baseline-golden.js'

describe('baseline golden fixture', () => {
  for (const baseline of ['a0', 'a1', 'mvp'] as const satisfies readonly BaselineMode[]) {
    it(`keeps the ${baseline} output stable`, async () => {
      const result = await createPatternAlgorithm({ clock: () => 123 }).generate({
        image: baselineGoldenImage,
        palette: baselineGoldenPalette,
        options: {
          canvas: { mode: 'fixed', size: { width: 3, height: 3 } },
          maxColors: 4,
          maxCandidates: 1,
          styles: ['faithful'],
          baseline,
          optimization: {
            minRegionSize: 1,
            isolatedPixelPenalty: 0,
            stripePenalty: 0,
            aliasPenalty: 0,
            paletteCoherence: 0,
            localSearchIterations: 0,
          },
        },
      })

      assert.deepEqual(result.pattern.cells, baselineGoldenCells)
    })
  }
})
