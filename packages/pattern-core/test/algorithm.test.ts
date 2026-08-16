import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createPatternAlgorithm,
  optimizeGrid,
  type MaterialPalette,
  type PatternGenerationRequest,
  type PixelImage,
} from '../src/index.js'
import { buildSourceGuidance } from '../src/structure.js'

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
  it('keeps automatic image edges separate from semantic importance', () => {
    const source = image(3, 1, [
      [255, 0, 0], [0, 0, 255], [255, 0, 0],
    ])

    const guidance = buildSourceGuidance(source, undefined)

    assert.ok([...guidance.edge].some((weight) => weight > 0))
    assert.deepEqual([...guidance.importance], [0, 0, 0])
  })

  it('rejects malformed RGBA input', async () => {
    const algorithm = createPatternAlgorithm()
    const request = fixedRequest({ width: 2, height: 2, data: new Uint8ClampedArray(3) })

    await assert.rejects(() => algorithm.generate(request), /RGBA/)
  })

  it('uses isolated-cell penalty as a numeric cleanup weight', () => {
    const input = [
      'red', 'red', 'red',
      'red', 'blue', 'red',
      'red', 'red', 'red',
    ]

    const lowPenalty = optimizeGrid(input, 3, 3, new Set(), {
      minRegionSize: 2,
      isolatedPixelPenalty: 0,
      stripePenalty: 0,
      aliasPenalty: 0,
    })
    const highPenalty = optimizeGrid(input, 3, 3, new Set(), {
      minRegionSize: 2,
      isolatedPixelPenalty: 1,
      stripePenalty: 0,
      aliasPenalty: 0,
    })

    assert.equal(lowPenalty.colorIds[4], 'blue')
    assert.equal(highPenalty.colorIds[4], 'red')
  })

  it('uses stripe and alias penalties as numeric topology weights', () => {
    const stripeInput = [
      'blue', 'blue', 'blue',
      'red', 'blue', 'red',
      'blue', 'blue', 'blue',
    ]
    const aliasInput = [
      'red', 'red', 'blue',
      'red', 'blue', 'red',
      'red', 'blue', 'red',
    ]

    const weakStripe = optimizeGrid(stripeInput, 3, 3, new Set(), {
      minRegionSize: 1,
      stripePenalty: 0.25,
      aliasPenalty: 0,
    })
    const strongStripe = optimizeGrid(stripeInput, 3, 3, new Set(), {
      minRegionSize: 1,
      stripePenalty: 1,
      aliasPenalty: 0,
    })
    const weakAlias = optimizeGrid(aliasInput, 3, 3, new Set(), {
      minRegionSize: 1,
      stripePenalty: 0,
      aliasPenalty: 0.1,
    })
    const strongAlias = optimizeGrid(aliasInput, 3, 3, new Set(), {
      minRegionSize: 1,
      stripePenalty: 0,
      aliasPenalty: 1,
    })

    assert.equal(weakStripe.colorIds[4], 'blue')
    assert.equal(strongStripe.colorIds[4], 'red')
    assert.equal(weakAlias.colorIds[4], 'blue')
    assert.equal(strongAlias.colorIds[4], 'red')
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

  it('locks the full hard-feature grid radius during cleanup', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const red = [255, 0, 0] as const
    const blue = [0, 0, 255] as const
    const pixels: Array<typeof red | typeof blue> = Array.from({ length: 25 }, () => red)
    pixels[6] = blue
    pixels[12] = blue
    const source = image(5, 5, pixels)
    const request = fixedRequest(source, {
      optimization: {
        minRegionSize: 2,
        isolatedPixelPenalty: 1,
        stripePenalty: 0,
        aliasPenalty: 0,
        paletteCoherence: 0,
        localSearchIterations: 0,
      },
    })
    request.analysis = {
      confidence: 1,
      landmarks: [{
        id: 'eye',
        kind: 'eye',
        x: 2,
        y: 2,
        confidence: 1,
        priority: 'hard',
        sourceRadiusPx: 0,
        gridRadiusCells: 1,
      }],
    }

    const result = await algorithm.generate(request)

    assert.equal(result.pattern.cells.find((cell) => cell.x === 1 && cell.y === 1)?.colorId, 'blue')
    assert.equal(result.pattern.cells.find((cell) => cell.x === 2 && cell.y === 2)?.colorId, 'blue')
  })

  it('keeps hard-feature labels fixed during palette coherence optimization', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const red = [255, 0, 0] as const
    const blue = [0, 0, 255] as const
    const source = image(3, 3, [red, red, red, red, blue, red, red, red, red])
    const request = fixedRequest(source, {
      optimization: {
        minRegionSize: 1,
        paletteCoherence: 1_000,
        localSearchIterations: 1,
        edgeProtection: 0,
        stripePenalty: 0,
        aliasPenalty: 0,
      },
    })
    request.analysis = {
      confidence: 1,
      landmarks: [{
        id: 'eye',
        kind: 'eye',
        x: 1,
        y: 1,
        confidence: 1,
        priority: 'hard',
        sourceRadiusPx: 0,
        gridRadiusCells: 0,
      }],
    }

    const result = await algorithm.generate(request)

    assert.equal(result.pattern.cells.find((cell) => cell.x === 1 && cell.y === 1)?.colorId, 'blue')
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
    assert.equal(result.pattern.cells.length, 4)
  })

  it('keeps a wide image proportional and centers it inside a square grid', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(4, 2, Array.from({ length: 8 }, () => [255, 0, 0] as const))
    const result = await algorithm.generate(fixedRequest(source, {
      canvas: { mode: 'fixed', size: { width: 4, height: 4 } },
      backgroundRgb: [255, 255, 255],
      optimization: { minRegionSize: 1 },
    }))

    assert.equal(result.pattern.cells.length, 8)
    assert.equal(result.pattern.metadata.totalBeads, 8)
    assert.deepEqual([...new Set(result.pattern.cells.map((cell) => cell.y))], [1, 2])
    assert.deepEqual(result.materialCounts, [{ colorId: 'red', count: 8 }])
  })

  it('maps protected landmarks into the centered content area', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(4, 1, [
      [255, 0, 0], [0, 0, 255], [255, 0, 0], [255, 0, 0],
    ])
    const request = fixedRequest(source, {
      canvas: { mode: 'fixed', size: { width: 4, height: 4 } },
      optimization: { minRegionSize: 2, isolatedPixelPenalty: 1 },
    })
    request.analysis = {
      landmarks: [
        { id: 'eye', kind: 'eye', x: 1, y: 0, confidence: 1, priority: 'hard', radius: 0 },
      ],
    }

    const result = await algorithm.generate(request)
    const protectedCell = result.pattern.cells.find((cell) => cell.x === 1 && cell.y === 1)

    assert.equal(result.pattern.cells.length, 4)
    assert.equal(protectedCell?.colorId, 'blue')
  })

  it('keeps a tall image proportional and centers it inside a square grid', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(2, 4, Array.from({ length: 8 }, () => [0, 0, 255] as const))
    const result = await algorithm.generate(fixedRequest(source, {
      canvas: { mode: 'fixed', size: { width: 4, height: 4 } },
      optimization: { minRegionSize: 1 },
    }))

    assert.equal(result.pattern.cells.length, 8)
    assert.deepEqual([...new Set(result.pattern.cells.map((cell) => cell.x))], [1, 2])
    assert.deepEqual(result.materialCounts, [{ colorId: 'blue', count: 8 }])
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

  it('rejects non-finite importance weights from analysis adapters', async () => {
    const algorithm = createPatternAlgorithm()
    const source = image(1, 1, [[255, 0, 0]])

    await assert.rejects(() => algorithm.generate({
      image: source,
      palette,
      options: { width: 1, height: 1, maxColors: 2 },
      analysis: {
        importanceMap: { width: 1, height: 1, weights: new Float32Array([Number.NaN]) },
      },
    }), /Importance map values/)
  })

  it('rejects non-finite grid optimization weights', async () => {
    const algorithm = createPatternAlgorithm()
    const source = image(1, 1, [[255, 0, 0]])

    await assert.rejects(() => algorithm.generate(fixedRequest(source, {
      optimization: { isolatedPixelPenalty: Number.NaN },
    })), /Optimization/)
  })

  it('rejects feature radii beyond the source and grid limits', async () => {
    const algorithm = createPatternAlgorithm()
    const source = image(2, 2, Array.from({ length: 4 }, () => [255, 0, 0] as const))
    const request = fixedRequest(source)
    request.analysis = {
      landmarks: [{
        id: 'eye',
        kind: 'eye',
        x: 0,
        y: 0,
        confidence: 1,
        priority: 'hard',
        sourceRadiusPx: 10,
        gridRadiusCells: 300,
      }],
    }

    await assert.rejects(() => algorithm.generate(request), /radius/)
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

  it('uses importance-guided sampling to preserve a tiny hard feature', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const red = [255, 0, 0] as const
    const blue = [0, 0, 255] as const
    const source = image(4, 4, [
      red, red, red, red,
      red, blue, red, red,
      red, red, red, red,
      red, red, red, red,
    ])
    const importance = new Float32Array(16)
    importance[5] = 1
    const analysis = {
      importanceMap: { width: 4, height: 4, weights: importance },
      landmarks: [
        { id: 'eye', kind: 'eye' as const, x: 1, y: 1, confidence: 1, priority: 'hard' as const, radius: 0 },
      ],
    }
    const baseOptions = {
      canvas: { mode: 'fixed' as const, size: { width: 2, height: 2 } },
      maxColors: 2,
      styles: ['faithful'] as const,
      optimization: { minRegionSize: 1 },
    }

    const area = await algorithm.generate({ image: source, palette, analysis, options: { ...baseOptions, baseline: 'a1' } })
    const structural = await algorithm.generate({ image: source, palette, analysis, options: { ...baseOptions, baseline: 'mvp' } })

    assert.equal(area.pattern.cells.find((cell) => cell.x === 0 && cell.y === 0)?.colorId, 'red')
    assert.equal(structural.pattern.cells.find((cell) => cell.x === 0 && cell.y === 0)?.colorId, 'blue')
  })

  it('reports zero feature confidence when visual analysis is absent', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(2, 2, Array.from({ length: 4 }, () => [255, 0, 0] as const))

    const result = await algorithm.generate(fixedRequest(source))

    assert.equal(result.metrics.featureExpressibility, 0)
    assert.equal(result.metrics.featureVisibilityConfidence, 0)
  })

  it('scores feature visibility from the final grid colors', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const redOnlyPalette: MaterialPalette = {
      id: 'red-only',
      name: 'Red only',
      colors: [palette.colors[2]!],
    }
    const red = [255, 0, 0] as const
    const blue = [0, 0, 255] as const
    const source = image(3, 3, [red, red, red, red, blue, red, red, red, red])
    const request = fixedRequest(source, {
      maxColors: 1,
      optimization: { minRegionSize: 1, paletteCoherence: 0, localSearchIterations: 0 },
    })
    request.palette = redOnlyPalette
    request.analysis = {
      confidence: 1,
      landmarks: [{
        id: 'eye',
        kind: 'eye',
        x: 1,
        y: 1,
        confidence: 1,
        priority: 'hard',
        sourceRadiusPx: 0,
        gridRadiusCells: 0,
      }],
    }

    const result = await algorithm.generate(request)

    assert.equal(result.metrics.featureVisibilityConfidence, 1)
    assert.ok(result.metrics.featureExpressibility < 0.2)
  })

  it('reports source fidelity separately from design-plan fidelity', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(2, 2, [
      [255, 0, 0], [0, 0, 255],
      [255, 0, 0], [0, 0, 255],
    ])

    const result = await algorithm.generate(fixedRequest(source, { styles: ['high-contrast'] }))

    assert.ok(Number.isFinite(result.metrics.sourceMeanColorDistance))
    assert.ok(Number.isFinite(result.metrics.planMeanColorDistance))
    assert.ok(Number.isFinite(result.recommended.score.sourceFidelity))
    assert.ok(Number.isFinite(result.recommended.score.planFidelity))
  })

  it('reduces a semantic gradient to a controlled three-level value design', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const grayscalePalette: MaterialPalette = {
      id: 'gray',
      name: 'Gray',
      colors: [20, 70, 120, 180, 240].map((value) => ({
        id: `gray-${value}`,
        name: `Gray ${value}`,
        hex: `#${value.toString(16).padStart(2, '0').repeat(3)}`,
        rgb: [value, value, value] as const,
      })),
    }
    const source = image(5, 1, [[20, 20, 20], [70, 70, 70], [120, 120, 120], [180, 180, 180], [240, 240, 240]])

    const result = await algorithm.generate({
      image: source,
      palette: grayscalePalette,
      analysis: {
        semanticRegions: [{
          id: 'face',
          label: 'face',
          confidence: 1,
          mask: { width: 5, height: 1, values: new Float32Array([1, 1, 1, 1, 1]) },
        }],
      },
      options: {
        canvas: { mode: 'fixed', size: { width: 5, height: 1 } },
        maxColors: 5,
        styles: ['faithful'],
        structure: { valueLevels: 3 },
        optimization: { minRegionSize: 1 },
      },
    })

    assert.ok(result.metrics.uniqueColors >= 2)
    assert.ok(result.metrics.uniqueColors <= 3)
  })

  it('scores canvas candidates by landmark expressibility', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(8, 2, Array.from({ length: 16 }, () => [255, 0, 0] as const))
    const result = await algorithm.generate({
      image: source,
      palette,
      analysis: {
        landmarks: [
          { id: 'left-eye', kind: 'eye', x: 2.1, y: 0.5, confidence: 1, priority: 'hard', symmetryGroup: 'eyes' },
          { id: 'right-eye', kind: 'eye', x: 3.9, y: 0.5, confidence: 1, priority: 'hard', symmetryGroup: 'eyes' },
        ],
      },
      options: {
        canvas: { mode: 'auto', candidates: [{ width: 2, height: 2 }, { width: 8, height: 8 }] },
        maxColors: 2,
        maxCandidates: 2,
        styles: ['faithful'],
        optimization: { minRegionSize: 1 },
      },
    })

    assert.equal(result.recommended.pattern.width, 8)
    assert.ok(result.recommended.metrics.featureExpressibility > result.alternatives[0]!.metrics.featureExpressibility)
  })

  it('uses neighborhood-aware palette optimization to absorb a weak isolated color', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const red = [255, 0, 0] as const
    const purple = [120, 0, 135] as const
    const source = image(3, 3, [red, red, red, red, purple, red, red, red, red])

    const result = await algorithm.generate(fixedRequest(source, {
      maxColors: 2,
      optimization: { minRegionSize: 1, paletteCoherence: 3, localSearchIterations: 3 },
    }))

    assert.equal(result.pattern.cells[4]?.colorId, 'red')
    assert.ok(result.metrics.paletteOptimizationChanges >= 1)
  })
})
