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
  const petPoseAvailable = metrics.petPoseAvailable ?? [
    metrics.petPoseConfidence,
    metrics.petSkeletonContinuity,
    metrics.petBoundaryRhythm,
    metrics.petEarStructure,
    metrics.petMuzzleStructure,
  ].some((value) => Number.isFinite(value))
  const earStructure = petPoseAvailable
    ? clamp(metrics.petEarStructure ?? score.poseStructure)
    : undefined
  const muzzleStructure = petPoseAvailable
    ? clamp(metrics.petMuzzleStructure ?? score.poseStructure)
    : undefined
  const frontVerticalRunRatio = petPoseAvailable
    ? clamp(metrics.petFrontVerticalRunRatio ?? 1 - score.poseStructure)
    : undefined
  const frontChest = petPoseAvailable
    ? clamp(metrics.petFrontChestScore ?? 1 - frontVerticalRunRatio)
    : undefined
  const negativeSpace = petPoseAvailable
    ? clamp(metrics.petNegativeSpace ?? score.poseStructure)
    : undefined
  const multiPet = Number.isInteger(metrics.petInstanceCount) && metrics.petInstanceCount > 1
  const subjectComponentRecall = multiPet
    ? clamp(metrics.petSubjectComponentRecall)
    : undefined
  const weakestInstanceIdentityCompleteness = multiPet
    ? clamp(metrics.petWeakestInstanceIdentityCompleteness)
    : undefined
  const crossInstanceCollisionRate = multiPet
    ? clamp(metrics.petCrossInstanceCollisionRate)
    : undefined
  const collisionFreedom = crossInstanceCollisionRate === undefined
    ? undefined
    : 1 - crossInstanceCollisionRate
  const silhouetteParts = [score.silhouette]
  const identityParts = [
    score.identity,
    score.identityAppearance ?? score.identity,
    metrics.hardFeatureCompleteness,
  ]
  const contourParts = [score.structure, metrics.planBoundaryAgreement, metrics.sourceBoundaryAgreement]
  const thinParts = [
    metrics.featureConnectivity,
    metrics.shapeApplied ? metrics.silhouetteBoundaryIoU : score.structure,
  ]
  if (petPoseAvailable) {
    silhouetteParts.push(metrics.petBoundaryRhythm ?? score.poseStructure, frontChest, negativeSpace)
    identityParts.push(earStructure, muzzleStructure)
    contourParts.push(metrics.petBoundaryRhythm ?? score.structure, frontChest)
    thinParts.push(
      metrics.petSkeletonContinuity ?? score.structure,
      negativeSpace,
      metrics.petBoundaryRhythm ?? score.structure,
      earStructure,
      muzzleStructure,
      1 - frontVerticalRunRatio,
    )
  }
  if (multiPet) {
    silhouetteParts.push(subjectComponentRecall, collisionFreedom)
    identityParts.push(weakestInstanceIdentityCompleteness, collisionFreedom)
    thinParts.push(
      subjectComponentRecall,
      weakestInstanceIdentityCompleteness,
      collisionFreedom,
    )
  }
  return {
    silhouette: mean(silhouetteParts),
    identityFeatures: mean(identityParts),
    composition: clamp(score.canvasFit),
    valueOrder: clamp(metrics.valueOrderAccuracy),
    colorFidelity: clamp(score.colorFidelity),
    pixelClusters: mean([score.cleanliness, 1 - clusterPenalty]),
    contourRhythm: mean(contourParts),
    thinStructure: mean(thinParts),
    boundaryAnchors: mean([metrics.hardFeatureCompleteness, score.featureProtection]),
    ...(petPoseAvailable ? {
      earStructure,
      muzzleStructure,
      frontVerticalRunRatio,
      negativeSpace,
    } : {}),
    ...(multiPet ? {
      subjectComponentRecall,
      weakestInstanceIdentityCompleteness,
      crossInstanceCollisionRate,
    } : {}),
    material: clamp(metrics.paletteRoleConsistency),
    styleFit: clamp(1 - metrics.artDirectionBudgetViolations / cellCount),
    craftEase: clamp(score.craftEase),
  }
}

export function preferenceCandidateFromPattern(id, candidate, route = 'deterministic') {
  return {
    id,
    route,
    valid: candidate.valid ?? true,
    rejectionReasons: [...(candidate.rejectionReasons ?? [])],
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
    ...(candidate.canvasPlan === undefined ? {} : { canvasPlan: candidate.canvasPlan }),
  }
}
