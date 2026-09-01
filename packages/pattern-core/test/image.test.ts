import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildSourceGuidance } from '../src/structure.js'
import { resizePixels } from '../src/image.js'
import type { PixelImage } from '../src/types.js'

function edgeImage(): PixelImage {
  const width = 8
  const height = 1
  const data = new Uint8ClampedArray(width * height * 4)
  for (let x = 0; x < width; x += 1) {
    const value = x < 3 ? 0 : 255
    const offset = x * 4
    data[offset] = value
    data[offset + 1] = value
    data[offset + 2] = value
    data[offset + 3] = 255
  }
  return { width, height, data }
}

function luminance(pixel: readonly [number, number, number]): number {
  return pixel[0] * 0.2126 + pixel[1] * 0.7152 + pixel[2] * 0.0722
}

describe('cell-aware image sampling', () => {
  it('keeps a high-contrast boundary from being averaged into a muddy cell', () => {
    const image = edgeImage()
    const crop = { x: 0, y: 0, width: image.width, height: image.height }
    const guidance = buildSourceGuidance(image, undefined)
    const area = resizePixels(image, crop, 2, 1, 'area')
    const cellAware = resizePixels(image, crop, 2, 1, 'cell-aware', [255, 255, 255], {
      source: guidance,
      importanceStrength: 1,
      edgeStrength: 2,
      preserveThinStructures: true,
    })

    assert.ok(luminance(cellAware.pixels[0]!) < luminance(area.pixels[0]!) - 20)
    assert.ok(luminance(cellAware.pixels[1]!) > luminance(area.pixels[1]!) - 4)
  })
})
