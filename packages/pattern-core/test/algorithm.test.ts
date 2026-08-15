import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createPatternAlgorithm,
  type MaterialPalette,
  type PatternGenerationRequest,
  type PixelImage,
} from '../src/index.js'

const palette: MaterialPalette = {
  id: 'test',
  name: 'Test palette',
  colors: [
    { id: 'black', name: 'Black', hex: '#000000', rgb: [0, 0, 0] },
    { id: 'white', name: 'White', hex: '#ffffff', rgb: [255, 255, 255] },
    { id: 'red', name: 'Red', hex: '#ff0000', rgb: [255, 0, 0] },
    { id: 'green', name: 'Green', hex: '#00ff00', rgb: [0, 255, 0] },
    { id: 'blue', name: 'Blue', hex: '#0000ff', rgb: [0, 0, 255] },
  ],
}

function image(width: number, height: number, pixels: readonly (readonly [number, number, number])[]): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4)
  pixels.forEach((pixel, index) => {
    data[index * 4] = pixel[0]
    data[index * 4 + 1] = pixel[1]
    data[index * 4 + 2] = pixel[2]
    data[index * 4 + 3] = 255
  })
  return { width, height, data }
}

function fixedRequest(source: PixelImage, overrides: Partial<PatternGenerationRequest['options']> = {}): PatternGenerationRequest {
  return {
    image: source,
    palette,
    options: {
      canvas: { mode: 'fixed', size: { width: source.width, height: source.height } },
      maxColors: 5,
      styles: ['faithful'],
      ...overrides,
    },
  }
}

