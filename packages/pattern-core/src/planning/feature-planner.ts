import { gridCellForSourcePoint, type CanvasFit } from '../image.js'
import { landmarkEffectiveConfidence, landmarkGridRadiusCells } from '../landmarks.js'
import { createFeatureConstraint, searchFeaturePlacements, type ResolvedFeaturePlacement } from './feature-placement.js'
import { searchFeaturePairs } from './feature-pair-search.js'
import type { CanvasPlan } from '../contracts.js'
import type { CropRect, ImageAnalysis, ImageLandmark } from '../types.js'

function maskFromActiveCells(width: number, height: number, activeMask: Uint8Array) {
  return { width, height, values: Float32Array.from(activeMask) }
}

function carrierMask(
  carrierRegionId: string,
  width: number,
  height: number,
  regionIds: readonly (string | undefined)[],
) {
  return {
    width,
    height,
    values: Float32Array.from(regionIds, (regionId) => Number(regionId === carrierRegionId)),
  }
}

export function planFeaturePlacements(
  analysis: ImageAnalysis | undefined,
  canvasPlan: CanvasPlan,
  activeMask: Uint8Array,
  regionIds: readonly (string | undefined)[],
): readonly ResolvedFeaturePlacement[] {
  const eligible = (analysis?.landmarks ?? []).filter((landmark) =>
    landmark.kind === 'eye' || landmark.kind === 'mouth' || landmark.kind === 'nose'
      || landmark.kind === 'ear' || landmark.kind === 'identity-mark' || landmark.kind === 'custom')
  if (eligible.length === 0) return []
  const budgets = new Map(canvasPlan.featureBudgets.map((budget) => [budget.featureId, budget]))
  const occupancyMask = maskFromActiveCells(canvasPlan.size.width, canvasPlan.size.height, activeMask)
  const blockedCells = new Set<number>()
  const selected: ResolvedFeaturePlacement[] = []
  const handled = new Set<string>()
  const eyeGroups = new Map<string, ImageLandmark[]>()
  for (const landmark of eligible) {
    if (landmark.kind !== 'eye' || landmark.symmetryGroup === undefined) continue
    const group = eyeGroups.get(landmark.symmetryGroup) ?? []
    group.push(landmark)
    eyeGroups.set(landmark.symmetryGroup, group)
  }
  for (const group of eyeGroups.values()) {
    if (group.length !== 2) continue
    const ordered = [...group].sort((first, second) => first.x - second.x || first.id.localeCompare(second.id))
    const left = ordered[0]!
    const right = ordered[1]!
    const leftBudget = budgets.get(left.id)
    const rightBudget = budgets.get(right.id)
    if (leftBudget === undefined || rightBudget === undefined) continue
    const leftCandidates = searchFeaturePlacements({
      canvasPlan,
      budget: leftBudget,
      landmark: left,
      occupancyMask,
      blockedCells,
      ...(left.carrierRegionId === undefined ? {} : {
        carrierMask: carrierMask(
          left.carrierRegionId,
          canvasPlan.size.width,
          canvasPlan.size.height,
          regionIds,
        ),
      }),
    })
    const rightCandidates = searchFeaturePlacements({
      canvasPlan,
      budget: rightBudget,
      landmark: right,
      occupancyMask,
      blockedCells,
      ...(right.carrierRegionId === undefined ? {} : {
        carrierMask: carrierMask(
          right.carrierRegionId,
          canvasPlan.size.width,
          canvasPlan.size.height,
          regionIds,
        ),
      }),
    })
    const leftConstraint = createFeatureConstraint(leftBudget, left, canvasPlan)
    const rightConstraint = createFeatureConstraint(rightBudget, right, canvasPlan)
    const pair = searchFeaturePairs({
      leftCandidates,
      rightCandidates,
      expectedLeftCenter: leftConstraint.targetCenter,
      expectedRightCenter: rightConstraint.targetCenter,
      maximumPairs: 1,
    })[0]
    if (pair === undefined) continue
    selected.push(pair.left, pair.right)
    for (const cell of [...pair.left.occupiedCells, ...pair.right.occupiedCells]) blockedCells.add(cell)
    handled.add(left.id)
    handled.add(right.id)
  }
  const remaining = eligible.filter((landmark) => handled.has(landmark.id) === false)
    .sort((first, second) => Number(second.priority === 'hard') - Number(first.priority === 'hard')
      || second.confidence - first.confidence
      || first.id.localeCompare(second.id))
  for (const landmark of remaining) {
    const budget = budgets.get(landmark.id)
    if (budget === undefined) continue
    const placement = searchFeaturePlacements({
      canvasPlan,
      budget,
      landmark,
      occupancyMask,
      blockedCells,
      ...(landmark.carrierRegionId === undefined ? {} : {
        carrierMask: carrierMask(
          landmark.carrierRegionId,
          canvasPlan.size.width,
          canvasPlan.size.height,
          regionIds,
        ),
      }),
      maximumCandidates: 1,
    })[0]
    if (placement === undefined) continue
    selected.push(placement)
    for (const cell of placement.occupiedCells) blockedCells.add(cell)
  }
  return selected.sort((first, second) => first.featureId.localeCompare(second.featureId))
}

export function plannedFeatureConstraints(
  analysis: ImageAnalysis | undefined,
  canvasPlan: CanvasPlan,
  placements: readonly ResolvedFeaturePlacement[],
) {
  const landmarks = new Map((analysis?.landmarks ?? []).map((landmark) => [landmark.id, landmark]))
  const budgets = new Map(canvasPlan.featureBudgets.map((budget) => [budget.featureId, budget]))
  return placements.flatMap((placement) => {
    const landmark = landmarks.get(placement.featureId)
    const budget = budgets.get(placement.featureId)
    return landmark === undefined || budget === undefined
      ? []
      : [createFeatureConstraint(budget, landmark, canvasPlan)]
  })
}

export function protectedCells(
  analysis: ImageAnalysis | undefined,
  crop: CropRect,
  width: number,
  height: number,
  fit: CanvasFit,
  activeMask: Uint8Array,
): ReadonlySet<number> {
  const cells = new Set<number>()
  for (const landmark of analysis?.landmarks ?? []) {
    if (landmark.priority !== 'hard'
      || landmarkEffectiveConfidence(landmark) < 0.5) continue
    if (landmark.x < crop.x || landmark.y < crop.y
      || landmark.x >= crop.x + crop.width || landmark.y >= crop.y + crop.height) continue
    const [centerX, centerY] = gridCellForSourcePoint(crop, fit, landmark.x, landmark.y)
    const radius = landmarkGridRadiusCells(landmark, crop, fit)
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        const x = centerX + offsetX
        const y = centerY + offsetY
        const index = y * width + x
        if (x >= 0 && y >= 0 && x < width && y < height && activeMask[index] === 1) {
          cells.add(index)
        }
      }
    }
  }
  return cells
}
