import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildSourceShapeModel,
} from '../src/experimental.js'
import { ShapeVariantCache } from '../src/planning/shape-variant-cache.js'

describe('shape variant cache', () => {
  it('reuses one rasterization for repeated size and refinement requests', () => {
    const values = Float32Array.from({ length: 16 * 16 }, (_, index) => {
      const x = index % 16
      const y = Math.floor(index / 16)
      return x >= 3 && x < 13 && y >= 2 && y < 14 ? 1 : 0
    })
    const cache = new ShapeVariantCache(
      buildSourceShapeModel({ width: 16, height: 16, values }, 1),
      [],
    )
    const request = {
      crop: { x: 0, y: 0, width: 16, height: 16 },
      size: { width: 8, height: 8 },
      refinementIterations: 2,
    }

    const first = cache.get(request)
    const repeated = cache.get(request)
    const changedRefinement = cache.get({ ...request, refinementIterations: 1 })
    const changedCrop = cache.get({
      ...request,
      crop: { x: 1, y: 0, width: 15, height: 16 },
    })
    const changedSize = cache.get({ ...request, size: { width: 9, height: 8 } })
    const thinStructures = cache.get({ ...request, preserveThinStructures: true })

    assert.equal(first, repeated)
    assert.notEqual(first, changedRefinement)
    assert.notEqual(first, changedCrop)
    assert.notEqual(first, changedSize)
    assert.notEqual(first, thinStructures)
    assert.equal(cache.size, 5)
  })

  it('validates variant keys before reading the cache', () => {
    const cache = new ShapeVariantCache(buildSourceShapeModel({
      width: 1,
      height: 1,
      values: new Float32Array([0]),
    }, 1), [])

    assert.throws(() => cache.get({
      crop: { x: 0, y: 0, width: 0, height: 1 },
      size: { width: 1, height: 1 },
      refinementIterations: 2,
    }), /crop/i)
    assert.throws(() => cache.get({
      crop: { x: 0, y: 0, width: 1, height: 1 },
      size: { width: 1, height: 1 },
      refinementIterations: 33,
    }), /refinement/i)
    assert.throws(() => cache.get({
      crop: { x: 0, y: 0, width: 1, height: 1 },
      size: { width: 1, height: 1 },
      refinementIterations: 2,
      preserveThinStructures: 'yes' as never,
    }), /thin-structure/i)
  })
})
