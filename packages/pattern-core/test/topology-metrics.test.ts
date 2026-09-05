import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  evaluateTopologyAgreement,
  projectTopologyReference,
  scoreTopologyAgreement,
  topologyAgreementSchema,
} from '../src/topology-metrics.js'
import { fitCropToCanvas, gridCellForSourcePoint } from '../src/image.js'
import { buildSourceShapeModel } from '../src/shape.js'
import type { ImageLandmark } from '../src/types.js'

function maskFromRows(rows: readonly string[]) {
  const width = Math.max(0, ...rows.map((row) => row.length))
  assert.ok(width > 0)
  const normalized = rows.map((row) => row.padEnd(width, '.'))
  return {
    width,
    height: rows.length,
    values: Float32Array.from(normalized.join(''), (value) => value === '#' ? 1 : 0),
  }
}

const catSilhouette = maskFromRows([
  '........................',
  '......##....##............',
  '......##....##............',
  '......##....##............',
  '.....####..####...........',
  '.....##########...........',
  '....############..........',
  '....############..........',
  '....############......##..',
  '....############.....###..',
  '....############....####..',
  '....############...#####..',
  '....##################....',
  '....#################.....',
  '.....##############.......',
  '......############........',
  '.......##########.........',
  '......###......###.........',
  '.....###........###........',
  '........................',
])

const catWithoutTail = maskFromRows([
  '........................',
  '......##....##............',
  '......##....##............',
  '......##....##............',
  '.....####..####...........',
  '.....##########...........',
  '....############..........',
  '....############..........',
  '....############..........',
  '....############..........',
  '....############..........',
  '....############..........',
  '....############..........',
  '....############..........',
  '.....##############.......',
  '......############........',
  '.......##########.........',
  '......###......###.........',
  '.....###........###........',
  '........................',
])

const catWithoutLeftEar = maskFromRows([
  '........................',
  '............##............',
  '............##............',
  '............##............',
  '..........####............',
  '.....##########...........',
  '....############..........',
  '....############..........',
  '....############......##..',
  '....############.....###..',
  '....############....####..',
  '....############...#####..',
  '....##################....',
  '....#################.....',
  '.....##############.......',
  '......############........',
  '.......##########.........',
  '......###......###.........',
  '.....###........###........',
  '........................',
])

