function clamp(value) {
  if (Number.isFinite(value) === false) return 0
  return Math.max(0, Math.min(1, value))
}

function mean(values) {
  return values.reduce((sum, value) => sum + clamp(value), 0) / Math.max(1, values.length)
}

export function candidateFeatureVector(candidate) {
  const metrics = candidate.metrics
  const score = candidate.score
  const refinement = candidate.gridRefinement?.diagnosticsAfter
  const cellCount = Math.max(1, candidate.pattern.width * candidate.pattern.height)
  const clusterPenalty = refinement === undefined
    ? 0
    : (refinement.fragmentedArcSegments + refinement.smallComponents + refinement.singleCellBands)
      / cellCount
  return {
    silhouette: clamp(score.silhouette),
    identityFeatures: mean([score.identity, score.identityAppearance ?? score.identity]),
    composition: clamp(score.canvasFit),
    valueOrder: clamp(metrics.valueOrderAccuracy),
    colorFidelity: clamp(score.colorFidelity),
    pixelClusters: mean([score.cleanliness, 1 - clusterPenalty]),
    contourRhythm: mean([score.structure, metrics.planBoundaryAgreement, metrics.sourceBoundaryAgreement]),
    thinStructure: mean([
      metrics.featureConnectivity,
      metrics.shapeApplied ? metrics.silhouetteBoundaryIoU : score.structure,
    ]),
    boundaryAnchors: mean([metrics.hardFeatureCompleteness, score.featureProtection]),
    material: clamp(metrics.paletteRoleConsistency),
    styleFit: clamp(1 - metrics.artDirectionBudgetViolations / cellCount),
    craftEase: clamp(score.craftEase),
  }
}

export function preferenceCandidateFromPattern(id, candidate, route = 'deterministic') {
  return {
    id,
    route,
    style: candidate.style,
    paletteId: candidate.pattern.palette.length === 0 ? 'unknown' : 'generic-24',
    grid: { width: candidate.pattern.width, height: candidate.pattern.height },
    model: {
      name: 'ai-bead-pattern/pattern-core',
      version: candidate.pattern.metadata.algorithmVersion,
      weightSource: 'repository-source',
      license: 'MIT',
    },
    features: candidateFeatureVector(candidate),
  }
}
