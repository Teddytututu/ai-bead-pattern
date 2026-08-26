import type { ResolvedFeaturePlacement } from './feature-placement.js'

export interface FeaturePairSearchInput {
  leftCandidates: readonly ResolvedFeaturePlacement[]
  rightCandidates: readonly ResolvedFeaturePlacement[]
  expectedLeftCenter: readonly [number, number]
  expectedRightCenter: readonly [number, number]
  maximumPairs?: number
}

export interface ResolvedFeaturePair {
  left: ResolvedFeaturePlacement
  right: ResolvedFeaturePlacement
  spacingError: number
  heightError: number
  overlap: false
  score: number
}

function finitePoint(point: readonly [number, number], label: string): void {
  if (point.some((value) => Number.isFinite(value) === false)) {
    throw new RangeError(`${label} must contain finite coordinates`)
  }
}

export function searchFeaturePairs(input: FeaturePairSearchInput): readonly ResolvedFeaturePair[] {
  finitePoint(input.expectedLeftCenter, 'Expected left feature center')
  finitePoint(input.expectedRightCenter, 'Expected right feature center')
  const maximumPairs = input.maximumPairs ?? 16
  if (Number.isInteger(maximumPairs) === false || maximumPairs <= 0 || maximumPairs > 256) {
    throw new RangeError('Feature pair candidate limit must stay within 1..256')
  }
  const expectedSpacing = Math.abs(input.expectedRightCenter[0] - input.expectedLeftCenter[0])
  const pairs: ResolvedFeaturePair[] = []
  for (const left of input.leftCandidates) {
    for (const right of input.rightCandidates) {
      if (left.kind !== 'eye' || right.kind !== 'eye' || left.featureId === right.featureId) continue
      if (left.center[0] >= right.center[0]) continue
      const rightCells = new Set(right.occupiedCells)
      if (left.occupiedCells.some((cell) => rightCells.has(cell))) continue
      const actualSpacing = Math.abs(right.center[0] - left.center[0])
      const spacingError = Math.abs(actualSpacing - expectedSpacing)
      const heightError = Math.abs(right.center[1] - left.center[1])
      const placementScore = (left.score + right.score) / 2
      const spacingScore = 1 / (1 + spacingError)
      const heightScore = 1 / (1 + heightError)
      const templateScore = left.templateId === right.templateId ? 1 : 0.5
      pairs.push({
        left,
        right,
        spacingError,
        heightError,
        overlap: false,
        score: Math.min(1, Math.max(0,
          placementScore * 0.5 + spacingScore * 0.2 + heightScore * 0.2 + templateScore * 0.1)),
      })
    }
  }
  return [...pairs].sort((first, second) =>
    second.score - first.score
      || first.heightError - second.heightError
      || first.spacingError - second.spacingError
      || first.left.templateId.localeCompare(second.left.templateId))
    .slice(0, maximumPairs)
}
