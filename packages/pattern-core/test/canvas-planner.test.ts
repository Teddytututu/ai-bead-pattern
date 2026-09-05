import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  planCanvases,
  validateCanvasPlan,
  type CanvasPlanningInput,
} from '../src/experimental.js'
import { fitCropToCanvas, gridCellForSourcePoint } from '../src/image.js'
import { planCanvasesWithShapeVariants } from '../src/planning/canvas-planner.js'
import {
  buildSourceShapeModel,
  rasterizeSourceShape,
  type ShapeRasterization,
} from '../src/shape.js'
import { evaluateTopologyAgreement, scoreTopologyAgreement } from '../src/topology-metrics.js'
import type { BinaryMask, ImageLandmark, SemanticRegion } from '../src/index.js'

function solidMask(width: number, height: number, inset = 0): BinaryMask {
  return {
    width,
    height,
    values: Float32Array.from({ length: width * height }, (_, index) => {
      const x = index % width
      const y = Math.floor(index / width)
      return x >= inset && y >= inset && x < width - inset && y < height - inset ? 1 : 0
    }),
  }
}

function verticalSemanticRegion(
  id: string,
  confidence: number,
  left: number,
  regionWidth: number,
  top = 16,
  bottom = 80,
): SemanticRegion {
  const width = 96
  const height = 96
  return {
    id,
    label: id,
    confidence,
    importance: 0.95,
    mask: {
      width,
      height,
      values: Float32Array.from({ length: width * height }, (_, index) => {
        const x = index % width
        const y = Math.floor(index / width)
        return x >= left && x < left + regionWidth && y >= top && y < bottom ? 1 : 0
      }),
    },
  }
}

function structuralRole(value: NonNullable<ImageLandmark['structuralRole']>): NonNullable<ImageLandmark['structuralRole']> {
  return value
}

type ObservationState = 'observed' | 'inferred' | 'missing'

function withObservationState(
  landmark: ImageLandmark,
  observationState: ObservationState,
): ImageLandmark {
  return { ...landmark, observationState } as ImageLandmark
}

function structuralUnit(
  plan: ReturnType<typeof planCanvases>[number],
  predicate: (id: string) => boolean,
): {
  id: string
  allocatedCells: number
  minimumCells: number
  preferredCells: number
  feasible: boolean
  hard: boolean
  reliability?: number
  sourceSpanPixels?: number
} {
  const budget = plan.structuralUnitBudgets?.find((entry) => predicate(entry.id))
  assert.ok(budget)
  return budget as typeof budget & { reliability?: number }
}

function portraitInput(landmarks: readonly ImageLandmark[]): CanvasPlanningInput {
  return {
    image: { width: 96, height: 96 },
    analysis: {
      confidence: 1,
      subjectMask: solidMask(96, 96, 8),
      landmarks,
    },
    crop: { x: 0, y: 0, width: 96, height: 96 },
    candidates: [{ width: 12, height: 12 }, { width: 48, height: 48 }],
    occupancyMode: 'subject-shape',
  }
}

function topologyPetMask(): BinaryMask {
  const width = 96
  const height = 96
  return {
    width,
    height,
    values: Float32Array.from({ length: width * height }, (_, index) => {
      const x = index % width
      const y = Math.floor(index / width)
      const body = x >= 24 && x <= 68 && y >= 24 && y <= 74
      const leftEar = x >= 30 && x <= 34 && y >= 8 && y <= 26
      const rightEar = x >= 54 && x <= 58 && y >= 8 && y <= 26
      const tail = x >= 66 && x <= 90 && y >= 50 && y <= 55
      const frontLeg = x >= 54 && x <= 60 && y >= 70 && y <= 90
      const rearLeg = x >= 32 && x <= 38 && y >= 70 && y <= 90
      return body || leftEar || rightEar || tail || frontLeg || rearLeg ? 1 : 0
    }),
  }
}

function withTopologyDiagnostics(
  shape: ShapeRasterization,
  activeMask: Uint8Array,
): ShapeRasterization {
  const topology = evaluateTopologyAgreement({
    referenceMask: { width: shape.width, height: shape.height, values: shape.activeMask },
    candidateMask: { width: shape.width, height: shape.height, values: activeMask },
  })
  return {
    ...shape,
    activeMask,
    diagnostics: {
      ...shape.diagnostics,
      topologyCenterlinePrecision: topology.centerlinePrecision,
      topologyCenterlineRecall: topology.centerlineRecall,
      topologyClDice: topology.clDice,
      topologyWeightedCenterlinePrecision: topology.weightedCenterlinePrecision,
      topologyWeightedCenterlineRecall: topology.weightedCenterlineRecall,
      topologyWeightedClDice: topology.weightedClDice,
      topologyEndpointPrecision: topology.endpointPrecision,
      topologyEndpointRecall: topology.endpointRecall,
      topologyEndpointF1: topology.endpointF1,
      topologyJunctionPrecision: topology.junctionPrecision,
      topologyJunctionRecall: topology.junctionRecall,
      topologyJunctionF1: topology.junctionF1,
      topologyScore: scoreTopologyAgreement(topology),
    },
  }
}

