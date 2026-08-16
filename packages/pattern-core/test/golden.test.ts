import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createPatternAlgorithm } from '../src/index.js'
import {
  baselineGoldenPalette,
  featureGoldenAnalysis,
  featureGoldenImage,
  featureGoldenOptimization,
  protectedFeatureGoldenCells,
  samplingGoldenCells,
  samplingGoldenImage,
  structureGoldenCells,
  structureGoldenImage,
} from './fixtures/baseline-golden.js'

const algorithm = createPatternAlgorithm({ clock: () => 123 })

describe('baseline-specific golden fixtures', () => {
  it('keeps nearest-neighbor and area sampling behavior distinct', async () => {
    for (const baseline of ['a0', 'a1'] as const) {
      const result = await algorithm.generate({
        image: samplingGoldenImage,
        palette: baselineGoldenPalette,
        options: {
          canvas: { mode: 'fixed', size: { width: 2, height: 1 } },
          maxColors: 2,
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

      assert.deepEqual(result.pattern.cells, samplingGoldenCells[baseline])
      assert.equal(result.recommended.edits.length, 0)
      assert.equal(result.pattern.width, 2)
      assert.equal(result.pattern.height, 1)
    }
  })

  it('keeps the MVP stripe edit distinct from the area baseline', async () => {
    for (const baseline of ['a1', 'mvp'] as const) {
      const result = await algorithm.generate({
        image: structureGoldenImage,
        palette: baselineGoldenPalette,
        options: {
          canvas: { mode: 'fixed', size: { width: 3, height: 3 } },
          maxColors: 2,
          styles: ['faithful'],
          baseline,
          optimization: {
            minRegionSize: 1,
            isolatedPixelPenalty: 0,
            stripePenalty: baseline === 'mvp' ? 1 : 0,
            aliasPenalty: 0,
            paletteCoherence: 0,
            localSearchIterations: 0,
          },
        },
      })

      assert.deepEqual(result.pattern.cells, structureGoldenCells[baseline])
      assert.equal(result.recommended.edits.length, baseline === 'mvp' ? 1 : 0)
      assert.equal(result.metrics.isolatedCells, baseline === 'mvp' ? 0 : 2)
    }
  })

  it('keeps a hard feature visible through grid cleanup', async () => {
    const result = await algorithm.generate({
      image: featureGoldenImage,
      palette: baselineGoldenPalette,
      analysis: featureGoldenAnalysis,
      options: {
        canvas: { mode: 'fixed', size: { width: 3, height: 3 } },
        maxColors: 2,
        styles: ['faithful'],
        baseline: 'mvp',
        optimization: featureGoldenOptimization,
      },
    })

    assert.deepEqual(result.pattern.cells, protectedFeatureGoldenCells)
    assert.equal(result.recommended.edits.length, 0)
    assert.equal(result.metrics.featureExpressibility, 1)
    assert.equal(result.metrics.featureConnectivity, 1)
    assert.equal(result.recommended.valid, true)
  })
})
