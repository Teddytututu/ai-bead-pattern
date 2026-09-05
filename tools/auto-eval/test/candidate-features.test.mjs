import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { candidateFeatureVector, preferenceCandidateFromPattern } from '../src/candidate-features.mjs'

function candidate(poseStructure, petStructure = {}) {
  return {
    pattern: { width: 48, height: 48 },
    score: {
      silhouette: 0.5,
      identity: 0.5,
      identityAppearance: 0.5,
      poseStructure,
      canvasFit: 0.7,
      colorFidelity: 0.6,
      cleanliness: 0.7,
      structure: 0.5,
      featureProtection: 0.55,
      craftEase: 0.65,
    },
    metrics: {
      valueOrderAccuracy: 0.7,
      planBoundaryAgreement: 0.5,
      sourceBoundaryAgreement: 0.5,
      featureConnectivity: 0.5,
      shapeApplied: true,
      silhouetteBoundaryIoU: 0.5,
      hardFeatureCompleteness: 0.6,
      paletteRoleConsistency: 0.7,
      artDirectionBudgetViolations: 0,
      petSkeletonContinuity: poseStructure,
      petNegativeSpace: petStructure.negativeSpace ?? poseStructure,
      petBoundaryRhythm: poseStructure,
      petFrontVerticalRunRatio: petStructure.frontVerticalRunRatio ?? 1 - poseStructure,
      petEarStructure: petStructure.earStructure ?? poseStructure,
      petMuzzleStructure: petStructure.muzzleStructure ?? poseStructure,
      petInstanceCount: petStructure.instanceCount ?? 1,
      petSubjectComponentRecall: petStructure.subjectComponentRecall ?? 1,
      petWeakestInstanceIdentityCompleteness:
        petStructure.weakestInstanceIdentityCompleteness ?? 1,
      petCrossInstanceCollisionRate: petStructure.crossInstanceCollisionRate ?? 0,
    },
  }
}

describe('automatic candidate feature extraction', () => {
  it('routes quadruped pose quality into identity, silhouette, and thin-structure learning axes', () => {
    const articulated = candidateFeatureVector(candidate(0.9))
    const fused = candidateFeatureVector(candidate(0.2))

    assert.ok(articulated.identityFeatures > fused.identityFeatures + 0.15)
    assert.ok(articulated.silhouette > fused.silhouette + 0.1)
    assert.ok(articulated.thinStructure > fused.thinStructure + 0.15)
  })

  it('exposes the pet structures that explain candidate recognition and collapse', () => {
    const features = candidateFeatureVector(candidate(0.62, {
      earStructure: 0.91,
      muzzleStructure: 0.83,
      frontVerticalRunRatio: 0.27,
      negativeSpace: 0.74,
    }))

    assert.equal(features.earStructure, 0.91)
    assert.equal(features.muzzleStructure, 0.83)
    assert.equal(features.frontVerticalRunRatio, 0.27)
    assert.equal(features.negativeSpace, 0.74)
  })

  it('uses independent ear, muzzle, chest, and negative-space evidence in learned axes', () => {
    const recognizable = candidateFeatureVector(candidate(0.62, {
      earStructure: 0.92,
      muzzleStructure: 0.88,
      frontVerticalRunRatio: 0.24,
      negativeSpace: 0.79,
    }))
    const collapsed = candidateFeatureVector(candidate(0.62, {
      earStructure: 0.12,
      muzzleStructure: 0.18,
      frontVerticalRunRatio: 0.91,
      negativeSpace: 0.08,
    }))

    assert.ok(recognizable.identityFeatures > collapsed.identityFeatures + 0.2)
    assert.ok(recognizable.silhouette > collapsed.silhouette + 0.15)
    assert.ok(recognizable.thinStructure > collapsed.thinStructure + 0.2)
  })

  it('exposes multi-pet recall and collision metrics and lowers the affected learning axes', () => {
    const retained = candidateFeatureVector(candidate(0.62, {
      instanceCount: 2,
      subjectComponentRecall: 0.94,
      weakestInstanceIdentityCompleteness: 0.9,
      crossInstanceCollisionRate: 0.02,
    }))
    const collapsed = candidateFeatureVector(candidate(0.62, {
      instanceCount: 2,
      subjectComponentRecall: 0.42,
      weakestInstanceIdentityCompleteness: 0.18,
      crossInstanceCollisionRate: 0.48,
    }))

    assert.equal(retained.subjectComponentRecall, 0.94)
    assert.equal(retained.weakestInstanceIdentityCompleteness, 0.9)
    assert.equal(retained.crossInstanceCollisionRate, 0.02)
    assert.ok(retained.silhouette > collapsed.silhouette + 0.1)
    assert.ok(retained.identityFeatures > collapsed.identityFeatures + 0.15)
    assert.ok(retained.thinStructure > collapsed.thinStructure + 0.15)
  })

  it('keeps single-pet learning axes stable when instance diagnostics are present', () => {
    const legacy = candidate(0.62)
    delete legacy.metrics.petInstanceCount
    delete legacy.metrics.petSubjectComponentRecall
    delete legacy.metrics.petWeakestInstanceIdentityCompleteness
    delete legacy.metrics.petCrossInstanceCollisionRate

    const before = candidateFeatureVector(legacy)
    const after = candidateFeatureVector(candidate(0.62, {
      instanceCount: 1,
      subjectComponentRecall: 0.25,
      weakestInstanceIdentityCompleteness: 0.2,
      crossInstanceCollisionRate: 0.6,
    }))

    assert.equal(after.silhouette, before.silhouette)
    assert.equal(after.identityFeatures, before.identityFeatures)
    assert.equal(after.thinStructure, before.thinStructure)
  })

  it('ignores unavailable pet-pose values in generic candidate features', () => {
    const unavailable = candidate(0.02, {
      earStructure: 0,
      muzzleStructure: 0,
      frontVerticalRunRatio: 1,
      negativeSpace: 0,
    })
    unavailable.metrics.petPoseAvailable = false
    const features = candidateFeatureVector(unavailable)

    assert.ok(Math.abs(features.silhouette - 0.5) < 1e-9)
    assert.ok(Math.abs(features.identityFeatures - (0.5 + 0.5 + 0.6) / 3) < 1e-9)
    assert.ok(Math.abs(features.contourRhythm - 0.5) < 1e-9)
    assert.ok(Math.abs(features.thinStructure - 0.5) < 1e-9)
    assert.equal(Object.hasOwn(features, 'earStructure'), false)
    assert.equal(Object.hasOwn(features, 'muzzleStructure'), false)
    assert.equal(Object.hasOwn(features, 'frontVerticalRunRatio'), false)
    assert.equal(Object.hasOwn(features, 'negativeSpace'), false)
  })

  it('keeps candidate validity and structural rejection reasons in the evaluation index', () => {
    const patternCandidate = {
      ...candidate(0.25),
      valid: false,
      rejectionReasons: ['pet-ear-structure', 'pet-front-column'],
      style: 'faithful',
      pattern: {
        width: 48,
        height: 48,
        palette: [{ id: 'black' }],
        metadata: { algorithmVersion: '0.7.0' },
      },
    }

    const extracted = preferenceCandidateFromPattern('candidate-a', patternCandidate)

    assert.equal(extracted.valid, false)
    assert.deepEqual(extracted.rejectionReasons, ['pet-ear-structure', 'pet-front-column'])
  })
})
