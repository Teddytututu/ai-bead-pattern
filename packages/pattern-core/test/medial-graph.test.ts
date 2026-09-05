import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildMedialGraph,
  medialGraphSchema,
  type MedialGraph,
} from '../src/medial-graph.js'
import { buildSourceShapeModel } from '../src/shape.js'
import type { BinaryMask, ImageLandmark, StructuralRole } from '../src/types.js'

function binaryMask(
  width: number,
  height: number,
  active: (x: number, y: number) => boolean,
): BinaryMask {
  return {
    width,
    height,
    values: Float32Array.from({ length: width * height }, (_, index) =>
      active(index % width, Math.floor(index / width)) ? 1 : 0),
  }
}

function longestBranch(graph: MedialGraph) {
  const branch = [...graph.branches]
    .sort((first, second) => second.geodesicLength - first.geodesicLength)[0]
  assert.ok(branch)
  return branch
}

function branchForRole(graph: MedialGraph, role: StructuralRole) {
  const branch = graph.branches.find((candidate) =>
    candidate.endpointRoleHits.some((hit) => hit.role === role))
  assert.ok(branch)
  return branch
}

function taperedVerticalStructure(): { subject: BinaryMask; landmarks: readonly ImageLandmark[] } {
  return {
    subject: binaryMask(33, 33, (x, y) => {
      if (y < 3 || y > 27) return false
      const halfWidth = Math.min(4, Math.floor((y - 3) / 5))
      return Math.abs(x - 16) <= halfWidth
    }),
    landmarks: [
      {
        id: 'ear-tip', kind: 'ear', structuralRole: 'ear-tip',
        x: 16, y: 3, confidence: 1, priority: 'hard', affectsOccupancy: true,
        observationState: 'observed',
      },
      {
        id: 'ear-root', kind: 'body', structuralRole: 'ear-root',
        x: 16, y: 27, confidence: 1, priority: 'hard', affectsOccupancy: true,
        observationState: 'observed',
      },
    ],
  }
}

function taperedHorizontalStructure(mirrored = false): {
  subject: BinaryMask
  landmarks: readonly ImageLandmark[]
} {
  const sourceX = (x: number) => mirrored ? 32 - x : x
  return {
    subject: binaryMask(33, 33, (x, y) => {
      const axis = sourceX(x)
      if (axis < 3 || axis > 27) return false
      const halfWidth = Math.min(4, Math.floor((axis - 3) / 5))
      return Math.abs(y - 16) <= halfWidth
    }),
    landmarks: [
      {
        id: 'tail-tip', kind: 'body', structuralRole: 'tail-tip',
        x: mirrored ? 29 : 3, y: 16, confidence: 1, priority: 'hard', affectsOccupancy: true,
        observationState: 'observed',
      },
      {
        id: 'tail-root', kind: 'body', structuralRole: 'tail-root',
        x: mirrored ? 5 : 27, y: 16, confidence: 1, priority: 'hard', affectsOccupancy: true,
        observationState: 'observed',
      },
    ],
  }
}

const eightNeighborOffsets = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
] as const

function componentCount(
  values: Uint8Array,
  width: number,
  height: number,
  foreground: 0 | 1,
  offsets: readonly (readonly [number, number])[],
): number {
  const visited = new Uint8Array(values.length)
  let components = 0
  for (let start = 0; start < values.length; start += 1) {
    if (values[start] !== foreground || visited[start] === 1) continue
    components += 1
    visited[start] = 1
    const queue = [start]
    while (queue.length > 0) {
      const index = queue.pop()!
      const x = index % width
      const y = Math.floor(index / width)
      for (const [offsetX, offsetY] of offsets) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
        const next = nextY * width + nextX
        if (values[next] !== foreground || visited[next] === 1) continue
        visited[next] = 1
        queue.push(next)
      }
    }
  }
  return components
}

function holeCount(values: Uint8Array, width: number, height: number): number {
  const visited = new Uint8Array(values.length)
  let holes = 0
  for (let start = 0; start < values.length; start += 1) {
    if (values[start] === 1 || visited[start] === 1) continue
    let touchesBorder = false
    visited[start] = 1
    const queue = [start]
    while (queue.length > 0) {
      const index = queue.pop()!
      const x = index % width
      const y = Math.floor(index / width)
      touchesBorder ||= x === 0 || y === 0 || x === width - 1 || y === height - 1
      for (const [offsetX, offsetY] of eightNeighborOffsets) {
        const nextX = x + offsetX
        const nextY = y + offsetY
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
        const next = nextY * width + nextX
        if (values[next] === 1 || visited[next] === 1) continue
        visited[next] = 1
        queue.push(next)
      }
    }
    if (touchesBorder === false) holes += 1
  }
  return holes
}

