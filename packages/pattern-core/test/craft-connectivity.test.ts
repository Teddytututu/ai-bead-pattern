import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  bridgeOrthogonalLinks,
  type OrthogonalConnectivityLink,
} from '../src/craft-connectivity.js'

function cell(width: number, x: number, y: number): number {
  return y * width + x
}

function rotateCellClockwise(size: number, index: number): number {
  const x = index % size
  const y = Math.floor(index / size)
  return cell(size, size - 1 - y, x)
}

function rotateCellTimes(size: number, index: number, turns: number): number {
  let rotated = index
  for (let turn = 0; turn < turns; turn += 1) {
    rotated = rotateCellClockwise(size, rotated)
  }
  return rotated
}

function mirrorCellHorizontally(size: number, index: number): number {
  const x = index % size
  const y = Math.floor(index / size)
  return cell(size, size - 1 - x, y)
}

function complexDiagonalFixture(
  transform: (index: number) => number = (index) => index,
): {
  mask: Uint8Array
  links: readonly OrthogonalConnectivityLink[]
} {
  const size = 8
  const points = [
    [2, 2], [1, 3], [3, 1], [3, 3], [4, 4], [2, 4],
    [1, 1], [5, 5], [1, 5], [3, 5], [6, 6], [4, 6],
  ] as const
  const pairs = [
    [0, 1], [0, 2], [0, 3], [3, 4], [3, 5], [0, 6],
    [4, 7], [5, 8], [5, 9], [7, 10], [9, 11],
  ] as const
  const transformed = points.map(([x, y]) => transform(cell(size, x, y)))
  const mask = new Uint8Array(size * size)
  for (const point of transformed) mask[point] = 1
  return {
    mask,
    links: pairs.map(([start, end]) => ({
      start: transformed[start]!,
      end: transformed[end]!,
      componentId: 0,
    })),
  }
}

function diagonalFixture(size: 32 | 48 | 64): {
  mask: Uint8Array
  links: readonly OrthogonalConnectivityLink[]
  points: readonly number[]
} {
  const mask = new Uint8Array(size * size)
  const margin = Math.floor(size / 4)
  const length = Math.floor(size / 3)
  const points = Array.from({ length }, (_, offset) => cell(size, margin + offset, margin + offset))
  for (const point of points) mask[point] = 1
  return {
    mask,
    points,
    links: points.slice(1).map((end, index) => ({
      start: points[index]!,
      end,
      componentId: 0,
    })),
  }
}

function diamondFixture(size: number): {
  mask: Uint8Array
  links: readonly OrthogonalConnectivityLink[]
} {
  const mask = new Uint8Array(size * size)
  const center = Math.floor(size / 2)
  const radius = Math.max(4, Math.floor(size / 4))
  const points: number[] = []
  const appendSide = (
    start: readonly [number, number],
    end: readonly [number, number],
  ): void => {
    const steps = Math.max(Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1]))
    for (let step = 0; step < steps; step += 1) {
      const amount = step / steps
      const x = Math.round(start[0] + (end[0] - start[0]) * amount)
      const y = Math.round(start[1] + (end[1] - start[1]) * amount)
      const index = cell(size, x, y)
      if (points.at(-1) !== index) points.push(index)
    }
  }
  const top = [center, center - radius] as const
  const right = [center + radius, center] as const
  const bottom = [center, center + radius] as const
  const left = [center - radius, center] as const
  appendSide(top, right)
  appendSide(right, bottom)
  appendSide(bottom, left)
  appendSide(left, top)
  for (const point of points) mask[point] = 1
  const links = points.map((start, index) => ({
    start,
    end: points[(index + 1) % points.length]!,
    componentId: 0,
  }))
  return { mask, links }
}

