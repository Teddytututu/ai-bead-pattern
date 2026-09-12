import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createPatternAlgorithm,
  type PatternGenerationRequest,
  type PatternGenerationResult,
  type PixelImage,
} from '../src/index.js'
import { resolveShapeRefinementIterations, yieldToRuntime } from '../src/pipeline.js'

function sourceImage(width = 8, height = 8): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      data[offset] = x < width / 2 ? 230 : 30
      data[offset + 1] = y < height / 2 ? 80 : 180
      data[offset + 2] = 120
      data[offset + 3] = 255
    }
  }
  return { width, height, data }
}

const palette = {
  id: 'runtime-test',
  name: 'Runtime test',
  colors: [
    { id: 'dark', name: 'Dark', hex: '#1e7850', rgb: [30, 120, 80] as const },
    { id: 'light', name: 'Light', hex: '#e65078', rgb: [230, 80, 120] as const },
    { id: 'mid', name: 'Mid', hex: '#b4b478', rgb: [180, 180, 120] as const },
  ],
}

function request(styles: PatternGenerationRequest['options']['styles']): PatternGenerationRequest {
  return {
    image: sourceImage(),
    palette,
    options: {
      canvas: { mode: 'auto', candidates: [{ width: 6, height: 6 }, { width: 8, height: 8 }] },
      maxColors: 3,
      ...(styles === undefined ? {} : { styles }),
      maxCandidates: 8,
    },
  }
}

function candidates(result: PatternGenerationResult) {
  return [
    ...(result.recommended === undefined ? [] : [result.recommended]),
    ...(result.alternatives ?? []),
    ...(result.bestEffort === undefined ? [] : [result.bestEffort]),
  ]
}

describe('pipeline runtime contracts', () => {
  it('preserves explicit high-resolution refinement budgets', () => {
    assert.equal(resolveShapeRefinementIterations(513 * 513, 2, 0), 0)
    assert.equal(resolveShapeRefinementIterations(513 * 513, 2, 3), 3)
    assert.equal(resolveShapeRefinementIterations(513 * 513, 2, undefined), 1)
  })

  it('yields when setImmediate is unavailable', async () => {
    const runtime = globalThis as typeof globalThis & { setImmediate?: unknown }
    const original = runtime.setImmediate
    delete runtime.setImmediate
    try {
      await yieldToRuntime()
      const result = await createPatternAlgorithm({ clock: () => 1 }).generate(request(['faithful']))
      assert.ok(result.status === 'success' || result.status === 'best-effort')
    } finally {
      if (original === undefined) delete runtime.setImmediate
      else runtime.setImmediate = original
    }
  })

  it('keeps each style result stable when style order changes', async () => {
    const algorithm = createPatternAlgorithm({ clock: () => 1 })
    const forward = await algorithm.generate(request(['faithful', 'simple']))
    const reverse = await algorithm.generate(request(['simple', 'faithful']))
    assert.equal(forward.generationId, reverse.generationId)
    const signature = (result: PatternGenerationResult) => Object.fromEntries(
      candidates(result).map((candidate) => [
        candidate.style,
        candidate.pattern.cells.map((cell) => `${cell.x},${cell.y}:${cell.colorId}`).join('|'),
      ]),
    )
    assert.deepEqual(signature(forward), signature(reverse))
  })

  it('marks metadata from model evidence rather than an option flag', async () => {
    const result = await createPatternAlgorithm({ clock: () => 1 }).generate({
      ...request(['faithful']),
      analysis: {
        provenance: [{ origin: 'model', provider: 'test-vision', model: 'mask-v1', version: '1' }],
      },
    })
    const generated = result.recommended ?? result.bestEffort
    assert.ok(generated)
    assert.equal(generated.pattern.metadata.aiEnhanced, true)
    assert.equal(generated.pattern.metadata.aiProvider, 'test-vision')
    assert.equal(generated.pattern.metadata.aiModel, 'mask-v1')
  })
})
