import type { ResolvedFeaturePlacement } from './feature-placement.js'

export interface FaceFeatureCandidates {
  featureId: string
  expectedCenter: readonly [number, number]
  candidates: readonly ResolvedFeaturePlacement[]
  hard: boolean
}
/** Bounded beam over the whole face; displacement penalties preserve the SOURCE pose. */
export function searchFaceFeatureGroup(features: readonly FaceFeatureCandidates[], blocked: ReadonlySet<number> = new Set()): readonly ResolvedFeaturePlacement[] {
  if (features.length > 16) throw new RangeError('Face search supports at most 16 components per group')
  const expected = new Map(features.map(feature => [feature.featureId, feature.expectedCenter]))
  type State = { placements: ResolvedFeaturePlacement[]; used: Set<number>; score: number }
  let beam: State[] = [{ placements: [], used: new Set(blocked), score: 0 }]
  for (const feature of [...features].sort((a, b) => Number(b.hard) - Number(a.hard) || a.featureId.localeCompare(b.featureId))) {
    const next: State[] = []
    for (const state of beam) {
      for (const placement of feature.candidates.slice(0, 16)) {
        const occupied = [...placement.occupiedCells, ...(placement.reservedCells ?? [])]
        if (occupied.some(cell => state.used.has(cell))) continue
        let relativeError = 0, crossed = false
        for (const other of state.placements) {
          const a = expected.get(other.featureId)!, b = feature.expectedCenter
          const expectedX = b[0] - a[0], expectedY = b[1] - a[1]
          const actualX = placement.center[0] - other.center[0], actualY = placement.center[1] - other.center[1]
          if (expectedX * actualX + expectedY * actualY <= 0 && Math.hypot(expectedX, expectedY) > 0.5) crossed = true
          relativeError += Math.hypot(actualX - expectedX, actualY - expectedY)
        }
        if (crossed) continue
        next.push({ placements: [...state.placements, placement], used: new Set([...state.used, ...occupied]),
          score: state.score + (feature.hard ? 10 : 2) + placement.score - relativeError * 0.25 })
      }
      // Keep an explicit incomplete alternative; later quality checks report missing hard features.
      next.push({ ...state, score: state.score - (feature.hard ? 10 : 0.5) })
    }
    beam = next.sort((a, b) => b.score - a.score || a.placements.map(p => `${p.featureId}:${p.templateId}:${p.center}`).join('|').localeCompare(b.placements.map(p => `${p.featureId}:${p.templateId}:${p.center}`).join('|'))).slice(0, 24)
  }
  return beam[0]?.placements ?? []
}
