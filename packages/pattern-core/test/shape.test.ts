import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildSourceShapeModel,
  rasterizeSourceShape,
} from '../src/shape.js'
import type { BinaryMask, CropRect, ImageLandmark } from '../src/types.js'
import { fitCropToCanvas } from '../src/image.js'

function mask(width: number, height: number, values: ArrayLike<number>): BinaryMask {
  return { width, height, values: Float32Array.from(values) }
}

const fullCrop = (width: number, height: number): CropRect => ({ x: 0, y: 0, width, height })

describe('source shape planning', () => {
  it('rasterizes subject occupancy instead of the fitted rectangle', () => {
    const subject = mask(5, 5, [
      0, 0, 0, 0, 0,
      0, 1, 1, 1, 0,
      0, 1, 1, 1, 0,
      0, 1, 1, 1, 0,
      0, 0, 0, 0, 0,
    ])
    const model = buildSourceShapeModel(subject, 1)
    const raster = rasterizeSourceShape(
      model,
      fullCrop(5, 5),
      fitCropToCanvas(fullCrop(5, 5), 5, 5),
      5,
      5,
      [],
    )

    assert.equal(raster.activeMask.reduce((sum, value) => sum + value, 0), 9)
    assert.equal(raster.activeMask[0], 0)
    assert.equal(raster.activeMask[12], 1)
    assert.equal(raster.diagnostics.referenceComponents, 1)
    assert.equal(raster.diagnostics.targetComponents, 1)
  })

  it('uses fractional source coverage when reducing the mask', () => {
    const subject = mask(4, 4, [
      1, 1, 0, 0,
      1, 1, 0, 0,
      1, 1, 0, 0,
      1, 1, 0, 0,
    ])
    const crop = fullCrop(4, 4)
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(subject, 1),
      crop,
      fitCropToCanvas(crop, 2, 2),
      2,
      2,
      [],
    )

    assert.deepEqual([...raster.coverage], [1, 0, 1, 0])
    assert.deepEqual([...raster.activeMask], [1, 0, 1, 0])
  })

  it('uses traced contours as sparse boundary anchors during rasterization', () => {
    const subject = mask(8, 8, Array.from({ length: 64 }, (_, index) => {
      const x = index % 8
      const y = Math.floor(index / 8)
      return x >= 2 && x <= 5 && y >= 2 && y <= 5 ? 1 : 0
    }))
    const crop = fullCrop(8, 8)
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(subject, 1),
      crop,
      fitCropToCanvas(crop, 8, 8),
      8,
      8,
      [],
    )

    assert.ok(raster.boundaryAnchors.size >= 4)
    assert.equal([...raster.boundaryAnchors].every((cell) => raster.activeMask[cell] === 1), true)
  })

  it('preserves a connected one-pixel outline when thin-structure protection is enabled', () => {
    const size = 128
    const values = new Float32Array(size * size)
    for (let x = 16; x <= 111; x += 1) {
      values[16 * size + x] = 1
      values[111 * size + x] = 1
    }
    for (let y = 16; y <= 111; y += 1) {
      values[y * size + 16] = 1
      values[y * size + 111] = 1
    }
    const crop = fullCrop(size, size)
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(mask(size, size, values), 1),
      crop,
      fitCropToCanvas(crop, 32, 32),
      32,
      32,
      [],
      { preserveThinStructures: true },
    )

    const occupied = raster.activeMask.reduce((sum, value) => sum + value, 0)
    assert.ok(occupied >= 80, `Expected a preserved outline, received ${occupied} cells`)
    assert.equal(raster.diagnostics.targetComponents, 1)
  })

  it('preserves a deliberate hole and separate source components', () => {
    const ring = mask(7, 5, [
      1, 1, 1, 0, 1, 1, 0,
      1, 0, 1, 0, 1, 1, 0,
      1, 1, 1, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0,
    ])
    const crop = fullCrop(7, 5)
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(ring, 1),
      crop,
      fitCropToCanvas(crop, 7, 5),
      7,
      5,
      [],
    )

    assert.equal(raster.activeMask[8], 0)
    assert.equal(raster.diagnostics.referenceComponents, 2)
    assert.equal(raster.diagnostics.targetComponents, 2)
    assert.equal(raster.diagnostics.referenceHoles, 1)
    assert.equal(raster.diagnostics.targetHoles, 1)
  })

  it('evaluates topology within the selected crop', () => {
    const subject = mask(8, 4, [
      1, 1, 0, 0, 0, 0, 1, 1,
      1, 1, 0, 0, 0, 0, 1, 1,
      1, 1, 0, 0, 0, 0, 1, 1,
      1, 1, 0, 0, 0, 0, 1, 1,
    ])
    const crop = { x: 0, y: 0, width: 4, height: 4 }
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(subject, 1),
      crop,
      fitCropToCanvas(crop, 4, 4),
      4,
      4,
      [],
    )

    assert.equal(raster.diagnostics.referenceComponents, 1)
    assert.equal(raster.diagnostics.targetComponents, 1)
  })

  it('allocates a target cell to a confident hard anchor', () => {
    const subject = mask(4, 4, [
      0, 0, 0, 0,
      0, 1, 1, 0,
      0, 1, 1, 0,
      0, 0.35, 0, 0,
    ])
    const landmarks: readonly ImageLandmark[] = [{
      id: 'ear-tip',
      kind: 'ear',
      x: 1,
      y: 3,
      confidence: 1,
      priority: 'hard',
      gridRadiusCells: 0,
      affectsOccupancy: true,
    }]
    const crop = fullCrop(4, 4)
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(subject, 1),
      crop,
      fitCropToCanvas(crop, 4, 4),
      4,
      4,
      landmarks,
    )

    assert.equal(raster.activeMask[13], 1)
    assert.deepEqual(raster.protectedCells, new Set([13]))
    assert.equal(raster.landmarkAllocations[0]?.allocatedCells.length, 1)
  })

  it('keeps internal hard features out of the subject silhouette', () => {
    const subject = mask(4, 4, [
      0, 0, 0, 0,
      0, 1, 1, 0,
      0, 1, 1, 0,
      0, 0, 0, 0,
    ])
    const landmarks: readonly ImageLandmark[] = [{
      id: 'eye',
      kind: 'eye',
      x: 0,
      y: 0,
      confidence: 1,
      priority: 'hard',
      gridRadiusCells: 0,
    }]
    const crop = fullCrop(4, 4)
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(subject, 1, landmarks),
      crop,
      fitCropToCanvas(crop, 4, 4),
      4,
      4,
      landmarks,
    )

    assert.equal(raster.activeMask[0], 0)
    assert.equal(raster.landmarkAllocations.length, 0)
    assert.equal(raster.protectedCells.size, 0)
  })

  it('projects the source SDF into target-cell units', () => {
    const subject = mask(8, 8, Array.from({ length: 64 }, (_, index) => {
      const x = index % 8
      const y = Math.floor(index / 8)
      return x >= 2 && x < 6 && y >= 2 && y < 6 ? 1 : 0
    }))
    const crop = fullCrop(8, 8)
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(subject, 1),
      crop,
      fitCropToCanvas(crop, 4, 4),
      4,
      4,
      [],
    )

    assert.ok(Math.abs(raster.signedDistance[5]!) < 1)
    assert.ok(Number.isFinite(raster.diagnostics.energyBefore))
    assert.ok(raster.diagnostics.energyAfter <= raster.diagnostics.energyBefore + 1e-9)
  })

  it('reports overlap against the projected source coverage', () => {
    const subject = mask(4, 4, [
      1, 1, 0, 0,
      1, 1, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ])
    const crop = fullCrop(4, 4)
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(subject, 1),
      crop,
      fitCropToCanvas(crop, 2, 2),
      2,
      2,
      [],
    )

    assert.equal(raster.diagnostics.coverageIoU, 1)
  })

  it('measures the subject boundary without credit from the canvas frame', () => {
    const values = new Float32Array(100)
    values[44] = 1
    values[45] = 1
    values[54] = 1
    values[55] = 1
    const subject = mask(10, 10, values)
    const crop = fullCrop(10, 10)
    const landmarks: readonly ImageLandmark[] = [{
      id: 'detached-anchor',
      kind: 'identity-mark',
      x: 0,
      y: 0,
      confidence: 1,
      priority: 'hard',
      gridRadiusCells: 0,
      affectsOccupancy: true,
    }]
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(subject, 1, landmarks),
      crop,
      fitCropToCanvas(crop, 10, 10),
      10,
      10,
      landmarks,
    )

    assert.ok(raster.diagnostics.boundaryIoU < 0.9)
  })

  it('builds a 512 square contour model within the interactive budget', () => {
    const size = 512
    const values = new Float32Array(size * size)
    for (let y = 48; y < size - 48; y += 1) {
      for (let x = 48; x < size - 48; x += 1) {
        if ((x + y) % 13 !== 0) values[y * size + x] = 1
      }
    }
    const startedAt = performance.now()
    const model = buildSourceShapeModel({ width: size, height: size, values }, 1)
    const elapsedMs = performance.now() - startedAt

    assert.ok(model.contours.length > 0)
    assert.ok(elapsedMs < 5_000, `Shape model took ${elapsedMs.toFixed(0)} ms`)
  })
})
