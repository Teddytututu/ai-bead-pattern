import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fitCropToCanvas, gridCellForSourcePoint } from '../src/image.js'
import { buildSourceShapeModel, rasterizeSourceShape } from '../src/shape.js'
import type { BinaryMask, CropRect, ImageLandmark } from '../src/types.js'

const sourceSize = 256
const crop: CropRect = { x: 0, y: 0, width: sourceSize, height: sourceSize }

function cell(width: number, x: number, y: number): number {
  return y * width + x
}

function drawLine(
  values: Float32Array,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): void {
  let x = startX
  let y = startY
  const deltaX = Math.abs(endX - startX)
  const deltaY = -Math.abs(endY - startY)
  const stepX = startX < endX ? 1 : -1
  const stepY = startY < endY ? 1 : -1
  let error = deltaX + deltaY
  while (true) {
    values[y * sourceSize + x] = 1
    if (x === endX && y === endY) break
    const doubled = error * 2
    if (doubled >= deltaY) {
      error += deltaY
      x += stepX
    }
    if (doubled <= deltaX) {
      error += deltaX
      y += stepY
    }
  }
}

function transparentMask(draw: (values: Float32Array) => void): BinaryMask {
  const values = new Float32Array(sourceSize * sourceSize)
  draw(values)
  return { width: sourceSize, height: sourceSize, values }
}

function rasterize(subject: BinaryMask, targetSize: 32 | 48 | 64) {
  return rasterizeSourceShape(
    buildSourceShapeModel(subject, 1),
    crop,
    fitCropToCanvas(crop, targetSize, targetSize),
    targetSize,
    targetSize,
    [],
    { preserveThinStructures: true, refinementIterations: 4 },
  )
}

function endpointDirectionScore(
  activeMask: Uint8Array,
  width: number,
  endpoint: readonly [number, number],
  inwardDirection: readonly [number, number],
): number {
  const fit = fitCropToCanvas(crop, width, width)
  const [x, y] = gridCellForSourcePoint(crop, fit, endpoint[0], endpoint[1])
  const magnitude = Math.hypot(inwardDirection[0], inwardDirection[1])
  let score = -1
  for (const [offsetX, offsetY] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    const nextX = x + offsetX
    const nextY = y + offsetY
    if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= width) continue
    if (activeMask[nextY * width + nextX] !== 1) continue
    score = Math.max(score,
      (offsetX * inwardDirection[0] + offsetY * inwardDirection[1]) / magnitude)
  }
  return score
}

