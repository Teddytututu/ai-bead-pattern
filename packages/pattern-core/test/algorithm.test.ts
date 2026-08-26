import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createPatternAlgorithm,
  optimizeGrid,
  type MaterialPalette,
  type PatternGenerationResult,
  type PatternGenerationSuccess,
  type PatternCandidate,
  type PatternGenerationRequest,
  type PixelImage,
} from '../src/index.js'
import { arrayFingerprint } from '../src/pipeline.js'
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

function success(result: PatternGenerationResult): PatternGenerationSuccess {
  if (result.status !== 'success') throw new Error(`Expected success, received ${result.status}`)
  return result
}

function candidate(result: PatternGenerationResult): PatternCandidate {
  const value = result.recommended ?? result.bestEffort
  if (value === undefined) throw new Error('Expected a generated candidate')
  return value
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

  it('resolves conflicting stripe directions without horizontal bias', () => {
    const result = optimizeGrid([
      'green', 'blue', 'green',
      'red', 'green', 'red',
      'green', 'blue', 'green',
    ], 3, 3, new Set(), {
      minRegionSize: 1,
      stripePenalty: 1,
      aliasPenalty: 0,
    })

    assert.equal(result.colorIds[4], 'green')
  })

  it('keeps the current cell when stripe directions have equal support', () => {
    const result = optimizeGrid([
      'green', 'zebra', 'green',
      'amber', 'green', 'amber',
      'green', 'zebra', 'green',
    ], 3, 3, new Set(), {
      minRegionSize: 1,
      stripePenalty: 1,
      aliasPenalty: 0,
    })

    assert.equal(result.colorIds[4], 'green')
    assert.equal(result.edits.length, 0)
  })

  it('generates the requested grid with legal colors and accurate material counts', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(2, 2, [
      [255, 0, 0], [255, 0, 0],
      [0, 0, 255], [255, 255, 255],
    ])

    const result = await algorithm.generate(fixedRequest(source, { maxColors: 2 }))

    assert.equal(success(result).pattern.width, 2)
    assert.equal(success(result).pattern.height, 2)
    assert.equal(success(result).pattern.cells.length, 4)
    assert.ok(success(result).pattern.palette.length <= 2)
    assert.deepEqual(
      success(result).materialCounts.map((entry) => entry.count).reduce((sum, count) => sum + count, 0),
      4,
    )
    assert.deepEqual(success(result).pattern, success(result).recommended.pattern)
    assert.deepEqual(success(result).materialCounts, success(result).recommended.materialCounts)
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

    assert.deepEqual(success(first).pattern.cells, success(second).pattern.cells)
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

    assert.equal(success(result).pattern.cells[4]?.colorId, 'red')
    assert.ok(success(result).metrics.removedSmallRegions >= 1)
    assert.ok(success(result).metrics.meanColorDistance > 0)
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

    assert.equal(success(result).pattern.cells[4]?.colorId, 'blue')
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

    assert.equal(candidate(result).pattern.cells.find((cell) => cell.x === 1 && cell.y === 1)?.colorId, 'blue')
    assert.equal(candidate(result).pattern.cells.find((cell) => cell.x === 2 && cell.y === 2)?.colorId, 'blue')
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

    assert.equal(success(result).pattern.cells.find((cell) => cell.x === 1 && cell.y === 1)?.colorId, 'blue')
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
    assert.equal(result.evaluation.rankedCandidateIds[0], success(result).recommended.id)
    assert.equal(new Set(result.evaluation.rankedCandidateIds).size, result.evaluation.rankedCandidateIds.length)
    assert.equal(Object.keys(result.evaluation.scores).length, result.evaluation.rankedCandidateIds.length)
    assert.ok([2, 4].includes(success(result).pattern.width))
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

    assert.equal(success(result).pattern.cells[0]?.colorId, 'white')
  })

  it('supports the legacy width and height contract', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(1, 1, [[255, 0, 0]])
    const result = await algorithm.generate({
      image: source,
      palette,
      options: { width: 2, height: 3, maxColors: 2, styles: ['faithful'] },
    })

    assert.equal(success(result).pattern.width, 2)
    assert.equal(success(result).pattern.height, 3)
    assert.equal(success(result).pattern.cells.length, 4)
  })

  it('keeps a wide image proportional and centers it inside a square grid', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(4, 2, Array.from({ length: 8 }, () => [255, 0, 0] as const))
    const result = await algorithm.generate(fixedRequest(source, {
      canvas: { mode: 'fixed', size: { width: 4, height: 4 } },
      backgroundRgb: [255, 255, 255],
      optimization: { minRegionSize: 1 },
    }))

    assert.equal(success(result).pattern.cells.length, 8)
    assert.equal(success(result).pattern.metadata.totalBeads, 8)
    assert.deepEqual([...new Set(success(result).pattern.cells.map((cell) => cell.y))], [1, 2])
    assert.deepEqual(success(result).materialCounts, [{ colorId: 'red', count: 8 }])
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
    const protectedCell = success(result).pattern.cells.find((cell) => cell.x === 1 && cell.y === 1)

    assert.equal(success(result).pattern.cells.length, 4)
    assert.equal(protectedCell?.colorId, 'blue')
  })

  it('keeps a tall image proportional and centers it inside a square grid', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(2, 4, Array.from({ length: 8 }, () => [0, 0, 255] as const))
    const result = await algorithm.generate(fixedRequest(source, {
      canvas: { mode: 'fixed', size: { width: 4, height: 4 } },
      optimization: { minRegionSize: 1 },
    }))

    assert.equal(success(result).pattern.cells.length, 8)
    assert.deepEqual([...new Set(success(result).pattern.cells.map((cell) => cell.x))], [1, 2])
    assert.deepEqual(success(result).materialCounts, [{ colorId: 'blue', count: 8 }])
  })

  it('keeps the raw isolated cell in the A0 comparison route', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const red = [255, 0, 0] as const
    const blue = [0, 0, 255] as const
    const source = image(3, 3, [red, red, red, red, blue, red, red, red, red])

    const result = await algorithm.generate(fixedRequest(source, { baseline: 'a0' }))

    assert.equal(success(result).pattern.cells[4]?.colorId, 'blue')
    assert.equal(success(result).metrics.removedSmallRegions, 0)
  })

  it('applies the analysis crop before grid generation', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(2, 1, [[255, 0, 0], [0, 0, 255]])
    const request = fixedRequest(source, {
      canvas: { mode: 'fixed', size: { width: 1, height: 1 } },
    })
    request.analysis = { suggestedCrop: { x: 1, y: 0, width: 1, height: 1 } }

    const result = await algorithm.generate(request)

    assert.equal(success(result).pattern.cells[0]?.colorId, 'blue')
  })

  it('uses suggested crop confidence independently from the analysis summary', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(2, 1, [[255, 0, 0], [0, 0, 255]])
    const request = fixedRequest(source, {
      canvas: { mode: 'fixed', size: { width: 1, height: 1 } },
      baseline: 'a1',
    })
    request.analysis = {
      confidence: 1,
      suggestedCrop: { x: 0, y: 0, width: 1, height: 1 },
      suggestedCropSource: 'automatic',
      suggestedCropConfidence: 0,
    }

    const result = await algorithm.generate(request)

    assert.equal(success(result).pattern.cells[0]?.colorId, 'blue')
  })

  it('rejects malformed crop metadata from analysis adapters', async () => {
    const algorithm = createPatternAlgorithm()
    const source = image(1, 1, [[255, 0, 0]])
    const request = fixedRequest(source)
    request.analysis = {
      suggestedCrop: { x: 0, y: 0, width: 0, height: 1 },
      suggestedCropSource: 'automatic',
    }

    await assert.rejects(() => algorithm.generate(request), /crop dimensions/)
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

  it('enforces online image, palette, color, and candidate budgets', async () => {
    const algorithm = createPatternAlgorithm()
    const oversizedImage: PixelImage = {
      width: 2049,
      height: 1,
      data: new Uint8ClampedArray(2049 * 4),
    }
    const oversizedPalette: MaterialPalette = {
      id: 'oversized',
      name: 'Oversized',
      colors: Array.from({ length: 129 }, (_, index) => ({
        id: `color-${index}`,
        name: `Color ${index}`,
        hex: '#000000',
        rgb: [index % 256, 0, 0] as const,
      })),
    }
    const source = image(1, 1, [[255, 0, 0]])

    await assert.rejects(() => algorithm.generate(fixedRequest(oversizedImage)), /Image/)
    await assert.rejects(() => algorithm.generate({
      image: source,
      palette: oversizedPalette,
      options: { width: 1, height: 1, maxColors: 1 },
    }), /Palette/)
    await assert.rejects(() => algorithm.generate(fixedRequest(source, { maxColors: 49 })), /maxColors/)
    await assert.rejects(() => algorithm.generate(fixedRequest(source, {
      canvas: { mode: 'fixed', size: { width: 97, height: 1 } },
    })), /Canvas/)
    await assert.rejects(() => algorithm.generate(fixedRequest(source, {
      canvas: {
        mode: 'auto',
        candidates: Array.from({ length: 5 }, (_, index) => ({ width: index + 1, height: index + 1 })),
      },
      styles: ['faithful', 'cute', 'simple', 'high-contrast', 'soft'],
    })), /candidate/)
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

    assert.equal(candidate(area).pattern.cells.find((cell) => cell.x === 0 && cell.y === 0)?.colorId, 'red')
    assert.equal(candidate(structural).pattern.cells.find((cell) => cell.x === 0 && cell.y === 0)?.colorId, 'blue')
  })

  it('uses a confident subject mask as MVP bead occupancy', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const red = [255, 0, 0] as const
    const source = image(4, 4, Array.from({ length: 16 }, () => red))
    const subjectValues = new Float32Array(16)
    subjectValues[5] = 1
    subjectValues[6] = 1
    subjectValues[9] = 1
    subjectValues[10] = 1
    const analysis = {
      confidence: 1,
      subjectMask: { width: 4, height: 4, values: subjectValues },
    }

    const result = await algorithm.generate({
      ...fixedRequest(source),
      analysis,
      options: {
        ...fixedRequest(source).options,
        structure: { occupancyMode: 'subject-shape' },
      },
    })

    assert.equal(candidate(result).pattern.cells.length, 4)
    assert.deepEqual(
      candidate(result).pattern.cells.map((cell) => [cell.x, cell.y]),
      [[1, 1], [2, 1], [1, 2], [2, 2]],
    )
    assert.equal(candidate(result).metrics.shapeApplied, true)
    assert.equal(candidate(result).metrics.targetShapeComponents, 1)
    assert.equal(candidate(result).metrics.referenceShapeComponents, 1)
  })

  it('compares full-frame and subject-shape candidates in automatic occupancy mode', async () => {
    const source = image(4, 4, Array.from({ length: 16 }, () => [255, 0, 0] as const))
    const subjectValues = new Float32Array(16)
    subjectValues[5] = 1
    subjectValues[6] = 1
    subjectValues[9] = 1
    subjectValues[10] = 1
    const result = await createPatternAlgorithm({ clock: () => 123 }).generate({
      image: source,
      palette,
      analysis: {
        confidence: 1,
        subjectMask: { width: 4, height: 4, values: subjectValues },
      },
      options: {
        canvas: { mode: 'fixed', size: { width: 4, height: 4 } },
        maxColors: 2,
        maxCandidates: 2,
        styles: ['faithful'],
        structure: { occupancyMode: 'auto' },
      },
    })
    const candidates = [result.recommended ?? result.bestEffort, ...result.alternatives]
      .filter((entry) => entry !== undefined)

    assert.deepEqual(
      new Set(candidates.map((entry) => entry!.canvasPlan?.occupancyMode)),
      new Set(['full-frame', 'subject-shape']),
    )
    assert.deepEqual(
      new Set(candidates.map((entry) => entry!.metrics.shapeApplied)),
      new Set([false, true]),
    )
    for (const entry of candidates) {
      assert.equal(entry!.canvasPlan?.estimatedBeads, entry!.metrics.totalBeads)
    }
  })

  it('uses the subject shape to evaluate explicit full-frame canvas plans', async () => {
    const source = image(8, 8, Array.from({ length: 64 }, () => [255, 0, 0] as const))
    const subjectValues = new Float32Array(64)
    for (let y = 1; y < 4; y += 1) {
      for (let x = 1; x < 3; x += 1) subjectValues[y * 8 + x] = 1
    }
    const result = await createPatternAlgorithm({ clock: () => 123 }).generate({
      image: source,
      palette,
      analysis: {
        confidence: 1,
        subjectMask: { width: 8, height: 8, values: subjectValues },
        landmarks: [
          { id: 'eye', kind: 'eye', x: 7, y: 7, confidence: 1, priority: 'hard' },
        ],
      },
      options: {
        canvas: {
          mode: 'auto',
          candidates: [{ width: 8, height: 8 }, { width: 12, height: 12 }],
        },
        maxColors: 2,
        maxCandidates: 2,
        styles: ['faithful'],
        structure: { occupancyMode: 'full-frame' },
      },
    })
    const candidates = [result.recommended ?? result.bestEffort, ...result.alternatives]
      .filter((entry) => entry !== undefined)

    assert.equal(candidates.length, 2)
    for (const entry of candidates) {
      assert.equal(entry!.metrics.shapeApplied, false)
      assert.ok(entry!.canvasPlan!.subjectCoverage < 1)
      assert.ok(entry!.canvasPlan!.score.subject < 1)
      assert.ok(entry!.canvasPlan!.score.composition < 1)
      assert.equal(entry!.canvasPlan!.featureBudgets[0]!.allocatedCells, 0)
      assert.equal(entry!.canvasPlan!.featureBudgets[0]!.feasible, false)
      assert.equal(entry!.canvasPlan!.estimatedBeads, entry!.metrics.totalBeads)
    }
  })

  it('honors explicit occupancy selection', async () => {
    const source = image(2, 2, Array.from({ length: 4 }, () => [255, 0, 0] as const))
    const base = {
      image: source,
      palette,
      analysis: {
        confidence: 0.2,
        subjectMask: { width: 2, height: 2, values: new Float32Array([1, 0, 0, 0]) },
      },
      options: {
        canvas: { mode: 'fixed' as const, size: { width: 2, height: 2 } },
        maxColors: 2,
        styles: ['faithful' as const],
      },
    }
    const subject = await createPatternAlgorithm().generate({
      ...base,
      options: { ...base.options, structure: { occupancyMode: 'subject-shape' as const } },
    })
    const full = await createPatternAlgorithm().generate({
      ...base,
      options: { ...base.options, structure: { occupancyMode: 'full-frame' as const } },
    })

    assert.equal(candidate(subject).metrics.shapeApplied, true)
    assert.equal(candidate(full).metrics.shapeApplied, false)
  })

  it('rejects an empty mask for explicit subject occupancy', async () => {
    const source = image(2, 2, Array.from({ length: 4 }, () => [255, 0, 0] as const))
    const request = fixedRequest(source, {
      structure: { occupancyMode: 'subject-shape' },
    })
    request.analysis = {
      confidence: 1,
      subjectMask: { width: 2, height: 2, values: new Float32Array(4).fill(0.49) },
    }

    await assert.rejects(() => createPatternAlgorithm().generate(request), /non-empty subject mask/)
  })

  it('keeps automatic occupancy within the eighteen-candidate default budget', async () => {
    const source = image(2, 2, Array.from({ length: 4 }, () => [255, 0, 0] as const))
    const result = await createPatternAlgorithm().generate({
      image: source,
      palette,
      analysis: {
        confidence: 1,
        subjectMask: { width: 2, height: 2, values: new Float32Array([1, 0, 0, 0]) },
      },
      options: {
        canvas: {
          mode: 'auto',
          candidates: [
            { width: 2, height: 2 },
            { width: 3, height: 3 },
            { width: 4, height: 4 },
          ],
        },
        maxColors: 2,
        maxCandidates: 18,
        styles: ['faithful', 'simple', 'high-contrast'],
        structure: { occupancyMode: 'auto' },
      },
    })

    assert.equal([result.recommended ?? result.bestEffort, ...result.alternatives]
      .filter((entry) => entry !== undefined).length, 18)
  })

  it('keeps A1 as a full-frame comparison when a subject mask exists', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(2, 2, Array.from({ length: 4 }, () => [255, 0, 0] as const))
    const analysis = {
      confidence: 1,
      subjectMask: { width: 2, height: 2, values: new Float32Array([1, 0, 0, 0]) },
    }

    const result = await algorithm.generate({
      image: source,
      palette,
      analysis,
      options: {
        canvas: { mode: 'fixed', size: { width: 2, height: 2 } },
        maxColors: 2,
        baseline: 'a1',
      },
    })

    assert.equal(candidate(result).pattern.cells.length, 4)
    assert.equal(candidate(result).metrics.shapeApplied, false)
  })

  it('falls back to full-frame occupancy for a low-confidence subject mask', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(2, 2, Array.from({ length: 4 }, () => [255, 0, 0] as const))
    const request = fixedRequest(source)
    request.analysis = {
      confidence: 0.2,
      subjectMask: { width: 2, height: 2, values: new Float32Array([1, 0, 0, 0]) },
    }

    const result = await algorithm.generate(request)

    assert.equal(candidate(result).pattern.cells.length, 4)
    assert.equal(candidate(result).metrics.shapeApplied, false)
  })

  it('reports zero feature confidence when visual analysis is absent', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(2, 2, Array.from({ length: 4 }, () => [255, 0, 0] as const))

    const result = await algorithm.generate(fixedRequest(source))

    assert.equal(success(result).metrics.featureExpressibility, 0)
    assert.equal(success(result).metrics.featureVisibilityConfidence, 0)
  })

  it('keeps landmark confidence independent from the analysis summary', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(2, 2, Array.from({ length: 4 }, () => [255, 0, 0] as const))
    const request = fixedRequest(source)
    request.analysis = {
      confidence: 0,
      landmarks: [{
        id: 'eye',
        kind: 'eye',
        x: 0,
        y: 0,
        confidence: 1,
        priority: 'hard',
      }],
    }

    const result = await algorithm.generate(request)

    assert.equal(candidate(result).metrics.featureVisibilityConfidence, 1)
    assert.ok(candidate(result).metrics.featureExpressibility > 0)
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

    assert.equal(candidate(result).metrics.featureVisibilityConfidence, 1)
    assert.ok(candidate(result).metrics.featureExpressibility < 0.2)
  })

  it('reports source fidelity separately from design-plan fidelity', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const grayPalette: MaterialPalette = {
      id: 'two-grays',
      name: 'Two grays',
      colors: [100, 150].map((value) => ({
        id: `gray-${value}`,
        name: `Gray ${value}`,
        hex: `#${value.toString(16).padStart(2, '0').repeat(3)}`,
        rgb: [value, value, value] as const,
      })),
    }
    const source = image(2, 2, [
      [120, 120, 120], [140, 140, 140],
      [120, 120, 120], [140, 140, 140],
    ])
    const request = fixedRequest(source, { styles: ['high-contrast'], maxColors: 2 })
    request.palette = grayPalette

    const result = await algorithm.generate(request)

    assert.notEqual(success(result).metrics.sourceMeanColorDistance, success(result).metrics.planMeanColorDistance)
    assert.equal(success(result).recommended.score.colorFidelity, success(result).recommended.score.planFidelity)
    assert.notEqual(success(result).recommended.score.sourceFidelity, success(result).recommended.score.planFidelity)
  })

  it('keeps every public candidate score within zero and one', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const source = image(1, 1, [[255, 255, 255]])

    const result = await algorithm.generate(fixedRequest(source))

    assert.ok(success(result).recommended.score.total >= 0)
    assert.ok(success(result).recommended.score.total <= 1)
  })

  it('keeps semantic region confidence independent from the analysis summary', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const grayPalette: MaterialPalette = {
      id: 'gray',
      name: 'Gray',
      colors: [20, 80, 140, 200, 240].map((value) => ({
        id: `gray-${value}`,
        name: `Gray ${value}`,
        hex: `#${value.toString(16).padStart(2, '0').repeat(3)}`,
        rgb: [value, value, value] as const,
      })),
    }
    const source = image(5, 1, [[20, 20, 20], [80, 80, 80], [140, 140, 140], [200, 200, 200], [240, 240, 240]])
    const base: PatternGenerationRequest = {
      image: source,
      palette: grayPalette,
      options: {
        canvas: { mode: 'fixed', size: { width: 5, height: 1 } },
        maxColors: 5,
        styles: ['faithful'],
        structure: { valueLevels: 2 },
        optimization: { minRegionSize: 1 },
      },
    }

    const zeroConfidence = await algorithm.generate({
      ...base,
      analysis: {
        confidence: 0,
        semanticRegions: [{
          id: 'face',
          label: 'face',
          confidence: 1,
          mask: { width: 5, height: 1, values: new Float32Array([1, 1, 1, 1, 1]) },
        }],
      },
    })
    const fullConfidence = await algorithm.generate({
      ...base,
      analysis: {
        confidence: 1,
        semanticRegions: [{
          id: 'face',
          label: 'face',
          confidence: 1,
          mask: { width: 5, height: 1, values: new Float32Array([1, 1, 1, 1, 1]) },
        }],
      },
    })

    assert.deepEqual(success(zeroConfidence).pattern.cells, success(fullConfidence).pattern.cells)
  })

  it('uses subject mask evidence confidence independently from the analysis summary', async () => {
    const source = image(2, 2, Array.from({ length: 4 }, () => [255, 0, 0] as const))
    const result = await createPatternAlgorithm({ clock: () => 123 }).generate({
      image: source,
      palette,
      analysis: {
        confidence: 0,
        subjectMask: { width: 2, height: 2, values: new Float32Array(4) },
        subjectMaskEvidence: {
          mask: { width: 2, height: 2, values: new Float32Array([1, 0, 0, 0]) },
          confidence: 0.9,
          source: 'ai',
          revision: 'segmentation-1',
          provenance: [{
            origin: 'model',
            provider: 'rembg-http',
            model: 'birefnet-general-lite',
            version: '1',
          }],
        },
      },
      options: {
        canvas: { mode: 'fixed', size: { width: 2, height: 2 } },
        maxColors: 2,
        maxCandidates: 2,
        styles: ['faithful'],
        structure: { occupancyMode: 'auto' },
      },
    })
    const candidates = [result.recommended ?? result.bestEffort, ...result.alternatives]
      .filter((entry) => entry !== undefined)

    assert.deepEqual(
      new Set(candidates.map((entry) => entry!.canvasPlan?.occupancyMode)),
      new Set(['full-frame', 'subject-shape']),
    )
  })

  it('trusts a user-confirmed subject mask in automatic occupancy', async () => {
    const source = image(2, 2, Array.from({ length: 4 }, () => [255, 0, 0] as const))
    const result = await createPatternAlgorithm({ clock: () => 123 }).generate({
      image: source,
      palette,
      analysis: {
        subjectMaskEvidence: {
          mask: { width: 2, height: 2, values: new Float32Array([1, 0, 0, 0]) },
          confidence: 0.2,
          source: 'ai+manual',
          revision: 'confirmed-1',
          userConfirmed: true,
        },
      },
      options: {
        canvas: { mode: 'fixed', size: { width: 2, height: 2 } },
        maxColors: 2,
        maxCandidates: 2,
        styles: ['faithful'],
        structure: { occupancyMode: 'auto' },
      },
    })
    const candidates = [result.recommended ?? result.bestEffort, ...result.alternatives]
      .filter((entry) => entry !== undefined)

    assert.deepEqual(
      new Set(candidates.map((entry) => entry!.canvasPlan?.occupancyMode)),
      new Set(['full-frame', 'subject-shape']),
    )
  })

  it('accepts alpha and heuristic subject mask evidence sources', async () => {
    const source = image(1, 1, [[255, 0, 0]])
    for (const [maskSource, origin] of [
      ['alpha', 'source'],
      ['heuristic', 'heuristic'],
    ] as const) {
      const request = fixedRequest(source)
      request.analysis = {
        subjectMaskEvidence: {
          mask: { width: 1, height: 1, values: new Float32Array([1]) },
          confidence: 1,
          source: maskSource,
          revision: `${maskSource}-1`,
          provenance: [{ origin, provider: `${maskSource}-provider` }],
        },
      }

      const result = await createPatternAlgorithm().generate(request)
      assert.ok(result.recommended ?? result.bestEffort)
    }
  })

  it('includes subject evidence revision and provenance in generation identity', async () => {
    const source = image(1, 1, [[255, 0, 0]])
    const request = (revision: string, legacyMaskValue?: number): PatternGenerationRequest => ({
      image: source,
      palette,
      analysis: {
        ...(legacyMaskValue === undefined ? {} : {
          subjectMask: { width: 1, height: 1, values: new Float32Array([legacyMaskValue]) },
        }),
        subjectMaskEvidence: {
          mask: { width: 1, height: 1, values: new Float32Array([1]) },
          confidence: 1,
          source: 'ai+manual',
          revision,
          userConfirmed: true,
          provenance: [
            { origin: 'model', provider: 'rembg-http', model: 'birefnet-general-lite' },
            { origin: 'manual', provider: 'mask-editor', version: '1' },
          ],
        },
      },
      options: {
        canvas: { mode: 'fixed', size: { width: 1, height: 1 } },
        maxColors: 2,
        styles: ['faithful'],
        structure: { occupancyMode: 'subject-shape' },
      },
    })

    const first = await createPatternAlgorithm().generate(request('revision-1'))
    const second = await createPatternAlgorithm().generate(request('revision-2'))
    const sameEvidenceWithLegacyDrift = await createPatternAlgorithm().generate(request('revision-1', 0))

    assert.notEqual(first.generationId, second.generationId)
    assert.equal(first.generationId, sameEvidenceWithLegacyDrift.generationId)
  })

  it('canonicalizes analysis collection order in generation identity', async () => {
    const source = image(2, 1, [[255, 0, 0], [0, 0, 255]])
    const leftMask = { width: 2, height: 1, values: new Float32Array([1, 0]) }
    const rightMask = { width: 2, height: 1, values: new Float32Array([0, 1]) }
    const provenance = [
      { origin: 'model' as const, provider: 'z-provider', version: '1' },
      { origin: 'model' as const, provider: 'a-provider', version: '1' },
    ]
    const analysis = {
      provenance,
      semanticRegions: [
        { id: 'left', label: 'left', mask: leftMask, confidence: 0.9, provenance },
        { id: 'right', label: 'right', mask: rightMask, confidence: 0.8, provenance },
      ],
      landmarks: [
        { id: 'left-eye', kind: 'eye' as const, x: 0, y: 0, confidence: 0.9, priority: 'hard' as const, provenance },
        { id: 'right-eye', kind: 'eye' as const, x: 1, y: 0, confidence: 0.8, priority: 'hard' as const, provenance },
      ],
    }
    const request = (reverse: boolean): PatternGenerationRequest => ({
      ...fixedRequest(source, {
        canvas: { mode: 'fixed', size: { width: 2, height: 1 } },
      }),
      analysis: reverse ? {
        ...analysis,
        provenance: [...analysis.provenance].reverse(),
        semanticRegions: [...analysis.semanticRegions].reverse().map((region) => ({
          ...region,
          provenance: [...region.provenance].reverse(),
        })),
        landmarks: [...analysis.landmarks].reverse().map((landmark) => ({
          ...landmark,
          provenance: [...landmark.provenance].reverse(),
        })),
      } : analysis,
    })

    const first = await createPatternAlgorithm().generate(request(false))
    const second = await createPatternAlgorithm().generate(request(true))

    assert.equal(first.generationId, second.generationId)
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

    assert.ok(success(result).metrics.uniqueColors >= 2)
    assert.ok(success(result).metrics.uniqueColors <= 3)
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

    assert.equal(result.status, 'best-effort')
    assert.equal(result.bestEffort?.pattern.width, 8)
    assert.equal(result.bestEffort?.canvasPlan?.size.width, 8)
    assert.ok(result.bestEffort!.metrics.featureExpressibility > result.alternatives[0]!.metrics.featureExpressibility)
  })

  it('uses a shared reference scale when ranking canvas detail', async () => {
    const detailCells = new Set([3, 11, 19, 27, 35, 43, 51, 59])
    const pixels = Array.from({ length: 64 }, (_, index) => detailCells.has(index)
      ? [0, 0, 0] as const
      : [255, 255, 255] as const)
    const result = await createPatternAlgorithm().generate({
      image: image(8, 8, pixels),
      palette: {
        id: 'mono',
        name: 'Monochrome',
        colors: [palette.colors[0]!, palette.colors[1]!],
      },
      options: {
        canvas: { mode: 'auto', candidates: [{ width: 2, height: 2 }, { width: 8, height: 8 }] },
        maxColors: 2,
        maxCandidates: 2,
        styles: ['faithful'],
        baseline: 'a1',
        optimization: { minRegionSize: 1, stripePenalty: 0, aliasPenalty: 0 },
      },
    })

    assert.equal(result.status, 'success')
    assert.equal(result.recommended?.pattern.width, 8)
    assert.ok(result.recommended!.metrics.referenceBoundaryAgreement
      > result.alternatives[0]!.metrics.referenceBoundaryAgreement)
  })

  it('vetoes a canvas candidate that merges hard paired features', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const skin = [240, 190, 160] as const
    const black = [0, 0, 0] as const
    const pixels: Array<readonly [number, number, number]> = Array.from({ length: 32 }, () => skin)
    pixels[10] = black
    pixels[11] = black
    const source = image(8, 4, pixels)

    const result = await algorithm.generate({
      image: source,
      palette: {
        id: 'face',
        name: 'Face',
        colors: [
          { id: 'black', name: 'Black', hex: '#000000', rgb: black },
          { id: 'skin', name: 'Skin', hex: '#f0bea0', rgb: skin },
        ],
      },
      analysis: {
        confidence: 1,
        landmarks: [
          { id: 'left-eye', kind: 'eye', x: 2, y: 1, confidence: 1, priority: 'hard', symmetryGroup: 'eyes' },
          { id: 'right-eye', kind: 'eye', x: 3, y: 1, confidence: 1, priority: 'hard', symmetryGroup: 'eyes' },
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

    assert.equal(success(result).recommended.pattern.width, 8)
    assert.equal(success(result).recommended.valid, true)
    assert.equal(result.alternatives[0]?.valid, false)
    assert.ok(result.alternatives[0]?.rejectionReasons.includes('hard-feature-collision'))
  })

  it('lets canvas planning veto a hard pair before final feature scoring', async () => {
    const skin = [240, 190, 160] as const
    const black = [0, 0, 0] as const
    const pixels: Array<readonly [number, number, number]> = Array.from(
      { length: 96 * 96 },
      () => skin,
    )
    pixels[34 * 96 + 42] = black
    pixels[34 * 96 + 46] = black
    const result = await createPatternAlgorithm({ clock: () => 123 }).generate({
      image: image(96, 96, pixels),
      palette: {
        id: 'face',
        name: 'Face',
        colors: [
          { id: 'black', name: 'Black', hex: '#000000', rgb: black },
          { id: 'skin', name: 'Skin', hex: '#f0bea0', rgb: skin },
        ],
      },
      analysis: {
        confidence: 1,
        landmarks: [
          { id: 'left-eye', kind: 'eye', x: 42, y: 34, confidence: 1, priority: 'hard', symmetryGroup: 'eyes' },
          { id: 'right-eye', kind: 'eye', x: 46, y: 34, confidence: 1, priority: 'hard', symmetryGroup: 'eyes' },
        ],
      },
      options: {
        canvas: { mode: 'auto', candidates: [{ width: 12, height: 12 }, { width: 48, height: 48 }] },
        maxColors: 2,
        maxCandidates: 2,
        styles: ['faithful'],
        optimization: { minRegionSize: 1 },
      },
    })

    assert.equal(result.recommended?.pattern.width, 48)
    const small = result.alternatives.find((entry) => entry.pattern.width === 12)
    assert.equal(small?.valid, false)
    assert.ok(small?.rejectionReasons.includes('canvas-hard-feature-collision'))
  })

  it('prefers the smaller canvas when both satisfy hard feature planning', async () => {
    const skin = [240, 190, 160] as const
    const black = [0, 0, 0] as const
    const pixels: Array<readonly [number, number, number]> = Array.from(
      { length: 48 * 48 },
      () => skin,
    )
    pixels[20 * 48 + 24] = black
    const result = await createPatternAlgorithm({ clock: () => 123 }).generate({
      image: image(48, 48, pixels),
      palette: {
        id: 'face',
        name: 'Face',
        colors: [
          { id: 'black', name: 'Black', hex: '#000000', rgb: black },
          { id: 'skin', name: 'Skin', hex: '#f0bea0', rgb: skin },
        ],
      },
      analysis: {
        confidence: 1,
        landmarks: [{ id: 'eye', kind: 'eye', x: 24, y: 20, confidence: 1, priority: 'hard' }],
      },
      options: {
        canvas: { mode: 'auto', candidates: [{ width: 24, height: 24 }, { width: 48, height: 48 }] },
        maxColors: 2,
        maxCandidates: 2,
        styles: ['faithful'],
        optimization: { minRegionSize: 1 },
      },
    })

    assert.equal(result.recommended?.pattern.width, 24)
    assert.ok([result.recommended, ...result.alternatives]
      .filter((entry) => entry !== undefined)
      .every((entry) => entry!.canvasPlan?.feasible))
  })

  it('uses the executed shape rasterization as the canvas planning fact', async () => {
    const rows = [
      '0000000000000000',
      '0000000000000000',
      '0010110000111100',
      '0010111001101000',
      '0010111101000000',
      '0001101110100100',
      '0011101111101000',
      '0011100010110100',
      '0001010100111100',
      '0010000001010100',
      '0000011111111100',
      '0000010011110000',
      '0010001111100000',
      '0000010101101000',
      '0000000000000000',
      '0000000000000000',
    ]
    const source = image(16, 16, Array.from({ length: 256 }, () => [255, 0, 0] as const))
    const result = await createPatternAlgorithm({ clock: () => 123 }).generate({
      image: source,
      palette,
      analysis: {
        confidence: 1,
        subjectMask: {
          width: 16,
          height: 16,
          values: Float32Array.from([...rows.join('')], (value) => Number(value)),
        },
      },
      options: {
        canvas: { mode: 'fixed', size: { width: 8, height: 8 } },
        maxColors: 2,
        maxCandidates: 1,
        styles: ['faithful'],
        structure: {
          occupancyMode: 'subject-shape',
          shapeRefinementIterations: 2,
        },
      },
    })
    const planned = candidate(result)

    assert.ok(planned.metrics.shapeEdits > 0)
    assert.equal(planned.canvasPlan?.estimatedBeads, planned.metrics.totalBeads)
  })

  it('reports total generation timing separately from candidate processing', async () => {
    const source = image(4, 4, Array.from({ length: 16 }, () => [255, 0, 0] as const))
    const result = await createPatternAlgorithm({ clock: () => 123 }).generate({
      image: source,
      palette,
      analysis: {
        confidence: 1,
        subjectMask: {
          width: 4,
          height: 4,
          values: new Float32Array([
            0, 0, 0, 0,
            0, 1, 1, 0,
            0, 1, 1, 0,
            0, 0, 0, 0,
          ]),
        },
      },
      options: {
        canvas: { mode: 'fixed', size: { width: 4, height: 4 } },
        maxColors: 2,
        maxCandidates: 2,
        styles: ['faithful'],
        structure: { occupancyMode: 'auto' },
      },
    })
    const phases = [
      result.timing.shapeModelMs,
      result.timing.shapePlanningMs,
      result.timing.canvasPlanningMs,
      result.timing.candidateGenerationMs,
    ]

    assert.ok(phases.every((value) => Number.isFinite(value) && value >= 0))
    assert.ok(result.timing.coreTotalMs >= phases.reduce((sum, value) => sum + value, 0))
    assert.ok(result.timing.coreTotalMs >= candidate(result).metrics.processingTimeMs)
  })

  it('gives canvas plans distinct identities for different source generations', async () => {
    const subjectMask = {
      width: 2,
      height: 2,
      values: new Float32Array([1, 1, 1, 1]),
    }
    const request = (source: PixelImage): PatternGenerationRequest => ({
      image: source,
      palette,
      analysis: { confidence: 1, subjectMask },
      options: {
        canvas: { mode: 'fixed', size: { width: 2, height: 2 } },
        maxColors: 2,
        maxCandidates: 1,
        styles: ['faithful'],
        structure: { occupancyMode: 'subject-shape' },
      },
    })
    const first = await createPatternAlgorithm({ clock: () => 123 }).generate(request(image(
      2,
      2,
      Array.from({ length: 4 }, () => [255, 0, 0] as const),
    )))
    const second = await createPatternAlgorithm({ clock: () => 123 }).generate(request(image(
      2,
      2,
      Array.from({ length: 4 }, () => [0, 0, 255] as const),
    )))

    assert.notEqual(candidate(first).canvasPlan?.id, candidate(second).canvasPlan?.id)
  })

  it('penalizes fragmented feature regions in the final grid', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 123 })
    const skin = [240, 190, 160] as const
    const black = [0, 0, 0] as const
    const pixels: Array<readonly [number, number, number]> = Array.from({ length: 25 }, () => skin)
    pixels[12] = black
    pixels[6] = black
    const source = image(5, 5, pixels)
    const request = fixedRequest(source, {
      maxColors: 2,
      optimization: { minRegionSize: 1, stripePenalty: 0, aliasPenalty: 0, paletteCoherence: 0 },
    })
    request.palette = {
      id: 'face',
      name: 'Face',
      colors: [
        { id: 'black', name: 'Black', hex: '#000000', rgb: black },
        { id: 'skin', name: 'Skin', hex: '#f0bea0', rgb: skin },
      ],
    }
    request.analysis = {
      confidence: 1,
      landmarks: [{
        id: 'eye',
        kind: 'eye',
        x: 2,
        y: 2,
        confidence: 1,
        priority: 'hard',
        gridRadiusCells: 1,
      }],
    }

    const result = await algorithm.generate(request)

    assert.ok(candidate(result).metrics.featurePurity < 0.3)
    assert.ok(candidate(result).metrics.featureConnectivity < 1)
    assert.ok(candidate(result).metrics.featureExpressibility < 0.65)
  })

  it('creates stable candidate ids from the full candidate identity', async () => {
    const source = image(1, 1, [[255, 0, 0]])
    const first = await createPatternAlgorithm({ version: 'first' }).generate(fixedRequest(source))
    const second = await createPatternAlgorithm({ version: 'second' }).generate(fixedRequest(source))

    assert.notEqual(success(first).recommended.id, success(second).recommended.id)
  })

  it('separates generation and variant identities across source, palette, and candidates', async () => {
    const algorithm = createPatternAlgorithm({ version: 'identity-test' })
    const redSource = image(2, 1, [[255, 0, 0], [255, 0, 0]])
    const blueSource = image(2, 1, [[0, 0, 255], [0, 0, 255]])
    const request = fixedRequest(redSource, {
      canvas: { mode: 'auto', candidates: [{ width: 2, height: 1 }, { width: 4, height: 2 }] },
      maxCandidates: 2,
    })
    const first = await algorithm.generate(request)
    const changedSource = await algorithm.generate({ ...request, image: blueSource })
    const changedPalette = await algorithm.generate({
      ...request,
      palette: {
        ...palette,
        colors: palette.colors.map((color) => color.id === 'red'
          ? { ...color, rgb: [254, 0, 0] as const }
          : color),
      },
    })

    assert.equal(first.status, 'success')
    assert.ok(first.recommended)
    assert.equal(first.alternatives.length, 1)
    assert.equal(first.recommended.generationId, first.alternatives[0]!.generationId)
    assert.notEqual(first.recommended.variantId, first.alternatives[0]!.variantId)
    assert.notEqual(first.generationId, changedSource.generationId)
    assert.notEqual(first.generationId, changedPalette.generationId)
    assert.match(first.generationId, /^[a-f0-9]{32}$/)
  })

  it('fingerprints numeric analysis arrays with a fixed big-endian encoding', async () => {
    assert.equal(
      await arrayFingerprint([1, -2.5, 0.125]),
      'f6f5cbe9bfa90aac3efc5c616c71be62771e3354aa52f009bf95f73b3dcab0fd',
    )
  })

  it('returns best-effort semantics when every candidate violates hard features', async () => {
    const source = image(2, 2, Array.from({ length: 4 }, () => [255, 0, 0] as const))
    const request = fixedRequest(source, { maxColors: 1 })
    request.palette = {
      id: 'red-only',
      name: 'Red only',
      colors: [{ id: 'red', name: 'Red', hex: '#ff0000', rgb: [255, 0, 0] }],
    }
    request.analysis = {
      landmarks: [{
        id: 'eye',
        kind: 'eye',
        x: 0,
        y: 0,
        confidence: 1,
        priority: 'hard',
      }],
    }

    const result = await createPatternAlgorithm().generate(request)

    assert.equal(result.status, 'best-effort')
    assert.equal(result.recommended, undefined)
    assert.equal(result.pattern, undefined)
    assert.ok(result.bestEffort)
    assert.equal(result.bestEffort.valid, false)
    assert.equal(result.rejectedCandidates.length, 1)
  })

  it('evaluates body landmarks as geometry instead of high-contrast blobs', async () => {
    const source = image(3, 3, Array.from({ length: 9 }, () => [255, 0, 0] as const))
    const request = fixedRequest(source, { maxColors: 1 })
    request.analysis = {
      landmarks: [{
        id: 'shoulder',
        kind: 'body',
        x: 1,
        y: 1,
        confidence: 1,
        priority: 'hard',
      }],
    }

    const result = await createPatternAlgorithm().generate(request)

    assert.equal(result.status, 'success')
    assert.equal(result.recommended?.valid, true)
  })

  it('infers a feature carrier from the surrounding semantic region', async () => {
    const skin = [240, 190, 160] as const
    const black = [0, 0, 0] as const
    const pixels: Array<readonly [number, number, number]> = Array.from({ length: 9 }, () => skin)
    pixels[4] = black
    const source = image(3, 3, pixels)
    const request = fixedRequest(source, { maxColors: 2, optimization: { minRegionSize: 1 } })
    request.palette = {
      id: 'face',
      name: 'Face',
      colors: [
        { id: 'black', name: 'Black', hex: '#000000', rgb: black },
        { id: 'skin', name: 'Skin', hex: '#f0bea0', rgb: skin },
      ],
    }
    request.analysis = {
      semanticRegions: [
        {
          id: 'eye-region',
          label: 'eye',
          confidence: 1,
          mask: { width: 3, height: 3, values: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 0]) },
        },
        {
          id: 'face-region',
          label: 'face',
          confidence: 1,
          mask: { width: 3, height: 3, values: new Float32Array([1, 1, 1, 1, 0, 1, 1, 1, 1]) },
        },
      ],
      landmarks: [{
        id: 'eye',
        kind: 'eye',
        x: 1,
        y: 1,
        confidence: 1,
        priority: 'hard',
        featureRegionId: 'eye-region',
        carrierRegionId: 'face-region',
      }],
    }

    const result = await createPatternAlgorithm().generate(request)

    assert.equal(result.status, 'success')
    assert.ok((result.metrics?.featureLocalContrast ?? 0) > 0.2)
  })

  it('limits hard symmetry collisions to enforced group members', async () => {
    const skin = [240, 190, 160] as const
    const black = [0, 0, 0] as const
    const pixels: Array<readonly [number, number, number]> = Array.from({ length: 15 }, () => skin)
    pixels[6] = black
    pixels[8] = black
    const request = fixedRequest(image(5, 3, pixels), { maxColors: 2, optimization: { minRegionSize: 1 } })
    request.palette = {
      id: 'face',
      name: 'Face',
      colors: [
        { id: 'black', name: 'Black', hex: '#000000', rgb: black },
        { id: 'skin', name: 'Skin', hex: '#f0bea0', rgb: skin },
      ],
    }
    request.analysis = {
      landmarks: [
        { id: 'left-eye', kind: 'eye', x: 1, y: 1, confidence: 1, priority: 'hard', symmetryGroup: 'eyes' },
        { id: 'right-eye', kind: 'eye', x: 3, y: 1, confidence: 1, priority: 'hard', symmetryGroup: 'eyes' },
        { id: 'highlight', kind: 'custom', x: 1, y: 1, confidence: 0.2, priority: 'soft', symmetryGroup: 'eyes' },
      ],
    }

    const result = await createPatternAlgorithm().generate(request)

    assert.equal(result.status, 'success')
    assert.equal(result.recommended?.valid, true)
  })

  it('rejects invalid runtime enums, duplicate analysis ids, and malformed evidence metadata', async () => {
    const source = image(1, 1, [[255, 0, 0]])
    const algorithm = createPatternAlgorithm()

    await assert.rejects(() => algorithm.generate(fixedRequest(source, {
      baseline: 'future' as never,
    })), /baseline/)
    await assert.rejects(() => algorithm.generate(fixedRequest(source, {
      styles: ['neon' as never],
    })), /style/)
    await assert.rejects(() => algorithm.generate(fixedRequest(source, {
      resizeMethod: 'lanczos' as never,
    })), /resizeMethod/)
    await assert.rejects(() => algorithm.generate(fixedRequest(source, {
      colorDistanceMethod: 'rgb' as never,
    })), /colorDistanceMethod/)
    await assert.rejects(() => algorithm.generate(fixedRequest(source, {
      structure: { valueLevels: 5 as never },
    })), /valueLevels/)
    await assert.rejects(() => algorithm.generate(fixedRequest(source, {
      structure: { occupancyMode: 'outline' as never },
    })), /occupancyMode/)
    await assert.rejects(() => algorithm.generate(fixedRequest(source, {
      optimization: { refinementMode: 'maximum' as never },
    })), /refinementMode/)
    await assert.rejects(() => algorithm.generate(fixedRequest(source, {
      structure: { shapeRefinementIterations: 1.5 },
    })), /shapeRefinementIterations/)
    await assert.rejects(() => algorithm.generate(fixedRequest(source, {
      structure: { shapeRefinementIterations: 33 },
    })), /shapeRefinementIterations/)
    await assert.rejects(() => algorithm.generate(fixedRequest(source, {
      beadDiameterMm: Number.NaN,
    })), /beadDiameterMm/)

    const invalidOccupancyLandmark = fixedRequest(source)
    invalidOccupancyLandmark.analysis = {
      landmarks: [{
        id: 'ear',
        kind: 'ear',
        x: 0,
        y: 0,
        confidence: 1,
        priority: 'hard',
        affectsOccupancy: 'yes' as never,
      }],
    }
    await assert.rejects(
      () => algorithm.generate(invalidOccupancyLandmark),
      /affectsOccupancy/,
    )

    const duplicateIds = fixedRequest(source)
    duplicateIds.analysis = {
      semanticRegions: [
        { id: 'face', label: 'face', confidence: 1, mask: { width: 1, height: 1, values: new Float32Array([1]) } },
        { id: 'face', label: 'face-2', confidence: 1, mask: { width: 1, height: 1, values: new Float32Array([1]) } },
      ],
      landmarks: [
        { id: 'eye', kind: 'eye', x: 0, y: 0, confidence: 1, priority: 'hard' },
        { id: 'eye', kind: 'eye', x: 0, y: 0, confidence: 1, priority: 'hard' },
      ],
    }
    await assert.rejects(() => algorithm.generate(duplicateIds), /unique/)

    const invalidConfidence = fixedRequest(source)
    invalidConfidence.analysis = {
      semanticRegions: [{
        id: 'face',
        label: 'face',
        confidence: Number.NaN,
        importance: 2,
        mask: { width: 1, height: 1, values: new Float32Array([1]) },
      }],
    }
    await assert.rejects(() => algorithm.generate(invalidConfidence), /Semantic region/)

    const invalidProvenance = fixedRequest(source)
    invalidProvenance.analysis = {
      subjectMaskEvidence: {
        mask: { width: 1, height: 1, values: new Float32Array([1]) },
        confidence: 1,
        source: 'ai',
        revision: 'mask-1',
        provenance: [{ origin: 'model', provider: ' ' }],
      },
    }
    await assert.rejects(() => algorithm.generate(invalidProvenance), /provider/)

    const invalidRevision = fixedRequest(source)
    invalidRevision.analysis = {
      subjectMaskEvidence: {
        mask: { width: 1, height: 1, values: new Float32Array([1]) },
        confidence: 1,
        source: 'ai',
        revision: ' ',
      },
    }
    await assert.rejects(() => algorithm.generate(invalidRevision), /revision/)
  })

  it('requires confidence for automatic crop metadata', async () => {
    const source = image(2, 1, [[255, 0, 0], [0, 0, 255]])
    const request = fixedRequest(source)
    request.analysis = {
      suggestedCrop: { x: 0, y: 0, width: 1, height: 1 },
      suggestedCropSource: 'automatic',
    }

    await assert.rejects(() => createPatternAlgorithm().generate(request), /crop confidence/)
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

    assert.equal(success(result).pattern.cells[4]?.colorId, 'red')
    assert.ok(success(result).metrics.paletteOptimizationChanges >= 1)
  })
})