describe('deterministic pattern algorithm', () => {
  it('rejects malformed RGBA input', async () => {
    const algorithm = createPatternAlgorithm()
    const request = fixedRequest({ width: 2, height: 2, data: new Uint8ClampedArray(3) })

    await assert.rejects(() => algorithm.generate(request), /RGBA/)
  })

  it('generates the requested grid with legal colors and accurate material counts', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(2, 2, [
      [255, 0, 0], [255, 0, 0],
      [0, 0, 255], [255, 255, 255],
    ])

    const result = await algorithm.generate(fixedRequest(source, { maxColors: 2 }))

    assert.equal(result.pattern.width, 2)
    assert.equal(result.pattern.height, 2)
    assert.equal(result.pattern.cells.length, 4)
    assert.ok(result.pattern.palette.length <= 2)
    assert.deepEqual(
      result.materialCounts.map((entry) => entry.count).reduce((sum, count) => sum + count, 0),
      4,
    )
    assert.deepEqual(result.pattern, result.recommended.pattern)
    assert.deepEqual(result.materialCounts, result.recommended.materialCounts)
  })

  it('produces stable cells for repeated input', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(2, 2, [
      [255, 0, 0], [0, 255, 0],
      [0, 0, 255], [255, 255, 255],
    ])
    const request = fixedRequest(source, { maxColors: 3 })

    const first = await algorithm.generate(request)
    const second = await algorithm.generate(request)

    assert.deepEqual(first.pattern.cells, second.pattern.cells)
    assert.deepEqual(first.materialCounts, second.materialCounts)
  })

  it('removes an isolated cell in an ordinary region', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const red = [255, 0, 0] as const
    const blue = [0, 0, 255] as const
    const source = image(3, 3, [red, red, red, red, blue, red, red, red, red])

    const result = await algorithm.generate(fixedRequest(source, {
      optimization: { minRegionSize: 2, isolatedPixelPenalty: 1 },
    }))

    assert.equal(result.pattern.cells[4]?.colorId, 'red')
    assert.ok(result.metrics.removedSmallRegions >= 1)
    assert.ok(result.metrics.meanColorDistance > 0)
  })

  it('keeps a hard landmark cell during local cleanup', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const red = [255, 0, 0] as const
    const blue = [0, 0, 255] as const
    const source = image(3, 3, [red, red, red, red, blue, red, red, red, red])
    const request = fixedRequest(source, {
      optimization: { minRegionSize: 2, isolatedPixelPenalty: 1 },
    })
    request.analysis = {
      landmarks: [
        { id: 'left-eye', kind: 'eye', x: 1, y: 1, confidence: 1, priority: 'hard' },
      ],
    }

    const result = await algorithm.generate(request)

    assert.equal(result.pattern.cells[4]?.colorId, 'blue')
  })

  it('returns ranked candidates for automatic canvas and style options', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(4, 4, Array.from({ length: 16 }, (_, index) =>
      index % 2 === 0 ? [255, 0, 0] as const : [0, 0, 255] as const,
    ))
    const request: PatternGenerationRequest = {
      image: source,
      palette,
      options: {
        canvas: {
          mode: 'auto',
          candidates: [
            { width: 2, height: 2 },
            { width: 4, height: 4 },
          ],
        },
        maxColors: 4,
        maxCandidates: 4,
        styles: ['faithful', 'simple', 'high-contrast'],
      },
    }

    const result = await algorithm.generate(request)

    assert.ok(result.alternatives.length >= 1)
    assert.ok(result.alternatives.length <= 3)
    assert.equal(result.evaluation.rankedCandidateIds[0], result.recommended.id)
    assert.ok([2, 4].includes(result.pattern.width))
  })

  it('composites transparent pixels onto the configured background', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source: PixelImage = {
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([0, 0, 0, 0]),
    }

    const result = await algorithm.generate(fixedRequest(source, {
      backgroundRgb: [255, 255, 255],
      maxColors: 2,
    }))

    assert.equal(result.pattern.cells[0]?.colorId, 'white')
  })

  it('supports the legacy width and height contract', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(1, 1, [[255, 0, 0]])
    const result = await algorithm.generate({
      image: source,
      palette,
      options: { width: 2, height: 3, maxColors: 2, styles: ['faithful'] },
    })

    assert.equal(result.pattern.width, 2)
    assert.equal(result.pattern.height, 3)
    assert.equal(result.pattern.cells.length, 6)
  })

  it('keeps the raw isolated cell in the A0 comparison route', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const red = [255, 0, 0] as const
    const blue = [0, 0, 255] as const
    const source = image(3, 3, [red, red, red, red, blue, red, red, red, red])

    const result = await algorithm.generate(fixedRequest(source, { baseline: 'a0' }))

    assert.equal(result.pattern.cells[4]?.colorId, 'blue')
    assert.equal(result.metrics.removedSmallRegions, 0)
  })

  it('applies the analysis crop before grid generation', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(2, 1, [[255, 0, 0], [0, 0, 255]])
    const request = fixedRequest(source, {
      canvas: { mode: 'fixed', size: { width: 1, height: 1 } },
    })
    request.analysis = { suggestedCrop: { x: 1, y: 0, width: 1, height: 1 } }

    const result = await algorithm.generate(request)

    assert.equal(result.pattern.cells[0]?.colorId, 'blue')
  })

  it('rejects duplicate palette ids', async () => {
    const algorithm = createPatternAlgorithm()
    const source = image(1, 1, [[255, 0, 0]])
    const duplicatePalette: MaterialPalette = {
      id: 'duplicate',
      name: 'Duplicate',
      colors: [palette.colors[0]!, palette.colors[0]!],
    }

    await assert.rejects(() => algorithm.generate({
      image: source,
      palette: duplicatePalette,
      options: { width: 1, height: 1, maxColors: 1 },
    }), /unique/)
  })

  it('rejects canvas sizes beyond the MVP processing limit', async () => {
    const algorithm = createPatternAlgorithm()
    const source = image(1, 1, [[255, 0, 0]])

    await assert.rejects(() => algorithm.generate({
      image: source,
      palette,
      options: { width: 257, height: 257, maxColors: 2 },
    }), /limit/)
  })

  it('rejects non-finite landmark coordinates from analysis adapters', async () => {
    const algorithm = createPatternAlgorithm()
    const source = image(1, 1, [[255, 0, 0]])

    await assert.rejects(() => algorithm.generate({
      image: source,
      palette,
      options: { width: 1, height: 1, maxColors: 2 },
      analysis: {
        landmarks: [
          { id: 'eye', kind: 'eye', x: Number.NaN, y: 0, confidence: 1, priority: 'hard' },
        ],
      },
    }), /Landmark/)
  })

  it('rejects palette channels outside the sRGB byte range', async () => {
    const algorithm = createPatternAlgorithm()
    const source = image(1, 1, [[255, 0, 0]])
    const invalidPalette: MaterialPalette = {
      id: 'invalid',
      name: 'Invalid',
      colors: [
        { id: 'bad', name: 'Bad', hex: '#000000', rgb: [300, 0, 0] },
      ],
    }

    await assert.rejects(() => algorithm.generate({
      image: source,
      palette: invalidPalette,
      options: { width: 1, height: 1, maxColors: 1 },
    }), /sRGB/)
  })
})