describe('transparent thin-structure rasterization', () => {
  for (const targetSize of [32, 48, 64] as const) {
    it(`keeps the principal path connected at ${targetSize}x${targetSize}`, () => {
      const subject = transparentMask((values) => {
        drawLine(values, 24, 216, 104, 72)
        drawLine(values, 104, 72, 152, 72)
        drawLine(values, 152, 72, 232, 216)
      })

      const raster = rasterize(subject, targetSize)
      const retainedAnchors = [...raster.boundaryAnchors]
        .filter((cell) => raster.activeMask[cell] === 1).length

      assert.equal(raster.diagnostics.targetComponents, 1)
      assert.ok(raster.boundaryAnchors.size >= 8)
      assert.ok(retainedAnchors / raster.boundaryAnchors.size >= 0.95)
      assert.ok(endpointDirectionScore(
        raster.activeMask,
        targetSize,
        [24, 216],
        [80, -144],
      ) > 0.5)
      assert.ok(endpointDirectionScore(
        raster.activeMask,
        targetSize,
        [232, 216],
        [-80, -144],
      ) > 0.5)
    })

    it(`keeps a closed hole and a detached component at ${targetSize}x${targetSize}`, () => {
      const subject = transparentMask((values) => {
        drawLine(values, 112, 24, 184, 96)
        drawLine(values, 184, 96, 112, 168)
        drawLine(values, 112, 168, 40, 96)
        drawLine(values, 40, 96, 112, 24)
        drawLine(values, 48, 216, 104, 216)
      })

      const raster = rasterize(subject, targetSize)

      assert.equal(raster.diagnostics.targetComponents, 2)
      assert.equal(raster.diagnostics.targetHoles, 1)
      assert.equal(raster.diagnostics.referenceComponents, 2)
      assert.equal(raster.diagnostics.referenceHoles, 1)
      assert.equal(raster.diagnostics.craftComponentsAfterBridging, 2)
      assert.ok(
        raster.diagnostics.craftComponentsBeforeBridging
          >= raster.diagnostics.craftComponentsAfterBridging,
      )
      assert.ok(raster.diagnostics.orthogonalBridgeCells >= 0)
      assert.ok(
        raster.diagnostics.orthogonalBridgeCells
          <= raster.diagnostics.craftComponentsBeforeBridging
            - raster.diagnostics.craftComponentsAfterBridging,
      )
      assert.ok(
        raster.diagnostics.fragileOrthogonalBridgeCells
          <= raster.diagnostics.orthogonalBridgeCells,
      )
      assert.ok(raster.diagnostics.shapeEdits >= raster.diagnostics.orthogonalBridgeCells)
    })
  }

  it('keeps bridge cells and adopted endpoints through profile accessory trimming', () => {
    const size = 7
    const values = new Float32Array(size * size)
    values[cell(size, 3, 3)] = 1
    values[cell(size, 4, 4)] = 1
    const subject: BinaryMask = { width: size, height: size, values }
    const landmarks: readonly ImageLandmark[] = [
      { id: 'eye', kind: 'eye', structuralRole: 'eye-center', x: 2, y: 3, confidence: 0.9, priority: 'soft', affectsOccupancy: false },
      { id: 'nose', kind: 'nose', structuralRole: 'nose-tip', x: 3, y: 3, confidence: 0.9, priority: 'soft', affectsOccupancy: false },
      { id: 'upper', kind: 'body', structuralRole: 'upper-jaw', x: 3, y: 3, confidence: 0.9, priority: 'soft', affectsOccupancy: false },
      { id: 'lower', kind: 'body', structuralRole: 'lower-jaw', x: 3, y: 3, confidence: 0.9, priority: 'soft', affectsOccupancy: false },
    ]
    const localCrop: CropRect = { x: 0, y: 0, width: size, height: size }
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(subject, 1, landmarks),
      localCrop,
      fitCropToCanvas(localCrop, size, size),
      size,
      size,
      landmarks,
      { preserveThinStructures: true, refinementIterations: 0 },
    )

    const bridge = cell(size, 4, 3)
    const endpoint = cell(size, 4, 4)
    assert.equal(raster.activeMask[bridge], 1)
    assert.equal(raster.activeMask[endpoint], 1)
    assert.ok(raster.protectedCells.has(bridge))
    assert.ok(raster.protectedCells.has(endpoint))
    assert.equal(raster.diagnostics.orthogonalBridgeCells, 1)
    assert.equal(raster.diagnostics.craftComponentsAfterBridging, 1)
  })

  it('recomputes bridge articulation after a hard landmark adds alternate support', () => {
    const size = 7
    const values = new Float32Array(size * size)
    values[cell(size, 3, 3)] = 1
    values[cell(size, 4, 4)] = 1
    const subject: BinaryMask = { width: size, height: size, values }
    const landmarks: readonly ImageLandmark[] = [{
      id: 'support',
      kind: 'body',
      x: 3,
      y: 4,
      confidence: 1,
      priority: 'hard',
      affectsOccupancy: true,
    }]
    const localCrop: CropRect = { x: 0, y: 0, width: size, height: size }
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(subject, 1, landmarks),
      localCrop,
      fitCropToCanvas(localCrop, size, size),
      size,
      size,
      landmarks,
      { preserveThinStructures: true, refinementIterations: 0 },
    )

    assert.equal(raster.activeMask[cell(size, 3, 3)], 1)
    assert.equal(raster.activeMask[cell(size, 4, 3)], 1)
    assert.equal(raster.activeMask[cell(size, 3, 4)], 1)
    assert.equal(raster.activeMask[cell(size, 4, 4)], 1)
    assert.equal(raster.diagnostics.orthogonalBridgeCells, 1)
    assert.equal(raster.diagnostics.fragileOrthogonalBridgeCells, 0)
  })

  it('publishes bridge reuse, rejection, topology, hole, and owner diagnostics', () => {
    const size = 7
    const values = new Float32Array(size * size)
    values[cell(size, 3, 3)] = 1
    values[cell(size, 4, 4)] = 1
    const subject: BinaryMask = { width: size, height: size, values }
    const localCrop: CropRect = { x: 0, y: 0, width: size, height: size }
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(subject, 1),
      localCrop,
      fitCropToCanvas(localCrop, size, size),
      size,
      size,
      [],
      { preserveThinStructures: true, refinementIterations: 0 },
    )

    assert.equal(raster.diagnostics.rejectedOrthogonalLinks, 0)
    assert.equal(raster.diagnostics.orthogonalBridgeReuseCount, 0)
    assert.equal(raster.diagnostics.orthogonalBridgeSimplePointRejections, 0)
    assert.equal(raster.diagnostics.orthogonalBridgeTopologyRejections, 0)
    assert.equal(raster.diagnostics.orthogonalBridgeHoleRejections, 0)
    assert.equal(raster.diagnostics.orthogonalBridgeOwnerRejections, 0)
    assert.equal(raster.diagnostics.craftHolesBeforeBridging, 0)
    assert.equal(raster.diagnostics.craftHolesAfterBridging, 0)
  })
})
