import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createPatternAlgorithm,
  evaluatePetPoseStructure,
  type ImageAnalysis,
  type ImageLandmark,
  type MaterialPalette,
  type PatternCandidate,
  type PatternGenerationResult,
  type PixelImage,
} from '../src/index.js'
import type { StructuralRole } from '../src/types.js'

const width = 20
const height = 20

const palette: MaterialPalette = {
  id: 'pet-structure-ranking',
  name: 'Pet structure ranking',
  colors: [
    { id: 'red', name: 'Red', hex: '#ff0000', rgb: [255, 0, 0] },
    { id: 'white', name: 'White', hex: '#ffffff', rgb: [255, 255, 255] },
  ],
}

function solidImage(): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 255
    data[index * 4 + 3] = 255
  }
  return { width, height, data }
}

function set(values: Uint8Array, x: number, y: number): void {
  if (x >= 0 && y >= 0 && x < width && y < height) values[y * width + x] = 1
}

function line(values: Uint8Array, x0: number, y0: number, x1: number, y1: number): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
  for (let step = 0; step <= steps; step += 1) {
    set(values, Math.round(x0 + (x1 - x0) * step / steps), Math.round(y0 + (y1 - y0) * step / steps))
  }
}

function mask(paint: (values: Uint8Array) => void): Uint8Array {
  const values = new Uint8Array(width * height)
  paint(values)
  return values
}

function landmark(id: string, structuralRole: StructuralRole, x: number, y: number): ImageLandmark {
  return {
    id,
    kind: 'body',
    structuralRole,
    x,
    y,
    confidence: 0.49,
    priority: 'soft',
  }
}

function petAnalysis(values: Uint8Array): ImageAnalysis {
  return {
    imageType: 'pet',
    confidence: 1,
    subjectMask: { width, height, values: Float32Array.from(values) },
    landmarks: [
      landmark('visible-ear-tip', 'ear-tip', 14, 2),
      landmark('visible-ear-root', 'ear-root', 13, 4),
      landmark('nose-tip', 'nose-tip', 17, 5),
      landmark('upper-jaw-end', 'upper-jaw', 16, 6),
      landmark('lower-jaw-end', 'lower-jaw', 16, 8),
      landmark('neck-base', 'neck-base', 13, 4),
      landmark('visible-shoulder', 'shoulder', 12, 6),
      landmark('back-middle', 'back-middle', 8, 6),
      landmark('tail-root', 'tail-root', 5, 8),
      landmark('visible-hip', 'hip', 6, 10),
      landmark('front-knee', 'front-knee', 13, 12),
      landmark('front-paw', 'front-paw', 13, 17),
      landmark('rear-knee', 'rear-knee', 8, 13),
      landmark('rear-paw', 'rear-paw', 7, 17),
      landmark('tail-tip', 'tail-tip', 2, 10),
    ],
  }
}

function detailedPetMask(): Uint8Array {
  return mask((values) => {
    for (let y = 6; y <= 10; y += 1) {
      for (let x = 5; x <= 12; x += 1) set(values, x, y)
    }
    line(values, 14, 2, 13, 4)
    line(values, 17, 5, 16, 6)
    line(values, 17, 5, 16, 8)
    line(values, 13, 4, 12, 6)
    line(values, 12, 6, 10, 10)
    line(values, 10, 10, 13, 17)
    line(values, 6, 10, 8, 13)
    line(values, 8, 13, 7, 17)
    line(values, 5, 8, 2, 10)
  })
}

function candidate(result: PatternGenerationResult): PatternCandidate {
  const value = result.recommended ?? result.bestEffort
  if (value === undefined) throw new Error('Expected a generated candidate')
  return value
}

async function generate(values: Uint8Array): Promise<{ candidate: PatternCandidate; analysis: ImageAnalysis }> {
  const analysis = petAnalysis(values)
  const result = await createPatternAlgorithm({ clock: () => 123 }).generate({
    image: solidImage(),
    palette,
    analysis,
    options: {
      canvas: { mode: 'fixed', size: { width, height } },
      maxColors: 2,
      maxCandidates: 1,
      styles: ['faithful'],
      structure: { occupancyMode: 'subject-shape', shapeRefinementIterations: 0 },
      optimization: {
        minRegionSize: 1,
        stripePenalty: 0,
        aliasPenalty: 0,
        paletteCoherence: 0,
        localSearchIterations: 0,
      },
    },
  })
  return { candidate: candidate(result), analysis }
}

function finalMask(output: PatternCandidate): Uint8Array {
  const values = new Uint8Array(output.pattern.width * output.pattern.height)
  for (const cell of output.pattern.cells) values[cell.y * output.pattern.width + cell.x] = 1
  return values
}