describe('node-weighted topology agreement', () => {
  it('publishes the reviewed clDice and medial-graph sources', () => {
    assert.equal(topologyAgreementSchema.id, 'node-weighted-dual-cldice-v3')
    assert.deepEqual(topologyAgreementSchema.sources, [
      'jocpae/clDice@47d31a6cc4a8101b1ffe8052994821961e57af9f',
      'scikit-image/scikit-image@ee0a7a3ebd9ac8c2602f40e55bc015a3c8a81ae8',
      'jni/skan@94ec591f4a2763795b84141d6a85cb6fd0ab6b2a',
      'e-koch/FilFinder@bbb06edc167d177f61fccf600fb812fdf904ddb6',
    ])
    assert.deepEqual(topologyAgreementSchema.licenses, ['MIT', 'BSD-3-Clause', 'BSD-3-Clause', 'MIT'])
  })

  it('scores an identical cat silhouette as a complete topology match', () => {
    const result = evaluateTopologyAgreement({
      referenceMask: catSilhouette,
      candidateMask: catSilhouette,
    })

    assert.equal(result.centerlinePrecision, 1)
    assert.equal(result.centerlineRecall, 1)
    assert.equal(result.clDice, 1)
    assert.equal(result.backgroundClDice, 1)
    assert.equal(result.weightedClDice, 1)
    assert.equal(result.endpointF1, 1)
    assert.equal(result.junctionF1, 1)
    assert.equal(result.branchCountAgreement, 1)
    assert.equal(result.cycleCountAgreement, 1)
    assert.equal(result.componentCountAgreement, 1)
  })

  it('penalizes a severed tail more strongly at its missing endpoint', () => {
    const result = evaluateTopologyAgreement({
      referenceMask: catSilhouette,
      candidateMask: catWithoutTail,
    })

    assert.ok(result.centerlineRecall < 0.9)
    assert.ok(result.weightedCenterlineRecall < result.centerlineRecall)
    assert.ok(result.weightedClDice < result.clDice)
    assert.ok(result.endpointRecall < 1)
    assert.ok(result.weightedClDice < 0.9)
  })

  it('detects a clipped ear while retaining the shared body topology', () => {
    const complete = evaluateTopologyAgreement({
      referenceMask: catSilhouette,
      candidateMask: catSilhouette,
    })
    const clipped = evaluateTopologyAgreement({
      referenceMask: catSilhouette,
      candidateMask: catWithoutLeftEar,
    })

    assert.ok(clipped.weightedClDice < complete.weightedClDice)
    assert.ok(clipped.endpointRecall < complete.endpointRecall)
    assert.ok(clipped.centerlineRecall > 0.7)
  })

  it('ranks complete topology above severed tail and clipped ear candidates', () => {
    const complete = evaluateTopologyAgreement({
      referenceMask: catSilhouette,
      candidateMask: catSilhouette,
    })
    const severedTail = evaluateTopologyAgreement({
      referenceMask: catSilhouette,
      candidateMask: catWithoutTail,
    })
    const clippedEar = evaluateTopologyAgreement({
      referenceMask: catSilhouette,
      candidateMask: catWithoutLeftEar,
    })

    assert.ok(scoreTopologyAgreement(complete) > scoreTopologyAgreement(severedTail))
    assert.ok(scoreTopologyAgreement(complete) > scoreTopologyAgreement(clippedEar))
    assert.ok(scoreTopologyAgreement(severedTail) < 0.9)
  })

  it('uses candidate-side centerlines to penalize an invented spur', () => {
    const reference = maskFromRows([
      '...........',
      '...#####...',
      '...#####...',
      '...#####...',
      '...#####...',
      '...#####...',
      '...........',
    ])
    const candidate = maskFromRows([
      '.....#.....',
      '...#####...',
      '...#####...',
      '...#####...',
      '...#####...',
      '...#####...',
      '...........',
    ])

    const result = evaluateTopologyAgreement({ referenceMask: reference, candidateMask: candidate })

    assert.equal(result.centerlineRecall, 1)
    assert.ok(result.centerlinePrecision < 1)
    assert.ok(result.weightedCenterlinePrecision < result.centerlinePrecision)
    assert.ok(result.endpointPrecision < 1)
  })

  it('reports a lost branch junction even when the remaining arm stays connected', () => {
    const reference = maskFromRows([
      '...#...#...',
      '....#.#....',
      '.....#.....',
      '.....#.....',
      '.....#.....',
      '.....#.....',
      '...........',
    ])
    const candidate = maskFromRows([
      '.......#...',
      '......#....',
      '.....#.....',
      '.....#.....',
      '.....#.....',
      '.....#.....',
      '...........',
    ])

    const result = evaluateTopologyAgreement({ referenceMask: reference, candidateMask: candidate })

    assert.ok(result.reference.junctions > 0)
    assert.equal(result.candidate.junctions, 0)
    assert.equal(result.junctionRecall, 0)
    assert.ok(result.branchCountAgreement < 1)
    assert.ok(result.weightedClDice < 0.9)
  })

  it('penalizes a broken closed loop even when most centerline cells remain', () => {
    const reference = maskFromRows([
      '.........',
      '..#####..',
      '..#...#..',
      '..#...#..',
      '..#...#..',
      '..#####..',
      '.........',
    ])
    const candidate = maskFromRows([
      '.........',
      '..##.##..',
      '..#...#..',
      '..#...#..',
      '..#...#..',
      '..#####..',
      '.........',
    ])

    const complete = evaluateTopologyAgreement({ referenceMask: reference, candidateMask: reference })
    const broken = evaluateTopologyAgreement({ referenceMask: reference, candidateMask: candidate })

    assert.equal(complete.reference.cycles, 1)
    assert.equal(broken.candidate.cycles, 0)
    assert.equal(broken.cycleCountAgreement, 0)
    assert.ok(broken.weightedClDice > 0.8)
    assert.ok(scoreTopologyAgreement(broken) < scoreTopologyAgreement(complete))
  })

  it('uses background clDice to detect an invented enclosed gap', () => {
    const reference = maskFromRows([
      '.........',
      '..#####..',
      '..#####..',
      '..#####..',
      '..#####..',
      '..#####..',
      '.........',
    ])
    const candidate = maskFromRows([
      '.........',
      '..#####..',
      '..#####..',
      '..##.##..',
      '..#####..',
      '..#####..',
      '.........',
    ])

    const complete = evaluateTopologyAgreement({ referenceMask: reference, candidateMask: reference })
    const inventedGap = evaluateTopologyAgreement({ referenceMask: reference, candidateMask: candidate })

    assert.equal(complete.backgroundClDice, 1)
    assert.ok(inventedGap.backgroundCenterlinePrecision < 1)
    assert.ok(inventedGap.backgroundClDice < 1)
    assert.ok(scoreTopologyAgreement(inventedGap) < scoreTopologyAgreement(complete))
  })

  it('applies the configured tolerance radius to foreground and background clDice', () => {
    const foregroundReference = maskFromRows([
      '.......',
      '..###..',
      '..###..',
      '..###..',
      '.......',
    ])
    const foregroundShifted = maskFromRows([
      '.......',
      '...###.',
      '...###.',
      '...###.',
      '.......',
    ])
    const backgroundReference = maskFromRows([
      '.........',
      '..#####..',
      '..#####..',
      '..##.##..',
      '..#####..',
      '..#####..',
      '.........',
    ])
    const backgroundShifted = maskFromRows([
      '.........',
      '..#####..',
      '..#####..',
      '..###.#..',
      '..#####..',
      '..#####..',
      '.........',
    ])

    const foregroundStrict = evaluateTopologyAgreement({
      referenceMask: foregroundReference,
      candidateMask: foregroundShifted,
    })
    const foregroundTolerant = evaluateTopologyAgreement({
      referenceMask: foregroundReference,
      candidateMask: foregroundShifted,
      options: { coverageRadiusCells: 1 },
    })
    const backgroundStrict = evaluateTopologyAgreement({
      referenceMask: backgroundReference,
      candidateMask: backgroundShifted,
    })
    const backgroundTolerant = evaluateTopologyAgreement({
      referenceMask: backgroundReference,
      candidateMask: backgroundShifted,
      options: { coverageRadiusCells: 1 },
    })

    assert.ok(foregroundTolerant.clDice > foregroundStrict.clDice)
    assert.ok(backgroundTolerant.backgroundClDice > backgroundStrict.backgroundClDice)
  })

  it('reports a missing detached structure through component-count agreement', () => {
    const reference = maskFromRows([
      '.........',
      '..#####..',
      '..#####..',
      '..#####..',
      '.........',
      '.......#.',
      '.........',
    ])
    const candidate = maskFromRows([
      '.........',
      '..#####..',
      '..#####..',
      '..#####..',
      '.........',
      '.........',
      '.........',
    ])

    const result = evaluateTopologyAgreement({ referenceMask: reference, candidateMask: candidate })

    assert.equal(result.reference.components, 2)
    assert.equal(result.candidate.components, 1)
    assert.equal(result.componentCountAgreement, 0.5)
  })

  it('validates aligned finite mask inputs', () => {
    assert.throws(() => evaluateTopologyAgreement({
      referenceMask: { width: 2, height: 2, values: [1, 0, 0, 1] },
      candidateMask: { width: 1, height: 4, values: [1, 0, 0, 1] },
    }), /share dimensions/)
    assert.throws(() => evaluateTopologyAgreement({
      referenceMask: { width: 2, height: 2, values: [1, Number.NaN, 0, 1] },
      candidateMask: { width: 2, height: 2, values: [1, 0, 0, 1] },
    }), /finite/)
  })

  it('handles empty topology explicitly', () => {
    const empty = { width: 3, height: 3, values: new Float32Array(9) }
    const point = { width: 3, height: 3, values: Float32Array.from([
      0, 0, 0,
      0, 1, 0,
      0, 0, 0,
    ]) }

    assert.equal(evaluateTopologyAgreement({
      referenceMask: empty,
      candidateMask: empty,
    }).weightedClDice, 1)
    assert.equal(evaluateTopologyAgreement({
      referenceMask: point,
      candidateMask: empty,
    }).weightedClDice, 0)
  })

  it('adds a source medial tail that the area-sampled target omits', () => {
    const size = 16
    const source = new Float32Array(size * size)
    for (let y = 4; y <= 11; y += 1) {
      for (let x = 2; x <= 8; x += 1) source[y * size + x] = 1
    }
    for (let x = 9; x < size; x += 1) source[8 * size + x] = 1
    const crop = { x: 0, y: 0, width: size, height: size }
    const fit = fitCropToCanvas(crop, 4, 4)
    const areaMask = Uint8Array.from([
      0, 0, 0, 0,
      1, 1, 0, 0,
      1, 1, 0, 0,
      0, 0, 0, 0,
    ])
    const [tailX, tailY] = gridCellForSourcePoint(crop, fit, 15.5, 8.5)

    const projected = projectTopologyReference({
      model: buildSourceShapeModel({ width: size, height: size, values: source }, 1),
      crop,
      fit,
      width: 4,
      height: 4,
      areaMask,
    })

    assert.equal(areaMask[tailY * 4 + tailX], 0)
    assert.equal(projected.mask[tailY * 4 + tailX], 1)
    assert.ok(projected.addedCells.includes(tailY * 4 + tailX))
  })

  it('projects a diagonal branch with Chebyshev-length DDA steps', () => {
    const sourceSize = 16
    const targetSize = 8
    const source = new Float32Array(sourceSize * sourceSize)
    for (let coordinate = 1; coordinate < sourceSize - 1; coordinate += 1) {
      source[coordinate * sourceSize + coordinate] = 1
    }
    const crop = { x: 0, y: 0, width: sourceSize, height: sourceSize }

    const projected = projectTopologyReference({
      model: buildSourceShapeModel({ width: sourceSize, height: sourceSize, values: source }, 1),
      crop,
      fit: fitCropToCanvas(crop, targetSize, targetSize),
      width: targetSize,
      height: targetSize,
      areaMask: new Uint8Array(targetSize * targetSize),
    })

    const expected = Array.from(
      { length: targetSize },
      (_, coordinate) => coordinate * targetSize + coordinate,
    )
    assert.deepEqual(projected.addedCells, expected)
    assert.equal(projected.projectedSkeletonCells, targetSize)
  })

  it('commits zero connector cells when a reserved hole blocks the branch', () => {
    const sourceSize = 16
    const targetSize = 8
    const source = new Float32Array(sourceSize * sourceSize)
    for (let x = 1; x < sourceSize - 1; x += 1) source[7 * sourceSize + x] = 1
    const areaMask = new Uint8Array(targetSize * targetSize)
    for (let y = 2; y <= 5; y += 1) {
      for (let x = 2; x <= 5; x += 1) {
        if (y === 2 || y === 5 || x === 2 || x === 5) areaMask[y * targetSize + x] = 1
      }
    }
    const crop = { x: 0, y: 0, width: sourceSize, height: sourceSize }

    const projected = projectTopologyReference({
      model: buildSourceShapeModel({ width: sourceSize, height: sourceSize, values: source }, 1),
      crop,
      fit: fitCropToCanvas(crop, targetSize, targetSize),
      width: targetSize,
      height: targetSize,
      areaMask,
    })

    assert.deepEqual(projected.addedCells, [])
    assert.deepEqual(projected.mask, areaMask)
  })

  it('counts diagonal foreground contact as one eight-connected component', () => {
    const diagonal = maskFromRows([
      '#..',
      '.#.',
      '..#',
    ])

    const topology = evaluateTopologyAgreement({
      referenceMask: diagonal,
      candidateMask: diagonal,
    })

    assert.equal(topology.reference.components, 1)
    assert.equal(topology.candidate.components, 1)
  })

  it('counts a diagonal background leak as a closed hole under four-connectivity', () => {
    const diagonalLeak = maskFromRows([
      '.##',
      '#.#',
      '###',
    ])

    const topology = evaluateTopologyAgreement({
      referenceMask: diagonalLeak,
      candidateMask: diagonalLeak,
    })

    assert.equal(topology.reference.cycles, 1)
    assert.equal(topology.candidate.cycles, 1)
  })

  it('records a source hole that collapses below the target-cell scale', () => {
    const sourceSize = 16
    const targetSize = 4
    const source = new Float32Array(sourceSize * sourceSize)
    for (let y = 4; y <= 11; y += 1) {
      for (let x = 4; x <= 11; x += 1) source[y * sourceSize + x] = 1
    }
    source[7 * sourceSize + 7] = 0
    const areaMask = Uint8Array.from([
      0, 0, 0, 0,
      0, 1, 1, 0,
      0, 1, 1, 0,
      0, 0, 0, 0,
    ])
    const crop = { x: 0, y: 0, width: sourceSize, height: sourceSize }

    const projected = projectTopologyReference({
      model: buildSourceShapeModel({ width: sourceSize, height: sourceSize, values: source }, 1),
      crop,
      fit: fitCropToCanvas(crop, targetSize, targetSize),
      width: targetSize,
      height: targetSize,
      areaMask,
    }) as ReturnType<typeof projectTopologyReference> & { collapsedHoleCount?: number }

    assert.deepEqual(projected.mask, areaMask)
    assert.equal(projected.collapsedHoleCount, 1)
  })

  it('projects all three hard branches of a compact Y junction', () => {
    const sourceSize = 12
    const targetSize = 6
    const source = new Float32Array(sourceSize * sourceSize)
    for (let offset = 0; offset <= 2; offset += 1) {
      source[(4 + offset) * sourceSize + 4 + offset] = 1
      source[(4 + offset) * sourceSize + 8 - offset] = 1
      source[(6 + offset) * sourceSize + 6] = 1
    }
    const landmarks: ImageLandmark[] = [
      {
        id: 'left-ear-tip', kind: 'ear', structuralRole: 'ear-tip', x: 4.5, y: 4.5,
        confidence: 0.99, priority: 'hard', observationState: 'observed', affectsOccupancy: true,
      },
      {
        id: 'right-ear-tip', kind: 'ear', structuralRole: 'ear-tip', x: 8.5, y: 4.5,
        confidence: 0.99, priority: 'hard', observationState: 'observed', affectsOccupancy: true,
      },
      {
        id: 'tail-tip', kind: 'custom', structuralRole: 'tail-tip', x: 6.5, y: 8.5,
        confidence: 0.99, priority: 'hard', observationState: 'observed', affectsOccupancy: true,
      },
    ]
    const crop = { x: 0, y: 0, width: sourceSize, height: sourceSize }
    const projected = projectTopologyReference({
      model: buildSourceShapeModel(
        { width: sourceSize, height: sourceSize, values: source },
        1,
        landmarks,
      ),
      crop,
      fit: fitCropToCanvas(crop, targetSize, targetSize),
      width: targetSize,
      height: targetSize,
      areaMask: new Uint8Array(targetSize * targetSize),
    })
    const topology = evaluateTopologyAgreement({
      referenceMask: { width: targetSize, height: targetSize, values: projected.mask },
      candidateMask: { width: targetSize, height: targetSize, values: projected.mask },
    })

    assert.equal(topology.reference.components, 1)
    assert.equal(topology.reference.endpoints, 3)
    assert.equal(topology.reference.junctions, 1)
    assert.equal(topology.reference.branches, 3)
  })

  it('keeps a short spur only when a hard semantic endpoint supports it', () => {
    const sourceSize = 20
    const targetSize = 10
    const source = new Float32Array(sourceSize * sourceSize)
    for (let y = 5; y <= 14; y += 1) {
      for (let x = 4; x <= 11; x += 1) source[y * sourceSize + x] = 1
    }
    source[9 * sourceSize + 12] = 1
    const hardEndpoint: ImageLandmark = {
      id: 'tail-tip',
      kind: 'custom',
      structuralRole: 'tail-tip',
      x: 12.5,
      y: 9.5,
      confidence: 0.99,
      priority: 'hard',
      observationState: 'observed',
      affectsOccupancy: true,
    }
    const areaMask = new Uint8Array(targetSize * targetSize)
    for (let y = 3; y <= 6; y += 1) {
      for (let x = 2; x <= 5; x += 1) areaMask[y * targetSize + x] = 1
    }
    const crop = { x: 0, y: 0, width: sourceSize, height: sourceSize }
    const fit = fitCropToCanvas(crop, targetSize, targetSize)
    const [tipX, tipY] = gridCellForSourcePoint(crop, fit, hardEndpoint.x, hardEndpoint.y)
    const plain = projectTopologyReference({
      model: buildSourceShapeModel({ width: sourceSize, height: sourceSize, values: source }, 1),
      crop,
      fit,
      width: targetSize,
      height: targetSize,
      areaMask,
    })
    const protectedProjection = projectTopologyReference({
      model: buildSourceShapeModel(
        { width: sourceSize, height: sourceSize, values: source },
        1,
        [hardEndpoint],
      ),
      crop,
      fit,
      width: targetSize,
      height: targetSize,
      areaMask,
    })
    const tipCell = tipY * targetSize + tipX

    assert.equal(plain.mask[tipCell], 0)
    assert.equal(protectedProjection.mask[tipCell], 1)
    assert.ok(protectedProjection.addedCells.includes(tipCell))
  })

  it('keeps an enclosed area-sampled hole while adding medial paths', () => {
    const ring = maskFromRows([
      '###.##.',
      '#.#.##.',
      '###....',
      '.......',
      '.......',
    ])
    const crop = { x: 0, y: 0, width: ring.width, height: ring.height }
    const areaMask = Uint8Array.from(ring.values, (value) => Number(value >= 1))

    const projected = projectTopologyReference({
      model: buildSourceShapeModel(ring, 1),
      crop,
      fit: fitCropToCanvas(crop, ring.width, ring.height),
      width: ring.width,
      height: ring.height,
      areaMask,
    })
    const topology = evaluateTopologyAgreement({
      referenceMask: { width: ring.width, height: ring.height, values: projected.mask },
      candidateMask: { width: ring.width, height: ring.height, values: areaMask },
    })

    assert.equal(projected.mask[ring.width + 1], 0)
    assert.equal(topology.reference.cycles, 1)
    assert.equal(topology.componentCountAgreement, 1)
  })

  it('leaves broad-body corner coverage to the area sampler', () => {
    const sourceSize = 256
    const source = Float32Array.from({ length: sourceSize * sourceSize }, (_, index) => {
      const x = index % sourceSize
      const y = Math.floor(index / sourceSize)
      return x >= 24 && x < 232 && y >= 24 && y < 232 ? 1 : 0
    })
    const targetSize = 48
    const areaMask = new Uint8Array(targetSize * targetSize)
    for (let y = 4; y <= 43; y += 1) {
      for (let x = 4; x <= 43; x += 1) areaMask[y * targetSize + x] = 1
    }
    for (const cell of [4 * targetSize + 4, 4 * targetSize + 43,
      43 * targetSize + 4, 43 * targetSize + 43]) {
      areaMask[cell] = 0
    }
    const crop = { x: 0, y: 0, width: sourceSize, height: sourceSize }

    const projected = projectTopologyReference({
      model: buildSourceShapeModel({ width: sourceSize, height: sourceSize, values: source }, 1),
      crop,
      fit: fitCropToCanvas(crop, targetSize, targetSize),
      width: targetSize,
      height: targetSize,
      areaMask,
    })

    assert.deepEqual(projected.addedCells, [])
    assert.deepEqual(projected.mask, areaMask)
  })
})