describe('orthogonal craft connectivity', () => {
  for (const size of [32, 48, 64] as const) {
    it(`adds the minimum bridge beans for an open diagonal path at ${size}x${size}`, () => {
      const fixture = diagonalFixture(size)
      const result = bridgeOrthogonalLinks({
        width: size,
        height: size,
        values: fixture.mask,
        links: fixture.links,
      })

      assert.equal(result.fourConnectedComponentsBefore, fixture.points.length)
      assert.equal(result.eightConnectedComponentsBefore, 1)
      assert.equal(result.fourConnectedComponentsAfter, 1)
      assert.equal(
        result.eightConnectedComponentsAfter,
        result.eightConnectedComponentsBefore,
      )
      assert.equal(result.addedCells.length, fixture.points.length - 1)
      assert.equal(result.fragileBridgeCells.length, result.addedCells.length)
    })
  }

  it('keeps an H4 hole while joining a diagonal diamond into one craft component', () => {
    const fixture = diamondFixture(32)
    const result = bridgeOrthogonalLinks({
      width: 32,
      height: 32,
      values: fixture.mask,
      links: fixture.links,
      holeReference: fixture.mask,
    })

    assert.equal(result.eightConnectedComponentsBefore, 1)
    assert.equal(result.eightConnectedComponentsAfter, 1)
    assert.equal(result.fourConnectedComponentsAfter, 1)
    assert.equal(result.holesBefore, 1)
    assert.equal(result.holesAfter, 1)
    assert.ok(
      result.addedCells.length
        <= result.fourConnectedComponentsBefore - result.eightConnectedComponentsBefore,
    )
    assert.ok(result.fragileBridgeCells.length > 0)
    assert.ok(result.fragileBridgeCells.every((bridge) => result.addedCells.includes(bridge)))
  })

  it('leaves an already orthogonally supported diagonal band unchanged', () => {
    const size = 16
    const values = new Uint8Array(size * size)
    for (let offset = 0; offset < 8; offset += 1) {
      values[cell(size, 3 + offset, 3 + offset)] = 1
      values[cell(size, 4 + offset, 3 + offset)] = 1
    }
    const result = bridgeOrthogonalLinks({
      width: size,
      height: size,
      values,
      links: [],
    })

    assert.equal(result.fourConnectedComponentsBefore, 1)
    assert.equal(result.fourConnectedComponentsAfter, 1)
    assert.deepEqual(result.addedCells, [])
    assert.deepEqual(result.fragileBridgeCells, [])
  })

  it('rejects a bridge that would merge separate C8 topology components', () => {
    const size = 8
    const values = new Uint8Array(size * size)
    const start = cell(size, 2, 3)
    const end = cell(size, 4, 3)
    values[start] = 1
    values[end] = 1
    const result = bridgeOrthogonalLinks({
      width: size,
      height: size,
      values,
      links: [{ start, end, componentId: 0 }],
    })

    assert.equal(result.eightConnectedComponentsBefore, 2)
    assert.equal(result.eightConnectedComponentsAfter, 2)
    assert.equal(result.fourConnectedComponentsAfter, 2)
    assert.deepEqual(result.addedCells, [])
    assert.equal(result.rejectedLinks, 1)
    assert.ok(result.simplePointRejections > 0)
  })

  it('reuses one center bridge bean across both orientations of a V shape', () => {
    const size = 9
    for (const apexY of [3, 5]) {
      const left = cell(size, 3, 4)
      const center = cell(size, 4, 4)
      const right = cell(size, 5, 4)
      const apex = cell(size, 4, apexY)
      const values = new Uint8Array(size * size)
      values[left] = 1
      values[right] = 1
      values[apex] = 1
      const result = bridgeOrthogonalLinks({
        width: size,
        height: size,
        values,
        links: [
          { start: left, end: apex, componentId: 0 },
          { start: apex, end: right, componentId: 0 },
        ],
      })

      assert.deepEqual(result.addedCells, [center])
      assert.equal(result.fourConnectedComponentsAfter, 1)
      assert.equal(result.bridgeReuseCount, 1)
    }
  })

  it('chooses the exterior corner when the other corner belongs to an H4 hole', () => {
    const size = 7
    const start = cell(size, 3, 2)
    const end = cell(size, 4, 3)
    const exteriorCorner = cell(size, 4, 2)
    const interiorHole = cell(size, 3, 3)
    const values = new Uint8Array(size * size)
    values[start] = 1
    values[end] = 1
    const holeReference = new Uint8Array(size * size)
    for (let y = 2; y <= 4; y += 1) {
      for (let x = 2; x <= 4; x += 1) {
        if (x === 2 || y === 2 || x === 4 || y === 4) holeReference[cell(size, x, y)] = 1
      }
    }
    const result = bridgeOrthogonalLinks({
      width: size,
      height: size,
      values,
      links: [{ start, end, componentId: 0 }],
      holeReference,
    })

    assert.deepEqual(result.addedCells, [exteriorCorner])
    assert.equal(result.mask[interiorHole], 0)
    assert.ok(result.holeRejections > 0)
  })

  it('chooses the free corner when the other corner has a different source owner', () => {
    const size = 7
    const start = cell(size, 2, 2)
    const end = cell(size, 3, 3)
    const blockedCorner = cell(size, 3, 2)
    const freeCorner = cell(size, 2, 3)
    const otherComponent = cell(size, 4, 2)
    const values = new Uint8Array(size * size)
    values[start] = 1
    values[end] = 1
    values[otherComponent] = 1
    const owners = new Int32Array(size * size)
    owners.fill(-1)
    owners[start] = 0
    owners[end] = 0
    owners[otherComponent] = 1
    const result = bridgeOrthogonalLinks({
      width: size,
      height: size,
      values,
      links: [{ start, end, componentId: 0 }],
      componentOwners: owners,
    })

    assert.deepEqual(result.addedCells, [freeCorner])
    assert.equal(result.mask[blockedCorner], 0)
    assert.equal(result.mask[otherComponent], 1)
    assert.ok(result.ownerRejections > 0)
  })

  it('keeps directed diagonal tie-breaking equivariant across quarter turns', () => {
    const size = 7
    const baseStart = cell(size, 2, 2)
    const baseEnd = cell(size, 3, 3)
    const baseBridge = cell(size, 3, 2)

    for (let turns = 0; turns < 4; turns += 1) {
      const start = rotateCellTimes(size, baseStart, turns)
      const end = rotateCellTimes(size, baseEnd, turns)
      const expectedBridge = rotateCellTimes(size, baseBridge, turns)
      const values = new Uint8Array(size * size)
      values[start] = 1
      values[end] = 1

      const result = bridgeOrthogonalLinks({
        width: size,
        height: size,
        values,
        links: [{ start, end, componentId: 0 }],
      })

      assert.deepEqual(result.addedCells, [expectedBridge])
      assert.deepEqual([...result.bridgeEndpointCells].sort((a, b) => a - b), [start, end].sort((a, b) => a - b))
    }
  })

  it('keeps a supported undirected diagonal stable across endpoint order and mirroring', () => {
    const size = 7
    const start = cell(size, 2, 2)
    const end = cell(size, 3, 3)
    const support = cell(size, 4, 2)
    const values = new Uint8Array(size * size)
    values[start] = 1
    values[end] = 1
    values[support] = 1
    const run = (linkStart: number, linkEnd: number) => bridgeOrthogonalLinks({
      width: size,
      height: size,
      values,
      links: [{ start: linkStart, end: linkEnd, componentId: 0 }],
    })

    const forward = run(start, end)
    const reverse = run(end, start)
    assert.deepEqual(reverse.addedCells, forward.addedCells)

    const mirroredValues = new Uint8Array(size * size)
    for (const point of [start, end, support]) mirroredValues[mirrorCellHorizontally(size, point)] = 1
    const mirrored = bridgeOrthogonalLinks({
      width: size,
      height: size,
      values: mirroredValues,
      links: [{
        start: mirrorCellHorizontally(size, start),
        end: mirrorCellHorizontally(size, end),
        componentId: 0,
      }],
    })
    assert.deepEqual(
      mirrored.addedCells,
      forward.addedCells.map((point) => mirrorCellHorizontally(size, point)).sort((a, b) => a - b),
    )
  })

  it('finds the same seven-cell optimum beyond twelve candidates across rotation and mirroring', () => {
    const size = 8
    const baseFixture = complexDiagonalFixture()
    const base = bridgeOrthogonalLinks({
      width: size,
      height: size,
      values: baseFixture.mask,
      links: baseFixture.links,
    })
    assert.equal(base.addedCells.length, 7)

    const transforms = [
      (point: number) => rotateCellTimes(size, point, 1),
      (point: number) => mirrorCellHorizontally(size, point),
    ]
    for (const transform of transforms) {
      const fixture = complexDiagonalFixture(transform)
      const result = bridgeOrthogonalLinks({
        width: size,
        height: size,
        values: fixture.mask,
        links: fixture.links,
      })
      assert.equal(result.addedCells.length, 7)
      assert.deepEqual(
        result.addedCells,
        base.addedCells.map(transform).sort((a, b) => a - b),
      )
      assert.equal(result.rejectedLinks, 0)
    }
  })

  it('rolls back a component bridge transaction when a later link hits an owner barrier', () => {
    const size = 6
    const first = cell(size, 1, 1)
    const middle = cell(size, 2, 2)
    const last = cell(size, 3, 3)
    const values = new Uint8Array(size * size)
    values[first] = 1
    values[middle] = 1
    values[last] = 1
    const owners = new Float64Array(size * size)
    owners.fill(-1)
    owners[first] = 0
    owners[middle] = 0
    owners[last] = 0
    owners[cell(size, 3, 2)] = 1
    owners[cell(size, 2, 3)] = 1

    const result = bridgeOrthogonalLinks({
      width: size,
      height: size,
      values,
      links: [
        { start: first, end: middle, componentId: 0 },
        { start: middle, end: last, componentId: 0 },
      ],
      componentOwners: owners,
    })

    assert.deepEqual(result.addedCells, [])
    assert.deepEqual(result.bridgeEndpointCells, [])
    assert.equal(result.fourConnectedComponentsAfter, 3)
    assert.ok(result.ownerRejections > 0)
    assert.ok(result.rejectedLinks > 0)
  })

  it('finds the minimum shared bridge set for a bounded local component', () => {
    const size = 4
    const active = [0, 2, 5, 7, 8]
    const values = new Uint8Array(size * size)
    for (const index of active) values[index] = 1

    const result = bridgeOrthogonalLinks({
      width: size,
      height: size,
      values,
      links: [
        { start: 0, end: 5, componentId: 0 },
        { start: 2, end: 7, componentId: 0 },
        { start: 2, end: 5, componentId: 0 },
        { start: 5, end: 8, componentId: 0 },
      ],
    })

    assert.deepEqual(result.addedCells, [4, 6])
    assert.equal(result.fourConnectedComponentsAfter, 1)
    assert.equal(result.rejectedLinks, 0)
  })

  for (const invalidOwner of [1.5, Number.NaN, -2]) {
    it(`rejects invalid component owner ${String(invalidOwner)}`, () => {
      const owners = new Float64Array(4)
      owners.fill(-1)
      owners[0] = invalidOwner

      assert.throws(() => bridgeOrthogonalLinks({
        width: 2,
        height: 2,
        values: new Uint8Array([1, 0, 0, 1]),
        links: [{ start: 0, end: 3, componentId: 0 }],
        componentOwners: owners,
      }), /owners must contain -1 or non-negative integers/)
    })
  }
})