describe('pet candidate structure ranking', () => {
  it('publishes final-grid ear, muzzle, jaw-separation, and chest-run diagnostics', async () => {
    const generated = await generate(detailedPetMask())
    const pose = evaluatePetPoseStructure({
      analysis: generated.analysis,
      crop: { x: 0, y: 0, width, height },
      fit: { x: 0, y: 0, width, height },
      width,
      height,
      activeMask: finalMask(generated.candidate),
    })
    const publicMetrics = [
      generated.candidate.metrics.petEarStructure,
      generated.candidate.metrics.petMuzzleStructure,
      generated.candidate.metrics.petFrontVerticalRunRatio,
      generated.candidate.metrics.petMuzzleSeparationCells,
      generated.candidate.metrics.petInstanceCount,
      generated.candidate.metrics.petSubjectComponentRecall,
      generated.candidate.metrics.petWeakestInstanceIdentityCompleteness,
      generated.candidate.metrics.petCrossInstanceCollisionRate,
    ]

    assert.ok(publicMetrics.every(Number.isFinite))
    assert.equal(generated.candidate.metrics.petEarStructure, pose.earStructure)
    assert.equal(generated.candidate.metrics.petMuzzleStructure, pose.muzzleStructure)
    assert.equal(generated.candidate.metrics.petFrontVerticalRunRatio, pose.frontVerticalRunRatio)
    assert.equal(generated.candidate.metrics.petMuzzleSeparationCells, pose.muzzleSeparationCells)
    assert.equal(generated.candidate.metrics.petInstanceCount, pose.instanceCount)
    assert.equal(generated.candidate.metrics.petSubjectComponentRecall, pose.subjectComponentRecall)
    assert.equal(
      generated.candidate.metrics.petWeakestInstanceIdentityCompleteness,
      pose.weakestInstanceIdentityCompleteness,
    )
    assert.equal(
      generated.candidate.metrics.petCrossInstanceCollisionRate,
      pose.crossInstanceCollisionRate,
    )
  })

  it('ranks a connected ear path above an ear with a missing middle segment', async () => {
    const preservedMask = detailedPetMask()
    const brokenMask = preservedMask.slice()
    brokenMask[3 * width + 14] = 0
    brokenMask[4 * width + 13] = 0

    const [preserved, broken] = await Promise.all([generate(preservedMask), generate(brokenMask)])

    assert.ok(
      preserved.candidate.score.poseStructure > broken.candidate.score.poseStructure + 0.04,
      JSON.stringify({ preserved: preserved.candidate.score, broken: broken.candidate.score }),
    )
    assert.ok(preserved.candidate.score.total > broken.candidate.score.total + 0.005)
    assert.ok(preserved.candidate.metrics.petEarStructure > broken.candidate.metrics.petEarStructure + 0.25)
    assert.ok(broken.candidate.rejectionReasons.includes('pet-ear-disconnected'))
  })

  it('ranks separated jaws with a complete nose cap above a collapsed muzzle', async () => {
    const preservedMask = detailedPetMask()
    const collapsedMask = preservedMask.slice()
    collapsedMask[7 * width + 16] = 0
    collapsedMask[8 * width + 16] = 0
    collapsedMask[5 * width + 17] = 0

    const [preserved, collapsed] = await Promise.all([generate(preservedMask), generate(collapsedMask)])

    assert.ok(
      preserved.candidate.score.poseStructure > collapsed.candidate.score.poseStructure + 0.04,
      JSON.stringify({ preserved: preserved.candidate.score, collapsed: collapsed.candidate.score }),
    )
    assert.ok(preserved.candidate.score.total > collapsed.candidate.score.total + 0.005)
    assert.ok(preserved.candidate.metrics.petMuzzleSeparationCells
      > collapsed.candidate.metrics.petMuzzleSeparationCells)
    assert.ok(preserved.candidate.metrics.petMuzzleStructure > collapsed.candidate.metrics.petMuzzleStructure + 0.2)
    assert.ok(collapsed.candidate.rejectionReasons.includes('pet-muzzle-collapsed'))
  })

  it('ranks an articulated chest turn above a long near-vertical front column', async () => {
    const articulatedMask = detailedPetMask()
    const columnMask = mask((values) => {
      for (let y = 6; y <= 17; y += 1) {
        const edge = y % 2 === 0 ? 12 : 13
        for (let x = 5; x <= edge; x += 1) set(values, x, y)
      }
      line(values, 14, 2, 13, 4)
      line(values, 17, 5, 16, 6)
      line(values, 17, 5, 16, 8)
      line(values, 5, 8, 2, 10)
    })

    const [articulated, column] = await Promise.all([generate(articulatedMask), generate(columnMask)])

    assert.ok(
      articulated.candidate.score.poseStructure > column.candidate.score.poseStructure + 0.04,
      JSON.stringify({ articulated: articulated.candidate.score, column: column.candidate.score }),
    )
    assert.ok(articulated.candidate.score.total > column.candidate.score.total + 0.005)
    assert.ok(articulated.candidate.metrics.petFrontVerticalRunRatio + 0.2
      < column.candidate.metrics.petFrontVerticalRunRatio)
    assert.ok(articulated.candidate.metrics.petBoundaryRhythm > column.candidate.metrics.petBoundaryRhythm + 0.15)
    assert.ok(column.candidate.rejectionReasons.includes('pet-front-column'))
  })
})