describe('V2 canvas planning', () => {
  it('allocates more feature cells when a larger canvas can express them', () => {
    const plans = planCanvases(portraitInput([
      { id: 'eye', kind: 'eye', x: 32, y: 34, confidence: 1, priority: 'hard' },
      { id: 'mouth', kind: 'mouth', x: 48, y: 58, confidence: 1, priority: 'hard' },
    ]))

    const smallEye = plans[0]!.featureBudgets.find((budget) => budget.featureId === 'eye')!
    const largeEye = plans[1]!.featureBudgets.find((budget) => budget.featureId === 'eye')!
    const smallMouth = plans[0]!.featureBudgets.find((budget) => budget.featureId === 'mouth')!
    const largeMouth = plans[1]!.featureBudgets.find((budget) => budget.featureId === 'mouth')!

    assert.ok(largeEye.allocatedCells > smallEye.allocatedCells)
    assert.ok(largeMouth.allocatedCells > smallMouth.allocatedCells)
    assert.ok(plans[1]!.score.feature > plans[0]!.score.feature)
  })

  it('marks paired hard features infeasible when they collapse into one cell', () => {
    const plans = planCanvases(portraitInput([
      { id: 'left-eye', kind: 'eye', x: 42, y: 34, confidence: 1, priority: 'hard', symmetryGroup: 'eyes' },
      { id: 'right-eye', kind: 'eye', x: 46, y: 34, confidence: 1, priority: 'hard', symmetryGroup: 'eyes' },
    ]))

    assert.equal(plans[0]!.featureBudgets.every((budget) => budget.feasible), false)
    assert.equal(plans[1]!.featureBudgets.every((budget) => budget.feasible), true)
  })

  it('turns hard feature infeasibility into a canvas veto with a specific reason', () => {
    const plans = planCanvases(portraitInput([
      { id: 'left-eye', kind: 'eye', x: 42, y: 34, confidence: 1, priority: 'hard', symmetryGroup: 'eyes' },
      { id: 'right-eye', kind: 'eye', x: 46, y: 34, confidence: 1, priority: 'hard', symmetryGroup: 'eyes' },
    ]))

    assert.equal(plans[0]!.feasible, false)
    assert.deepEqual(plans[0]!.rejectionReasons, ['canvas-hard-feature-collision'])
    assert.equal(plans[1]!.feasible, true)
    assert.deepEqual(plans[1]!.rejectionReasons, [])
    assert.ok(plans[0]!.featureBudgets.every((budget) => budget.hard))
  })

  it('keeps a soft underbudget feature as a score penalty', () => {
    const input = portraitInput([
      { id: 'face', kind: 'face-contour', x: 48, y: 42, confidence: 1, priority: 'soft' },
    ])
    const plan = planCanvases({
      ...input,
      candidates: [{ width: 4, height: 4 }],
    })[0]!

    assert.equal(plan.featureBudgets[0]!.feasible, false)
    assert.equal(plan.featureBudgets[0]!.hard, false)
    assert.equal(plan.feasible, true)
    assert.deepEqual(plan.rejectionReasons, [])
  })

  it('reports a multi-cell contour as infeasible on a tiny canvas', () => {
    const input = portraitInput([
      { id: 'face', kind: 'face-contour', x: 48, y: 42, confidence: 1, priority: 'hard' },
    ])
    const plans = planCanvases({
      ...input,
      candidates: [{ width: 4, height: 4 }, { width: 48, height: 48 }],
    })
    const small = plans[0]!.featureBudgets[0]!
    const large = plans[1]!.featureBudgets[0]!

    assert.ok(small.allocatedCells < small.minimumCells)
    assert.equal(small.feasible, false)
    assert.equal(large.feasible, true)
  })

  it('budgets profile jaw endpoints as single-cell anchors while keeping face contours multi-cell', () => {
    const plans = planCanvases({
      image: { width: 96, height: 96 },
      analysis: {
        imageType: 'pet',
        confidence: 1,
        subjectMask: solidMask(96, 96, 8),
        landmarks: [
          {
            id: 'upper-jaw-end', kind: 'face-contour', structuralRole: structuralRole('upper-jaw'),
            x: 68, y: 42, confidence: 1, priority: 'hard', affectsOccupancy: true,
            observationState: 'observed', gridRadiusCells: 0,
          },
          {
            id: 'lower-jaw-end', kind: 'face-contour', structuralRole: structuralRole('lower-jaw'),
            x: 68, y: 48, confidence: 1, priority: 'hard', affectsOccupancy: true,
            observationState: 'observed', gridRadiusCells: 0,
          },
          {
            id: 'cheek-contour', kind: 'face-contour',
            x: 52, y: 48, confidence: 1, priority: 'soft', affectsOccupancy: true,
            observationState: 'observed', gridRadiusCells: 1,
          },
        ],
      },
      crop: { x: 0, y: 0, width: 96, height: 96 },
      candidates: [
        { width: 32, height: 32 },
        { width: 48, height: 48 },
        { width: 64, height: 64 },
      ],
      occupancyMode: 'subject-shape',
    })

    for (const plan of plans) {
      const upperJaw = plan.featureBudgets.find((budget) => budget.featureId === 'upper-jaw-end')!
      const lowerJaw = plan.featureBudgets.find((budget) => budget.featureId === 'lower-jaw-end')!
      const cheek = plan.featureBudgets.find((budget) => budget.featureId === 'cheek-contour')!
      for (const jaw of [upperJaw, lowerJaw]) {
        assert.equal(jaw.minimumCells, 1)
        assert.equal(jaw.preferredCells, 1)
        assert.equal(jaw.maximumCells, 3)
        assert.equal(jaw.allocatedCells, 1)
        assert.equal(jaw.feasible, true)
      }
      assert.equal(cheek.minimumCells, 4)
      assert.equal(cheek.preferredCells, 12)
      assert.equal(cheek.maximumCells, 24)
      assert.equal(cheek.allocatedCells, 5)
    }
  })

  it('removes zero-confidence landmarks from feature-score normalization', () => {
    const eye = { id: 'eye', kind: 'eye', x: 32, y: 34, confidence: 1, priority: 'hard' } as const
    const base = planCanvases(portraitInput([eye]))
    const withUnknown = planCanvases(portraitInput([
      eye,
      { id: 'unknown-face', kind: 'face-contour', x: 48, y: 42, confidence: 0, priority: 'soft' },
    ]))

    assert.equal(withUnknown[0]!.score.feature, base[0]!.score.feature)
    assert.equal(withUnknown[1]!.score.feature, base[1]!.score.feature)
  })

  it('budgets inferred landmarks and removes missing landmarks from canvas planning', () => {
    const landmarks: readonly ImageLandmark[] = [
      withObservationState({
        id: 'observed-shoulder', kind: 'body', structuralRole: 'shoulder',
        x: 58, y: 34, confidence: 0.9, priority: 'hard', affectsOccupancy: true,
      }, 'observed'),
      withObservationState({
        id: 'inferred-front-knee', kind: 'body', structuralRole: 'front-knee',
        x: 58, y: 54, confidence: 0.55, priority: 'soft', affectsOccupancy: true,
      }, 'inferred'),
      withObservationState({
        id: 'inferred-front-paw', kind: 'body', structuralRole: 'front-paw',
        x: 58, y: 76, confidence: 0.55, priority: 'soft', affectsOccupancy: true,
      }, 'inferred'),
      withObservationState({
        id: 'missing-tail-tip', kind: 'body', structuralRole: 'tail-tip',
        x: 10, y: 48, confidence: 0.95, priority: 'hard', affectsOccupancy: true,
      }, 'missing'),
    ]
    const plan = planCanvases({
      image: { width: 96, height: 96 },
      analysis: {
        imageType: 'pet',
        confidence: 1,
        subjectMask: solidMask(96, 96, 8),
        landmarks,
      },
      crop: { x: 0, y: 0, width: 96, height: 96 },
      candidates: [{ width: 48, height: 48 }],
      occupancyMode: 'subject-shape',
    })[0]!

    assert.ok(plan.featureBudgets.some((budget) => budget.featureId === 'inferred-front-knee'))
    assert.ok(plan.featureBudgets.some((budget) => budget.featureId === 'inferred-front-paw'))
    assert.ok(plan.structuralUnitBudgets?.some((budget) => budget.id === 'front-lower-leg'))
    assert.equal(plan.featureBudgets.some((budget) => budget.featureId === 'missing-tail-tip'), false)
    assert.equal(plan.structuralUnitBudgets?.some((budget) => budget.toLandmarkId === 'missing-tail-tip'), false)
  })

  it('limits feature allocation to active subject cells near the landmark', () => {
    const mask = new Float32Array(96 * 96)
    for (let y = 8; y < 24; y += 1) {
      for (let x = 8; x < 24; x += 1) mask[y * 96 + x] = 1
    }
    const plan = planCanvases({
      image: { width: 96, height: 96 },
      analysis: {
        confidence: 1,
        subjectMask: { width: 96, height: 96, values: mask },
        landmarks: [{ id: 'eye', kind: 'eye', x: 72, y: 72, confidence: 1, priority: 'hard' }],
      },
      candidates: [{ width: 48, height: 48 }],
      occupancyMode: 'subject-shape',
    })[0]!

    assert.equal(plan.featureBudgets[0]!.allocatedCells, 0)
    assert.equal(plan.featureBudgets[0]!.feasible, false)
    assert.equal(plan.feasible, false)
    assert.deepEqual(plan.rejectionReasons, ['canvas-hard-feature-underbudget'])
  })

  it('uses subject occupancy to estimate bead count', () => {
    const shaped = planCanvases({
      image: { width: 20, height: 20 },
      analysis: { subjectMask: solidMask(20, 20, 5), confidence: 1 },
      candidates: [{ width: 20, height: 20 }],
      occupancyMode: 'subject-shape',
    })[0]!
    const full = planCanvases({
      image: { width: 20, height: 20 },
      analysis: { subjectMask: solidMask(20, 20, 5), confidence: 1 },
      candidates: [{ width: 20, height: 20 }],
      occupancyMode: 'full-frame',
    })[0]!

    assert.ok(shaped.estimatedBeads < full.estimatedBeads)
    assert.equal(shaped.subjectCoverage, full.subjectCoverage)
  })

  it('keeps the smallest sufficient canvas ahead when no feature needs more cells', () => {
    const plans = planCanvases({
      image: { width: 64, height: 64 },
      candidates: [{ width: 24, height: 24 }, { width: 48, height: 48 }, { width: 96, height: 96 }],
      occupancyMode: 'full-frame',
    })
    const ranked = [...plans].sort((first, second) => second.score.total - first.score.total)

    assert.deepEqual(ranked[0]!.size, { width: 24, height: 24 })
    assert.ok(plans[2]!.score.beadCost > plans[0]!.score.beadCost)
  })

  it('uses the finest reliable pet structure to choose the smallest sufficient proportional canvas', () => {
    const structuralRole = (value: string) => value as NonNullable<ImageLandmark['structuralRole']>
    const plans = planCanvases({
      image: { width: 256, height: 256 },
      analysis: {
        imageType: 'pet',
        confidence: 1,
        subjectMask: solidMask(256, 256, 24),
        landmarks: [
          {
            id: 'visible-ear-tip', kind: 'ear', structuralRole: structuralRole('ear-tip'),
            x: 150, y: 40, confidence: 1, priority: 'hard', affectsOccupancy: true,
          },
          {
            id: 'visible-ear-root', kind: 'body', structuralRole: structuralRole('ear-root'),
            x: 150, y: 52, confidence: 1, priority: 'hard', affectsOccupancy: true,
          },
          {
            id: 'front-knee', kind: 'body', structuralRole: structuralRole('front-knee'),
            x: 168, y: 150, confidence: 0.9, priority: 'soft', affectsOccupancy: true,
          },
          {
            id: 'front-paw', kind: 'body', structuralRole: structuralRole('front-paw'),
            x: 168, y: 180, confidence: 0.9, priority: 'soft', affectsOccupancy: true,
          },
        ],
      },
      crop: { x: 0, y: 0, width: 256, height: 256 },
      candidates: [
        { width: 32, height: 32 },
        { width: 48, height: 48 },
        { width: 64, height: 64 },
      ],
      occupancyMode: 'subject-shape',
    })
    const units = plans.map((plan) => (plan as typeof plan & {
      structuralUnitBudgets: readonly {
        id: string
        allocatedCells: number
        minimumCells: number
        feasible: boolean
      }[]
    }).structuralUnitBudgets)

    assert.equal(units[0]!.find((unit) => unit.id === 'ear-span')?.feasible, false)
    assert.equal(units[1]!.find((unit) => unit.id === 'ear-span')?.feasible, true)
    assert.equal(units[2]!.find((unit) => unit.id === 'ear-span')?.feasible, true)
    assert.ok(plans[0]!.rejectionReasons.includes('canvas-structural-unit-underbudget'))
    const ranked = [...plans].sort((first, second) => Number(second.feasible) - Number(first.feasible)
      || second.score.total - first.score.total)
    assert.deepEqual(ranked[0]!.size, { width: 48, height: 48 })
  })

  it('chooses the smallest canvas that preserves hard endpoints and centerline continuity', () => {
    const subjectMask = topologyPetMask()
    const crop = { x: 0, y: 0, width: 96, height: 96 }
    const landmarks: readonly ImageLandmark[] = [
      withObservationState({
        id: 'ear-tip', kind: 'ear', structuralRole: 'ear-tip',
        x: 32, y: 8, confidence: 1, priority: 'hard', affectsOccupancy: true,
      }, 'observed'),
      withObservationState({
        id: 'ear-root', kind: 'body', structuralRole: 'ear-root',
        x: 32, y: 26, confidence: 1, priority: 'hard', affectsOccupancy: true,
      }, 'observed'),
      withObservationState({
        id: 'tail-root', kind: 'body', structuralRole: 'tail-root',
        x: 66, y: 53, confidence: 1, priority: 'hard', affectsOccupancy: true,
      }, 'observed'),
      withObservationState({
        id: 'tail-tip', kind: 'body', structuralRole: 'tail-tip',
        x: 90, y: 53, confidence: 1, priority: 'hard', affectsOccupancy: true,
      }, 'observed'),
    ]
    const model = buildSourceShapeModel(subjectMask, 1, landmarks)
    const variants = new Map<string, ShapeRasterization>()
    for (const size of [32, 48, 64]) {
      const fit = fitCropToCanvas(crop, size, size)
      const shape = rasterizeSourceShape(
        model,
        crop,
        fit,
        size,
        size,
        landmarks,
        { preserveThinStructures: true },
      )
      if (size === 32) {
        const damaged = shape.activeMask.slice()
        const [earX, earY] = gridCellForSourcePoint(crop, fit, 32, 18)
        const [tailX, tailY] = gridCellForSourcePoint(crop, fit, 78, 53)
        for (let offset = -1; offset <= 1; offset += 1) {
          damaged[(earY + offset) * size + earX] = 0
          damaged[tailY * size + tailX + offset] = 0
        }
        variants.set(`${size}x${size}`, withTopologyDiagnostics(shape, damaged))
      } else {
        variants.set(`${size}x${size}`, withTopologyDiagnostics(shape, shape.activeMask))
      }
    }
    const plans = planCanvasesWithShapeVariants({
      image: { width: 96, height: 96 },
      analysis: { imageType: 'pet', confidence: 1, subjectMask, landmarks },
      crop,
      candidates: [
        { width: 32, height: 32 },
        { width: 48, height: 48 },
        { width: 64, height: 64 },
      ],
      occupancyMode: 'subject-shape',
    }, variants)

    assert.equal(plans[0]!.topologyFeasible, false, JSON.stringify({
      plan: plans[0]!.score,
      diagnostics: variants.get('32x32')?.diagnostics,
    }))
    assert.ok(plans[0]!.rejectionReasons.includes('canvas-topology-underbudget'))
    assert.ok((plans[0]!.score.topology ?? 1) < (plans[1]!.score.topology ?? 0))
    assert.equal(plans[1]!.topologyFeasible, true)
    assert.equal(plans[2]!.topologyFeasible, true)
    const ranked = [...plans].sort((first, second) => Number(second.feasible) - Number(first.feasible)
      || second.score.total - first.score.total)
    assert.deepEqual(ranked[0]!.size, { width: 48, height: 48 })
  })

  it('budgets the finest structure of each prefixed pet instance independently', () => {
    const plans = planCanvases({
      image: { width: 128, height: 96 },
      analysis: {
        imageType: 'pet',
        confidence: 1,
        subjectMask: solidMask(128, 96, 4),
        landmarks: [
          {
            id: 'pet-01:ear-tip', kind: 'ear', structuralRole: 'ear-tip',
            x: 24, y: 20, confidence: 0.95, priority: 'hard', affectsOccupancy: true,
          },
          {
            id: 'pet-01:ear-root', kind: 'body', structuralRole: 'ear-root',
            x: 24, y: 32, confidence: 0.75, priority: 'hard', affectsOccupancy: true,
          },
          {
            id: 'pet-02:ear-tip', kind: 'ear', structuralRole: 'ear-tip',
            x: 96, y: 18, confidence: 0.75, priority: 'hard', affectsOccupancy: true,
          },
          {
            id: 'pet-02:ear-root', kind: 'body', structuralRole: 'ear-root',
            x: 96, y: 34, confidence: 0.95, priority: 'hard', affectsOccupancy: true,
          },
        ],
      },
      crop: { x: 0, y: 0, width: 128, height: 96 },
      candidates: [{ width: 48, height: 48 }],
      occupancyMode: 'subject-shape',
    })

    const ears = plans[0]!.structuralUnitBudgets?.filter((budget) =>
      budget.id.endsWith('ear-span')) ?? []
    assert.equal(ears.length, 2)
    assert.deepEqual(
      ears.map((budget) => [budget.fromLandmarkId, budget.toLandmarkId]),
      [
        ['pet-01:ear-tip', 'pet-01:ear-root'],
        ['pet-02:ear-tip', 'pet-02:ear-root'],
      ],
    )
    assert.equal(new Set(ears.map((budget) => budget.id)).size, 2)
  })

  it('lets the weakest pet instance govern the shared structural scale score', () => {
    const landmark = (
      instanceId: string,
      id: string,
      structuralRoleValue: NonNullable<ImageLandmark['structuralRole']>,
      x: number,
      y: number,
    ): ImageLandmark => ({
      id: `${instanceId}:${id}`,
      kind: structuralRoleValue === 'eye-center' ? 'eye'
        : structuralRoleValue === 'nose-tip' ? 'nose'
          : structuralRoleValue === 'ear-tip' ? 'ear' : 'body',
      structuralRole: structuralRoleValue,
      x,
      y,
      confidence: 0.95,
      priority: 'hard',
      affectsOccupancy: true,
      observationState: 'observed',
      provenance: [{
        origin: 'model',
        provider: 'mmpose-animal-local',
        version: 'test-model',
      }],
    })
    const plans = planCanvases({
      image: { width: 128, height: 64 },
      analysis: {
        imageType: 'pet',
        confidence: 0.95,
        subjectMask: solidMask(128, 64, 2),
        landmarks: [
          landmark('pet-01', 'eye', 'eye-center', 18, 18),
          landmark('pet-01', 'nose', 'nose-tip', 66, 18),
          landmark('pet-01', 'ear-tip', 'ear-tip', 22, 4),
          landmark('pet-01', 'ear-root', 'ear-root', 22, 28),
          landmark('pet-02', 'eye', 'eye-center', 102, 20),
          landmark('pet-02', 'nose', 'nose-tip', 106, 20),
        ],
      },
      crop: { x: 0, y: 0, width: 128, height: 64 },
      candidates: [{ width: 32, height: 32 }, { width: 96, height: 96 }],
      occupancyMode: 'subject-shape',
    })

    const smallWeakUnit = structuralUnit(
      plans[0]!,
      (id) => id === 'pet-02:eye-muzzle-span',
    )
    assert.equal(smallWeakUnit.allocatedCells, 1)
    assert.equal(smallWeakUnit.feasible, false)
    assert.ok((plans[0]!.score.structuralScale ?? 1) < 0.6)
    assert.equal(structuralUnit(
      plans[1]!,
      (id) => id === 'pet-02:eye-muzzle-span',
    ).feasible, true)
    assert.ok((plans[1]!.score.structuralScale ?? 0) > 0.95)
  })

  it('projects source spans continuously so a 0.49px translation cannot change the scale budget', () => {
    const plan = (offset: number) => planCanvases({
      image: { width: 256, height: 256 },
      analysis: {
        imageType: 'pet',
        confidence: 1,
        subjectMask: solidMask(256, 256, 24),
        landmarks: [
          {
            id: 'visible-ear-tip', kind: 'ear', structuralRole: structuralRole('ear-tip'),
            x: 150, y: 42.4 + offset, confidence: 1, priority: 'hard', affectsOccupancy: true,
          },
          {
            id: 'visible-ear-root', kind: 'body', structuralRole: structuralRole('ear-root'),
            x: 150, y: 54.4 + offset, confidence: 1, priority: 'hard', affectsOccupancy: true,
          },
        ],
      },
      crop: { x: 0, y: 0, width: 256, height: 256 },
      candidates: [{ width: 48, height: 48 }],
      occupancyMode: 'subject-shape',
    })[0]!

    const original = structuralUnit(plan(0), (id) => id === 'ear-span')
    const translated = structuralUnit(plan(0.49), (id) => id === 'ear-span')

    assert.ok(Math.abs(original.allocatedCells - translated.allocatedCells) < 1e-9)
    assert.ok(Math.abs(original.allocatedCells - 2.25) < 1e-9)
  })

  it('rejects 32 and accepts 48 when a reliable pet tail is four source pixels wide', () => {
    const plans = planCanvases({
      image: { width: 96, height: 96 },
      analysis: {
        imageType: 'pet',
        confidence: 0.95,
        subjectMask: solidMask(96, 96, 8),
        semanticRegions: [verticalSemanticRegion('pet-tail', 0.95, 70, 4)],
      },
      crop: { x: 0, y: 0, width: 96, height: 96 },
      candidates: [{ width: 32, height: 32 }, { width: 48, height: 48 }],
      occupancyMode: 'subject-shape',
    })
    const small = structuralUnit(plans[0]!, (id) => id.includes('tail') && id.includes('width'))
    const medium = structuralUnit(plans[1]!, (id) => id.includes('tail') && id.includes('width'))

    assert.ok(Math.abs(small.allocatedCells - 4 / 3) < 1e-6)
    assert.ok(small.allocatedCells < small.minimumCells)
    assert.equal(small.feasible, false)
    assert.equal(plans[0]!.feasible, false)
    assert.ok(plans[0]!.rejectionReasons.includes('canvas-structural-unit-underbudget'))
    assert.equal(medium.allocatedCells, 2)
    assert.equal(medium.feasible, true)
    assert.equal(plans[1]!.feasible, true)
  })

  it('ignores a short ordinary spur and ranks the smallest sufficient canvas first', () => {
    const width = 32
    const height = 32
    const tailMask: BinaryMask = {
      width,
      height,
      values: Float32Array.from({ length: width * height }, (_, index) => {
        const x = index % width
        const y = Math.floor(index / width)
        const shaft = x >= 14 && x <= 18 && y >= 3 && y <= 28
        const spur = x >= 19 && x <= 20 && y >= 15 && y <= 16
        return shaft || spur ? 1 : 0
      }),
    }
    const plans = planCanvases({
      image: { width, height },
      analysis: {
        imageType: 'pet',
        confidence: 0.95,
        semanticRegions: [{
          id: 'pet-tail',
          label: 'pet tail',
          confidence: 0.95,
          importance: 0.95,
          mask: tailMask,
        }],
      },
      crop: { x: 0, y: 0, width, height },
      candidates: [{ width: 8, height: 8 }, { width: 12, height: 12 }, { width: 16, height: 16 }],
      occupancyMode: 'full-frame',
    })
    const small = structuralUnit(plans[0]!, (id) => id === 'tail-width')
    const sufficient = structuralUnit(plans[1]!, (id) => id === 'tail-width')
    const large = structuralUnit(plans[2]!, (id) => id === 'tail-width')

    assert.equal(small.feasible, false)
    assert.equal(sufficient.feasible, true)
    assert.equal(large.feasible, true)
    assert.ok(Math.abs(sufficient.sourceSpanPixels! - 6) < 1e-9)
    const ranked = [...plans].sort((first, second) => Number(second.feasible) - Number(first.feasible)
      || second.score.total - first.score.total)
    assert.deepEqual(ranked[0]!.size, { width: 12, height: 12 })
  })

  it('keeps medial cross-section budgets stable across a 0.49px crop translation', () => {
    const plan = (offset: number) => planCanvases({
      image: { width: 96, height: 96 },
      analysis: {
        imageType: 'pet',
        confidence: 0.95,
        semanticRegions: [verticalSemanticRegion('pet-tail', 0.95, 40, 4, 20, 76)],
      },
      crop: { x: 8 + offset, y: 8 + offset, width: 80, height: 80 },
      candidates: [{ width: 48, height: 48 }],
      occupancyMode: 'full-frame',
    })[0]!

    const original = structuralUnit(plan(0), (id) => id === 'tail-width')
    const translated = structuralUnit(plan(0.49), (id) => id === 'tail-width')

    assert.ok(Math.abs(original.allocatedCells - translated.allocatedCells) < 1e-9)
    assert.ok(Math.abs(original.allocatedCells - 2.4) < 1e-9)
  })

  it('keeps a low-reliability leg underbudget as a soft score penalty', () => {
    const plan = planCanvases({
      image: { width: 96, height: 96 },
      analysis: {
        imageType: 'pet',
        confidence: 0.95,
        subjectMask: solidMask(96, 96, 8),
        semanticRegions: [verticalSemanticRegion('pet-foreleg-visible', 0.35, 47, 2, 40, 49)],
        landmarks: [
          {
            id: 'front-knee', kind: 'body', structuralRole: structuralRole('front-knee'),
            x: 48, y: 40, confidence: 0.95, priority: 'soft', affectsOccupancy: true,
            carrierRegionId: 'pet-foreleg-visible',
          },
          {
            id: 'front-paw', kind: 'body', structuralRole: structuralRole('front-paw'),
            x: 48, y: 48, confidence: 0.95, priority: 'soft', affectsOccupancy: true,
            carrierRegionId: 'pet-foreleg-visible',
          },
        ],
      },
      crop: { x: 0, y: 0, width: 96, height: 96 },
      candidates: [{ width: 12, height: 12 }],
      occupancyMode: 'subject-shape',
    })[0]!
    const leg = structuralUnit(plan, (id) => id === 'front-lower-leg')

    assert.ok((leg.reliability ?? 1) < 0.6)
    assert.equal(leg.feasible, false)
    assert.equal(leg.hard, false)
    assert.equal(plan.feasible, true)
    assert.equal(plan.rejectionReasons.includes('canvas-structural-unit-underbudget'), false)
    assert.ok((plan.score.structuralScale ?? 1) < 1)
  })

  it('produces plans that satisfy the public V2 contract', () => {
    const input = portraitInput([
      { id: 'eye', kind: 'eye', x: 32, y: 34, confidence: 0.9, priority: 'hard' },
    ])
    const plans = planCanvases({ ...input, beadDiameterMm: 5 })

    assert.ok(plans.length > 0)
    for (const plan of plans) assert.doesNotThrow(() => validateCanvasPlan(plan))
    assert.equal(plans[0]!.estimatedWidthMm, 60)
    assert.equal(plans[1]!.estimatedHeightMm, 240)
  })

  it('rejects malformed planning input at the public boundary', () => {
    assert.throws(() => planCanvases({
      image: { width: 20, height: 20 },
      crop: { x: 0, y: 0, width: Number.NaN, height: 10 },
      candidates: [{ width: 12, height: 12 }],
    }), /crop/i)
    assert.throws(() => planCanvases({
      image: { width: 20, height: 20 },
      candidates: [],
    }), /candidate/i)
    assert.throws(() => planCanvases({
      image: { width: 20, height: 20 },
      candidates: [{ width: 97, height: 20 }],
    }), /processing limit/i)
    assert.throws(() => planCanvases({
      image: { width: 2, height: 1 },
      analysis: {
        subjectMask: { width: 2, height: 1, values: new Float32Array([1, Number.NaN]) },
      },
      candidates: [{ width: 12, height: 12 }],
    }), /mask values/i)
  })

  it('counts fitted content or the whole board according to occupancy mode', () => {
    const base = {
      image: { width: 20, height: 10 },
      candidates: [{ width: 20, height: 20 }],
    } as const
    const fitted = planCanvases({ ...base, occupancyMode: 'full-frame' })[0]!
    const solid = planCanvases({ ...base, occupancyMode: 'solid-background' })[0]!

    assert.equal(fitted.estimatedBeads, 200)
    assert.equal(solid.estimatedBeads, 400)
  })

  it('uses crop and occupancy identity in stable canvas plan ids', () => {
    const base = {
      image: { width: 40, height: 40 },
      candidates: [{ width: 24, height: 24 }],
    } as const
    const first = planCanvases({
      ...base,
      crop: { x: 0, y: 0, width: 30, height: 30 },
      occupancyMode: 'full-frame',
    })[0]!
    const repeated = planCanvases({
      ...base,
      crop: { x: 0, y: 0, width: 30, height: 30 },
      occupancyMode: 'full-frame',
    })[0]!
    const shifted = planCanvases({
      ...base,
      crop: { x: 5, y: 5, width: 30, height: 30 },
      occupancyMode: 'full-frame',
    })[0]!

    assert.equal(first.id, repeated.id)
    assert.notEqual(first.id, shifted.id)
  })

  it('changes the canvas identity when a structural semantic mask changes', () => {
    const plan = (left: number) => planCanvases({
      image: { width: 96, height: 96 },
      analysis: {
        imageType: 'pet',
        confidence: 0.9,
        semanticRegions: [verticalSemanticRegion('pet-tail', 0.95, left, 4)],
      },
      candidates: [{ width: 48, height: 48 }],
      occupancyMode: 'full-frame',
    })[0]!

    assert.notEqual(plan(70).id, plan(64).id)
    assert.equal(plan(70).id, plan(70).id)
  })
})
