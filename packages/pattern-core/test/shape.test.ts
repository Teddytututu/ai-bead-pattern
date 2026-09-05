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

function gridLineCells(
  width: number,
  start: readonly [number, number],
  end: readonly [number, number],
): readonly number[] {
  const steps = Math.max(Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1]))
  return Array.from({ length: steps + 1 }, (_, step) => {
    const amount = steps === 0 ? 0 : step / steps
    const x = Math.round(start[0] + (end[0] - start[0]) * amount)
    const y = Math.round(start[1] + (end[1] - start[1]) * amount)
    return y * width + x
  })
}

function hasFourConnectedPath(
  values: Uint8Array,
  width: number,
  start: number,
  end: number,
): boolean {
  if (values[start] !== 1 || values[end] !== 1) return false
  const visited = new Set<number>([start])
  const queue = [start]
  while (queue.length > 0) {
    const cell = queue.shift()!
    if (cell === end) return true
    const x = cell % width
    const candidates = [cell - width, cell + width]
    if (x > 0) candidates.push(cell - 1)
    if (x + 1 < width) candidates.push(cell + 1)
    for (const next of candidates) {
      if (next < 0 || next >= values.length || values[next] !== 1 || visited.has(next)) continue
      visited.add(next)
      queue.push(next)
    }
  }
  return false
}

type ObservationState = 'observed' | 'inferred' | 'missing'