function endpointCount(values: Uint8Array, width: number, height: number): number {
  let endpoints = 0
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === 0) continue
    const x = index % width
    const y = Math.floor(index / width)
    const neighbors = eightNeighborOffsets.reduce((count, [offsetX, offsetY]) => {
      const nextX = x + offsetX
      const nextY = y + offsetY
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) return count
      return count + Number(values[nextY * width + nextX] === 1)
    }, 0)
    if (neighbors === 1) endpoints += 1
  }
  return endpoints
}

describe('deterministic medial branch graph', () => {
  it('pins the source algorithms used by the deterministic implementation', () => {
    assert.equal(medialGraphSchema.id, 'sdf-medial-branch-v3-robust-diameter')
    assert.deepEqual(medialGraphSchema.sources, [
      'scikit-image/medial_axis@v0.26.0',
      'jni/skan@v0.13.1',
    ])
  })

  it('measures a four-pixel tail from its long medial branch', () => {
    const subject = binaryMask(32, 32, (x, y) => x >= 14 && x <= 17 && y >= 4 && y <= 27)
    const graph = buildMedialGraph(buildSourceShapeModel(subject, 1))
    const branch = longestBranch(graph)

    assert.ok(branch.geodesicLength >= 18)
    assert.ok(branch.straightLength >= 18)
    assert.ok(Math.abs(branch.medianLocalRadius - 2) < 1e-9)
    assert.ok(branch.minimumLocalRadius > 0)
    assert.ok(branch.minimumLocalRadius <= branch.medianLocalRadius)
    assert.ok(Math.abs(branch.robustMinimumDiameter - 4) < 1e-9)
  })

  it('keeps a hard tapered ear tip in robust diameter sampling', () => {
    const fixture = taperedVerticalStructure()
    const graph = buildMedialGraph(
      buildSourceShapeModel(fixture.subject, 1, fixture.landmarks),
      { landmarks: fixture.landmarks },
    )
    const branch = branchForRole(graph, 'ear-tip')

    assert.equal(branch.robustMinimumDiameter, 2)
    assert.ok(branch.robustMinimumDiameter < branch.medianLocalRadius * 2)
  })

  it('keeps a hard tapered tail tip in robust diameter sampling', () => {
    const fixture = taperedHorizontalStructure()
    const graph = buildMedialGraph(
      buildSourceShapeModel(fixture.subject, 1, fixture.landmarks),
      { landmarks: fixture.landmarks },
    )
    const branch = branchForRole(graph, 'tail-tip')

    assert.equal(branch.robustMinimumDiameter, 2)
    assert.ok(branch.robustMinimumDiameter < branch.medianLocalRadius * 2)
  })

  it('keeps robust diameter invariant under quarter-turn rotation and mirroring', () => {
    const vertical = taperedVerticalStructure()
    const horizontal = taperedHorizontalStructure()
    const mirrored = taperedHorizontalStructure(true)
    const diameter = (
      fixture: { subject: BinaryMask; landmarks: readonly ImageLandmark[] },
      role: StructuralRole,
    ) => branchForRole(buildMedialGraph(
      buildSourceShapeModel(fixture.subject, 1, fixture.landmarks),
      { landmarks: fixture.landmarks },
    ), role).robustMinimumDiameter

    const verticalDiameter = diameter(vertical, 'ear-tip')
    const horizontalDiameter = diameter(horizontal, 'tail-tip')
    const mirroredDiameter = diameter(mirrored, 'tail-tip')

    assert.ok(Number.isFinite(verticalDiameter))
    assert.ok(Number.isFinite(horizontalDiameter))
    assert.ok(Number.isFinite(mirroredDiameter))
    assert.equal(verticalDiameter, horizontalDiameter)
    assert.equal(horizontalDiameter, mirroredDiameter)
  })

  it('compresses an ear support into a role-labelled endpoint-to-junction branch', () => {
    const subject = binaryMask(17, 17, (x, y) =>
      (x === 8 && y >= 2 && y <= 8)
      || (y === 8 && x >= 3 && x <= 13)
      || (x === 8 && y >= 8 && y <= 14))
    const landmarks: readonly ImageLandmark[] = [
      {
        id: 'ear-tip', kind: 'ear', structuralRole: 'ear-tip',
        x: 8, y: 2, confidence: 1, priority: 'hard', affectsOccupancy: true,
      },
      {
        id: 'ear-root', kind: 'body', structuralRole: 'ear-root',
        x: 8, y: 8, confidence: 1, priority: 'hard', affectsOccupancy: true,
      },
    ]
    const graph = buildMedialGraph(buildSourceShapeModel(subject, 1, landmarks), { landmarks })
    const earBranch = graph.branches.find((branch) => {
      const roles = branch.endpointRoleHits.map((hit) => hit.role)
      return roles.includes('ear-tip') && roles.includes('ear-root')
    })

    assert.ok(earBranch)
    assert.equal(earBranch.fromNodeKind === 'junction' || earBranch.toNodeKind === 'junction', true)
    assert.ok(earBranch.geodesicLength >= 5)
  })

  it('compresses a Y skeleton into one junction and three branches', () => {
    const points = new Set([
      '8,8', '7,7', '6,6', '5,5',
      '9,7', '10,6', '11,5',
      '8,9', '8,10', '8,11', '8,12', '8,13',
    ])
    const subject = binaryMask(17, 17, (x, y) => points.has(`${x},${y}`))
    const graph = buildMedialGraph(buildSourceShapeModel(subject, 1))

    assert.equal(graph.nodes.filter((node) => node.kind === 'junction').length, 1)
    assert.equal(graph.nodes.filter((node) => node.kind === 'endpoint').length, 3)
    assert.equal(graph.branches.length, 3)
    assert.ok(graph.branches.every((branch) => branch.geodesicLength > 3))
  })

  it('prunes short nuisance spurs while retaining a hard semantic endpoint', () => {
    const points = new Set<string>()
    for (let x = 2; x <= 14; x += 1) points.add(`${x},8`)
    points.add('5,7')
    points.add('5,6')
    points.add('8,7')
    points.add('8,6')
    points.add('11,9')
    points.add('11,10')
    const subject = binaryMask(17, 17, (x, y) => points.has(`${x},${y}`))
    const landmarks: readonly ImageLandmark[] = [{
      id: 'tail-tip', kind: 'custom', structuralRole: 'tail-tip',
      x: 11, y: 10, confidence: 1, priority: 'hard', affectsOccupancy: true,
    }]
    const graph = buildMedialGraph(buildSourceShapeModel(subject, 1, landmarks), {
      landmarks,
      minimumSpurGeodesicLength: 2.5,
    })

    assert.equal(graph.skeletonMask[6 * 17 + 5], 0)
    assert.equal(graph.skeletonMask[6 * 17 + 8], 0)
    assert.equal(graph.skeletonMask[10 * 17 + 11], 1)
    assert.ok(graph.endpointRoleHits.some((hit) => hit.landmarkId === 'tail-tip' && hit.hard))
    assert.equal(graph.prunedSpurCount, 2)
  })

  it('keeps branch measurements stable when endpoint evidence moves by 0.49px', () => {
    const subject = binaryMask(32, 32, (x, y) => x >= 14 && x <= 17 && y >= 4 && y <= 27)
    const graphAt = (offset: number) => {
      const landmarks: readonly ImageLandmark[] = [{
        id: 'tail-tip', kind: 'custom', structuralRole: 'tail-tip',
        x: 15.5 + offset, y: 4.2 + offset, confidence: 1, priority: 'hard', affectsOccupancy: true,
      }]
      return buildMedialGraph(buildSourceShapeModel(subject, 1, landmarks), { landmarks })
    }
    const original = longestBranch(graphAt(0))
    const translated = longestBranch(graphAt(0.49))

    assert.ok(Math.abs(original.geodesicLength - translated.geodesicLength) < 1e-9)
    assert.ok(Math.abs(original.medianLocalRadius - translated.medianLocalRadius) < 1e-9)
  })

  it('recomputes medial radii inside the selected crop', () => {
    const subject = binaryMask(32, 32, (x, y) => x >= 2 && x <= 29 && y >= 2 && y <= 29)
    const crop = { x: 12, y: 4, width: 8, height: 24 }
    const croppedSubject = binaryMask(32, 32, (x, y) =>
      x >= crop.x && x < crop.x + crop.width
      && y >= crop.y && y < crop.y + crop.height)

    const croppedGraph = buildMedialGraph(buildSourceShapeModel(subject, 1), { crop })
    const explicitGraph = buildMedialGraph(buildSourceShapeModel(croppedSubject, 1))
    const croppedBranch = longestBranch(croppedGraph)
    const explicitBranch = longestBranch(explicitGraph)

    assert.deepEqual(croppedGraph.candidateMask, explicitGraph.candidateMask)
    assert.deepEqual(croppedGraph.skeletonMask, explicitGraph.skeletonMask)
    assert.ok(Math.abs(croppedBranch.minimumLocalRadius - explicitBranch.minimumLocalRadius) < 1e-9)
    assert.ok(Math.abs(croppedBranch.medianLocalRadius - explicitBranch.medianLocalRadius) < 1e-9)
  })

  for (const size of [32, 48, 64]) {
    it(`keeps a closed circular ring topologically intact at ${size}x${size}`, () => {
      const center = (size - 1) / 2
      const innerRadius = 2.5
      const outerRadius = 5
      const subject = binaryMask(size, size, (x, y) => {
        const radius = Math.hypot(x - center, y - center)
        return radius >= innerRadius && radius <= outerRadius
      })
      const graph = buildMedialGraph(buildSourceShapeModel(subject, 1))
      const foregroundComponents = componentCount(
        graph.skeletonMask,
        size,
        size,
        1,
        eightNeighborOffsets,
      )
      const holes = holeCount(graph.skeletonMask, size, size)

      assert.equal(foregroundComponents, 1)
      assert.equal(holes, 1)
      assert.equal(foregroundComponents - holes, 0)
      assert.equal(endpointCount(graph.skeletonMask, size, size), 0)
    })
  }
})
