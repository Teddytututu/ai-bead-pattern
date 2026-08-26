import { validateFeatureGateRecord } from './schema.mjs'

export function evaluateFeatureGateRecord(inputRecord) {
  const record = validateFeatureGateRecord(inputRecord)
  const features = record.features.map((feature) => {
    const top2Ids = new Set(feature.topCandidates.slice(0, 2).map((entry) => entry.candidateId))
    const selected = feature.topCandidates.find((entry) => entry.candidateId === feature.selectedCandidateId)
    const visible = new Set(feature.visibleCells)
    return {
      featureId: feature.featureId,
      kind: feature.kind,
      hard: feature.hard,
      top2Accepted: feature.acceptedCandidateIds.some((id) => top2Ids.has(id)),
      selectedCandidateId: feature.selectedCandidateId,
      selectedTemplateId: selected.templateId,
      occupiedCells: selected.occupiedCells,
      visibleCells: feature.visibleCells,
      fullyVisible: selected.occupiedCells.every((cell) => visible.has(cell)),
      visibilityRate: selected.occupiedCells.filter((cell) => visible.has(cell)).length / selected.occupiedCells.length,
    }
  })
  const collisions = []
  const hardFeatures = features.filter((feature) => feature.hard)
  for (let firstIndex = 0; firstIndex < hardFeatures.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < hardFeatures.length; secondIndex += 1) {
      const first = hardFeatures[firstIndex]
      const second = hardFeatures[secondIndex]
      const secondCells = new Set(second.occupiedCells)
      const overlapCells = first.occupiedCells.filter((cell) => secondCells.has(cell))
      if (overlapCells.length > 0) {
        collisions.push({ firstFeatureId: first.featureId, secondFeatureId: second.featureId, overlapCells })
      }
    }
  }
  return {
    imageId: record.imageId,
    size: record.size,
    candidateId: record.candidateId,
    evaluatorId: record.evaluatorId,
    features,
    collisions,
  }
}