function withObservationState(
  landmark: ImageLandmark,
  observationState: ObservationState,
): ImageLandmark {
  return { ...landmark, observationState } as ImageLandmark
}

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

  it('allows an observed hard endpoint to allocate and protect an occupied cell', () => {
    const subject = mask(6, 6, Array.from({ length: 36 }, (_, index) => {
      const x = index % 6
      const y = Math.floor(index / 6)
      return x >= 2 && x <= 4 && y >= 1 && y <= 4 ? 1 : 0
    }))
    const landmark = withObservationState({
      id: 'observed-ear-tip',
      kind: 'ear',
      structuralRole: 'ear-tip',
      x: 1,
      y: 1,
      confidence: 0.95,
      priority: 'hard',
      gridRadiusCells: 0,
      affectsOccupancy: true,
    }, 'observed')
    const crop = fullCrop(6, 6)
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(subject, 1, [landmark]),
      crop,
      fitCropToCanvas(crop, 6, 6),
      6,
      6,
      [landmark],
      { refinementIterations: 0 },
    )
    const endpointCell = 1 * 6 + 1

    assert.equal(raster.activeMask[endpointCell], 1)
    assert.ok(raster.protectedCells.has(endpointCell))
    assert.deepEqual(raster.landmarkAllocations[0]?.allocatedCells, [endpointCell])
  })

  it('protects supported inferred chest, leg, and tail paths at 32, 48, and 64 cells', () => {
    for (const size of [32, 48, 64]) {
      const scale = size / 32
      const point = (x: number, y: number): readonly [number, number] => [
        Math.round(x * scale),
        Math.round(y * scale),
      ]
      const shoulder = point(19, 8)
      const chest = point(21, 13)
      const frontKnee = point(24, 20)
      const frontPaw = point(27, 28)
      const tailRoot = point(10, 10)
      const tailTip = point(2, 16)
      const values = new Float32Array(size * size)
      for (let y = Math.round(5 * scale); y <= Math.round(11 * scale); y += 1) {
        for (let x = Math.round(8 * scale); x <= Math.round(19 * scale); x += 1) {
          values[y * size + x] = 1
        }
      }
      const structuralSegments = [
        [shoulder, chest],
        [chest, frontKnee],
        [frontKnee, frontPaw],
        [tailRoot, tailTip],
      ] as const
      const structuralCells = structuralSegments.flatMap(([start, end]) =>
        gridLineCells(size, start, end))
      for (const cell of structuralCells) values[cell] = 1
      const legGap = gridLineCells(size, chest, frontKnee)
        .at(Math.floor(gridLineCells(size, chest, frontKnee).length / 2))!
      const tailGap = gridLineCells(size, tailRoot, tailTip)
        .at(Math.floor(gridLineCells(size, tailRoot, tailTip).length / 2))!
      values[legGap] = 0
      values[tailGap] = 0
      const landmark = (
        id: string,
        structuralRole: NonNullable<ImageLandmark['structuralRole']>,
        location: readonly [number, number],
      ): ImageLandmark => withObservationState({
        id,
        kind: 'body',
        structuralRole,
        x: location[0],
        y: location[1],
        confidence: 0.76,
        priority: 'soft',
        affectsOccupancy: true,
      }, 'inferred')
      const landmarks = [
        landmark('shoulder', 'shoulder', shoulder),
        landmark('chest', 'chest-center', chest),
        landmark('front-knee', 'front-knee', frontKnee),
        landmark('front-paw', 'front-paw', frontPaw),
        landmark('tail-root', 'tail-root', tailRoot),
        landmark('tail-tip', 'tail-tip', tailTip),
      ]
      const crop = fullCrop(size, size)
      const raster = rasterizeSourceShape(
        buildSourceShapeModel(mask(size, size, values), 1, landmarks),
        crop,
        fitCropToCanvas(crop, size, size),
        size,
        size,
        landmarks,
        { refinementIterations: 0 },
      )
      const roleCells = [shoulder, chest, frontKnee, frontPaw, tailRoot, tailTip]
        .map(([x, y]) => y * size + x)
      const protectedStructuralCells = structuralCells.filter((cell) => raster.protectedCells.has(cell))

      assert.ok(roleCells.every((cell) => raster.protectedCells.has(cell)), `${size} grid lost a protected joint`)
      assert.ok(hasFourConnectedPath(
        raster.activeMask,
        size,
        shoulder[1] * size + shoulder[0],
        frontPaw[1] * size + frontPaw[0],
      ), `${size} grid disconnected the front leg`)
      assert.ok(hasFourConnectedPath(
        raster.activeMask,
        size,
        tailRoot[1] * size + tailRoot[0],
        tailTip[1] * size + tailTip[0],
      ), `${size} grid disconnected the tail`)
      assert.ok(protectedStructuralCells.length >= structuralCells.length * 0.65, `${size} grid protected too little structure`)
      assert.equal(raster.landmarkAllocations.length, 0)
    }
  })

  it('keeps structural paths inside each prefixed pet instance', () => {
    const size = 32
    const values = new Float32Array(size * size)
    const instances = [
      { id: 'pet-01', x: 5, confidence: [0.9, 0.88, 0.76, 0.7] },
      { id: 'pet-02', x: 22, confidence: [0.7, 0.76, 0.88, 0.9] },
    ] as const
    const landmarks: ImageLandmark[] = []
    for (const instance of instances) {
      const points = [
        ['shoulder', instance.x, 6],
        ['chest-center', instance.x + 1, 10],
        ['front-knee', instance.x + 2, 15],
        ['front-paw', instance.x + 3, 22],
      ] as const
      for (let index = 0; index < points.length; index += 1) {
        const [role, x, y] = points[index]!
        landmarks.push(withObservationState({
          id: `${instance.id}:${role}`,
          kind: 'body',
          structuralRole: role,
          x,
          y,
          confidence: instance.confidence[index]!,
          priority: 'soft',
          affectsOccupancy: true,
        }, 'inferred'))
      }
      const cells = gridLineCells(size, [instance.x, 6], [instance.x + 1, 10])
        .concat(gridLineCells(size, [instance.x + 1, 10], [instance.x + 2, 15]))
        .concat(gridLineCells(size, [instance.x + 2, 15], [instance.x + 3, 22]))
      for (const cell of cells) values[cell] = 1
      values[gridLineCells(size, [instance.x + 1, 10], [instance.x + 2, 15])[2]!] = 0
    }
    const crop = fullCrop(size, size)
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(mask(size, size, values), 1, landmarks),
      crop,
      fitCropToCanvas(crop, size, size),
      size,
      size,
      landmarks,
      { refinementIterations: 0 },
    )

    for (const instance of instances) {
      assert.ok(hasFourConnectedPath(
        raster.activeMask,
        size,
        6 * size + instance.x,
        22 * size + instance.x + 3,
      ), `${instance.id} front leg lost continuity`)
    }
  })

  it('leaves weak inferred structural gaps outside protection', () => {
    const size = 32
    const shoulder = [19, 8] as const
    const chest = [21, 13] as const
    const frontKnee = [24, 20] as const
    const values = new Float32Array(size * size)
    const path = [
      ...gridLineCells(size, shoulder, chest),
      ...gridLineCells(size, chest, frontKnee),
    ]
    for (const cell of path) values[cell] = 1
    const gap = gridLineCells(size, chest, frontKnee)
      .at(Math.floor(gridLineCells(size, chest, frontKnee).length / 2))!
    values[gap] = 0
    const landmarks = [
      { id: 'shoulder', kind: 'body', structuralRole: 'shoulder', x: shoulder[0], y: shoulder[1] },
      { id: 'chest', kind: 'body', structuralRole: 'chest-center', x: chest[0], y: chest[1] },
      { id: 'front-knee', kind: 'body', structuralRole: 'front-knee', x: frontKnee[0], y: frontKnee[1] },
    ].map((entry) => withObservationState({
      ...entry,
      confidence: 0.42,
      priority: 'soft',
      affectsOccupancy: true,
    } as ImageLandmark, 'inferred'))
    const crop = fullCrop(size, size)
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(mask(size, size, values), 1, landmarks),
      crop,
      fitCropToCanvas(crop, size, size),
      size,
      size,
      landmarks,
      { refinementIterations: 0 },
    )

    assert.equal(raster.activeMask[gap], 0)
    assert.equal(raster.protectedCells.has(gap), false)
  })

  it('leaves high-confidence inferred paths inactive when the subject mask offers no support', () => {
    const size = 32
    const values = new Float32Array(size * size)
    for (let y = 4; y <= 9; y += 1) {
      for (let x = 4; x <= 10; x += 1) values[y * size + x] = 1
    }
    const landmarks = [
      { id: 'unsupported-shoulder', structuralRole: 'shoulder', x: 22, y: 16 },
      { id: 'unsupported-chest', structuralRole: 'chest-center', x: 24, y: 22 },
    ].map((entry) => withObservationState({
      ...entry,
      kind: 'body',
      confidence: 0.9,
      priority: 'soft',
      affectsOccupancy: true,
    } as ImageLandmark, 'inferred'))
    const crop = fullCrop(size, size)
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(mask(size, size, values), 1, landmarks),
      crop,
      fitCropToCanvas(crop, size, size),
      size,
      size,
      landmarks,
      { refinementIterations: 0 },
    )

    assert.equal(raster.activeMask[16 * size + 22], 0)
    assert.equal(raster.activeMask[22 * size + 24], 0)
    assert.equal(raster.protectedCells.has(16 * size + 22), false)
    assert.equal(raster.protectedCells.has(22 * size + 24), false)
  })

  it('removes a missing endpoint from occupancy allocation and protection', () => {
    const subject = mask(6, 6, Array.from({ length: 36 }, (_, index) => {
      const x = index % 6
      const y = Math.floor(index / 6)
      return x >= 2 && x <= 4 && y >= 1 && y <= 4 ? 1 : 0
    }))
    const landmark = withObservationState({
      id: 'missing-tail-tip',
      kind: 'body',
      structuralRole: 'tail-tip',
      x: 0,
      y: 5,
      confidence: 0.9,
      priority: 'hard',
      gridRadiusCells: 0,
      affectsOccupancy: true,
    }, 'missing')
    const crop = fullCrop(6, 6)
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(subject, 1, [landmark]),
      crop,
      fitCropToCanvas(crop, 6, 6),
      6,
      6,
      [landmark],
      { refinementIterations: 0 },
    )
    const endpointCell = 5 * 6

    assert.equal(raster.activeMask[endpointCell], 0)
    assert.equal(raster.protectedCells.has(endpointCell), false)
    assert.equal(raster.landmarkAllocations.length, 0)
  })

  it('connects and protects a hard ear-tip to ear-root structural path', () => {
    const subject = mask(16, 16, Array.from({ length: 16 * 16 }, (_, index) => {
      const x = index % 16
      const y = Math.floor(index / 16)
      if (x >= 5 && x <= 11 && y >= 6 && y <= 13) return 1
      if ((x === 9 && y === 2) || (x === 8 && y === 5)) return 1
      if (x === 9 && (y === 3 || y === 4)) return 0.2
      return 0
    }))
    const structuralRole = (value: string) => value as NonNullable<ImageLandmark['structuralRole']>
    const landmarks: readonly ImageLandmark[] = [
      {
        id: 'visible-ear-tip', kind: 'ear', structuralRole: structuralRole('ear-tip'),
        x: 9, y: 2, confidence: 1, priority: 'hard', affectsOccupancy: true,
      },
      {
        id: 'visible-ear-root', kind: 'body', structuralRole: structuralRole('ear-root'),
        x: 8, y: 5, confidence: 1, priority: 'hard', affectsOccupancy: true,
      },
    ]
    const crop = fullCrop(16, 16)
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(subject, 1, landmarks),
      crop,
      fitCropToCanvas(crop, 16, 16),
      16,
      16,
      landmarks,
      { refinementIterations: 4 },
    )
    const earCells = [2 * 16 + 9, 3 * 16 + 9, 4 * 16 + 8, 5 * 16 + 8]

    assert.ok(earCells.every((cell) => raster.activeMask[cell] === 1))
    assert.ok(earCells.every((cell) => raster.protectedCells.has(cell)))
  })

  it('trims nose-tip attachments at 32, 48, and 64 while thin structures stay protected', () => {
    for (const size of [32, 48, 64]) {
      const headLeft = Math.round(size * 0.25)
      const noseX = Math.round(size * 0.625)
      const headTop = Math.round(size * 0.19)
      const headBottom = Math.round(size * 0.69)
      const noseY = Math.round(size * 0.44)
      const upperJaw = { x: noseX - 2, y: noseY - 1 }
      const lowerJaw = { x: noseX - 2, y: noseY + 2 }
      const accessoryEnd = noseX + Math.max(4, Math.round(size * 0.12))
      const subject = mask(size, size, Array.from({ length: size * size }, (_, index) => {
        const x = index % size
        const y = Math.floor(index / size)
        if (x >= headLeft && x <= noseX && y >= headTop && y <= headBottom) return 1
        if (y === noseY && x > noseX && x <= accessoryEnd) return 1
        return 0
      }))
      const landmarks: readonly ImageLandmark[] = [
        withObservationState({
          id: 'visible-eye-center', kind: 'eye', structuralRole: 'eye-center',
          x: Math.round(size * 0.44), y: noseY - 2, confidence: 1, priority: 'hard',
        }, 'observed'),
        withObservationState({
          id: 'nose-tip', kind: 'nose', structuralRole: 'nose-tip',
          x: noseX, y: noseY, confidence: 1, priority: 'hard', affectsOccupancy: true,
        }, 'observed'),
        withObservationState({
          id: 'upper-jaw-end', kind: 'face-contour', structuralRole: 'upper-jaw',
          x: upperJaw.x, y: upperJaw.y, confidence: 1, priority: 'hard', affectsOccupancy: true,
        }, 'observed'),
        withObservationState({
          id: 'lower-jaw-end', kind: 'face-contour', structuralRole: 'lower-jaw',
          x: lowerJaw.x, y: lowerJaw.y, confidence: 1, priority: 'hard', affectsOccupancy: true,
        }, 'observed'),
      ]
      const crop = fullCrop(size, size)
      const raster = rasterizeSourceShape(
        buildSourceShapeModel(subject, 1, landmarks),
        crop,
        fitCropToCanvas(crop, size, size),
        size,
        size,
        landmarks,
        { refinementIterations: 2, preserveThinStructures: true },
      )
      const featureCells = [
        noseY * size + noseX,
        upperJaw.y * size + upperJaw.x,
        lowerJaw.y * size + lowerJaw.x,
      ]

      for (const cell of featureCells) {
        assert.equal(raster.activeMask[cell], 1, `${size} grid lost a protected muzzle cell ${cell}`)
        assert.ok(raster.protectedCells.has(cell), `${size} grid left a muzzle cell unprotected`)
      }
      for (let x = noseX + 1; x <= accessoryEnd; x += 1) {
        const cell = noseY * size + x
        assert.equal(raster.activeMask[cell], 0, `${size} grid retained nose-tip attachment at ${x},${noseY}`)
        assert.equal(raster.protectedCells.has(cell), false, `${size} grid protected a removed attachment at ${x},${noseY}`)
      }
    }
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
    assert.equal(raster.diagnostics.topologyClDice, 1)
    assert.equal(raster.diagnostics.topologyWeightedClDice, 1)
    assert.equal(raster.diagnostics.topologyEndpointF1, 1)
    assert.equal(raster.diagnostics.topologyJunctionF1, 1)
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

  it('charges topology loss when the first area sample drops a thin source tail', () => {
    const size = 16
    const values = new Float32Array(size * size)
    for (let y = 4; y <= 11; y += 1) {
      for (let x = 2; x <= 8; x += 1) values[y * size + x] = 1
    }
    for (let x = 9; x < size; x += 1) values[8 * size + x] = 1
    const subject = mask(size, size, values)
    const crop = fullCrop(size, size)
    const raster = rasterizeSourceShape(
      buildSourceShapeModel(subject, 1),
      crop,
      fitCropToCanvas(crop, 4, 4),
      4,
      4,
      [],
      { refinementIterations: 0, preserveThinStructures: false },
    )

    assert.ok(raster.diagnostics.topologyWeightedCenterlineRecall < 1)
    assert.ok(raster.diagnostics.topologyEndpointRecall < 1)
    assert.ok(raster.diagnostics.topologyScore < 1)
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
