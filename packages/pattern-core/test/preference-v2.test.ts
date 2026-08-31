import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  BASELINE_PREFERENCE_WEIGHTS,
  comparePreferenceModels,
  createFrozenPreferenceSplit,
  deduplicatePreferenceRecords,
  derivePreferenceGenerationParameters,
  fitPreferenceModelV2,
  migratePairwisePreferenceRecord,
  normalizePreferenceRecordV2,
  preferenceRecordFromWorkbenchSession,
  preferenceRecordFingerprint,
  rankPreferenceCandidates,
  replayPreferenceRecord,
  selectActivePreferencePair,
  selectPreferenceModelVersion,
  validatePreferenceRecordV2,
  type PreferenceCandidateV2,
  type PreferenceRecordV2,
} from '../src/preference-v2.js'

function candidate(
  id: string,
  features: Partial<PreferenceCandidateV2['features']> = {},
): PreferenceCandidateV2 {
  return {
    id,
    route: 'deterministic',
    style: 'faithful',
    paletteId: 'perler-standard',
    grid: { width: 32, height: 32 },
    features: {
      silhouette: 0.7,
      identityFeatures: 0.7,
      composition: 0.7,
      valueOrder: 0.7,
      colorFidelity: 0.7,
      pixelClusters: 0.7,
      contourRhythm: 0.7,
      thinStructure: 0.7,
      boundaryAnchors: 0.7,
      material: 0.7,
      styleFit: 0.7,
      craftEase: 0.7,
      ...features,
    },
  }
}

function record(
  id: string,
  sourceId: string,
  first: PreferenceCandidateV2,
  second: PreferenceCandidateV2,
  choice: 'a' | 'b' | 'tie' = 'a',
  overrides: Partial<PreferenceRecordV2> = {},
): PreferenceRecordV2 {
  return {
    schemaVersion: 2,
    id,
    generationId: `generation-${sourceId}`,
    source: {
      id: sourceId,
      groupId: sourceId,
      subjectKind: 'person',
    },
    candidates: [first, second],
    annotator: { anonymousId: 'anon-7' },
    axisScores: {
      [first.id]: {
        subjectRecognition: 5,
        silhouette: 5,
        identityFeatures: 5,
        composition: 4,
        valueHierarchy: 4,
        palette: 4,
        contourRhythm: 4,
        pixelClusters: 4,
        material: 3,
        styleFit: 4,
        craftEase: 4,
      },
      [second.id]: {
        subjectRecognition: 2,
        silhouette: 2,
        identityFeatures: 2,
        composition: 3,
        valueHierarchy: 3,
        palette: 3,
        contourRhythm: 3,
        pixelClusters: 2,
        material: 3,
        styleFit: 3,
        craftEase: 3,
      },
    },
    issueAnnotations: [],
    comparisons: [{ candidateAId: first.id, candidateBId: second.id, choice }],
    ranking: [first.id, second.id],
    bestCandidateId: first.id,
    eliminations: [],
    createdAt: '2026-08-31T08:00:00.000Z',
    updatedAt: '2026-08-31T08:00:00.000Z',
    ...overrides,
  }
}

describe('PreferenceRecord V2 contract', () => {
  it('normalizes candidate, annotation, comparison, and score order for stable replay', () => {
    const a = candidate('a')
    const b = candidate('b')
    const input = record('r-1', 'source-1', b, a, 'b', {
      issueAnnotations: [{
        id: 'issue-2',
        candidateId: 'b',
        issue: 'thin-structure-collapse',
        severity: 4,
        confidence: 0.9,
        cells: [{ x: 3, y: 2 }, { x: 1, y: 1 }],
      }, {
        id: 'issue-1',
        candidateId: 'a',
        issue: 'isolated-cell',
        severity: 2,
        confidence: 0.7,
      }],
    })

    const normalized = normalizePreferenceRecordV2(input)
    const replayed = replayPreferenceRecord(JSON.stringify(input))

    assert.deepEqual(normalized.candidates.map((entry) => entry.id), ['a', 'b'])
    assert.deepEqual(normalized.issueAnnotations.map((entry) => entry.id), ['issue-1', 'issue-2'])
    assert.deepEqual(normalized.issueAnnotations[1]!.cells, [{ x: 1, y: 1 }, { x: 3, y: 2 }])
    assert.deepEqual(replayed.record, normalized)
    assert.equal(replayed.canonicalJson, JSON.stringify(normalized))
    assert.equal(replayed.fingerprint, preferenceRecordFingerprint(input))
  })

  it('rejects unknown candidates, invalid cells, incomplete scores, and unstable timestamps', () => {
    const a = candidate('a')
    const b = candidate('b')
    const valid = record('r-1', 'source-1', a, b)

    assert.throws(() => validatePreferenceRecordV2({
      ...valid,
      comparisons: [{ candidateAId: 'a', candidateBId: 'missing', choice: 'a' }],
    }), /unknown candidate/i)
    assert.throws(() => validatePreferenceRecordV2({
      ...valid,
      issueAnnotations: [{
        id: 'bad-cell',
        candidateId: 'a',
        issue: 'isolated-cell',
        severity: 3,
        confidence: 1,
        cells: [{ x: 32, y: 0 }],
      }],
    }), /grid/i)
    assert.throws(() => validatePreferenceRecordV2({
      ...valid,
      axisScores: { a: valid.axisScores.a! },
    }), /axis scores/i)
    assert.throws(() => validatePreferenceRecordV2({
      ...valid,
      updatedAt: '2026-08-30T08:00:00.000Z',
    }), /timestamp/i)
    assert.throws(() => validatePreferenceRecordV2({
      ...valid,
      ranking: ['a'],
    }), /ranking.*every candidate/i)
    assert.throws(() => validatePreferenceRecordV2({
      ...valid,
      ranking: ['b', 'a'],
      bestCandidateId: 'a',
    }), /best candidate.*ranking/i)
  })

  it('deduplicates semantic replays and migrates V1 comparisons', () => {
    const a = candidate('a')
    const b = candidate('b')
    const first = record('r-1', 'source-1', a, b)
    const duplicate = { ...first, id: 'r-2', updatedAt: '2026-08-31T09:00:00.000Z' }
    const migrated = migratePairwisePreferenceRecord({
      id: 'legacy-1',
      sourceId: 'source-legacy',
      raterId: 'anon-legacy',
      candidateAId: 'a',
      candidateBId: 'b',
      choice: 'tie',
    }, {
      generationId: 'generation-legacy',
      source: { id: 'source-legacy', subjectKind: 'object' },
      candidates: [a, b],
      timestamp: '2026-08-31T08:00:00.000Z',
    })

    assert.equal(deduplicatePreferenceRecords([duplicate, first]).length, 1)
    assert.equal(migrated.schemaVersion, 2)
    assert.equal(migrated.comparisons[0]!.choice, 'tie')
    assert.equal(migrated.source.subjectKind, 'object')
    validatePreferenceRecordV2(migrated)
  })

  it('converts the browser workbench session into a replayable V2 record', () => {
    const session = {
      schemaVersion: 'preference-session-v2',
      generationId: 'generation-ui',
      source: { id: 'portrait.png', kind: 'portrait', groupId: 'person-7' },
      annotatorId: 'anonymous-ui',
      candidates: {
        a: {
          id: 'a',
          style: 'faithful',
          pattern: { width: 32, height: 32 },
          source: { route: 'learned-pixelization', model: 'pixel-model', version: '1.2' },
          palette: { id: 'perler-standard' },
          metrics: {
            silhouetteBoundaryIoU: 0.9,
            featureCoverage: 0.95,
            featurePurity: 0.9,
            featureConnectivity: 0.85,
            valueOrderAccuracy: 0.9,
            meanColorDistance: 5,
            isolatedCells: 1,
            thinStripes: 2,
            totalBeads: 500,
            uniqueColors: 12,
          },
        },
        b: {
          id: 'b',
          style: 'simple',
          pattern: { width: 32, height: 32 },
          source: { route: 'deterministic', model: 'pattern-core', version: '0.7' },
          palette: { id: 'perler-standard' },
          metrics: {},
        },
      },
      candidateOrder: ['a', 'b'],
      axisScores: {
        a: { recognition: 5, silhouette: 5, identity: 5, composition: 4, value: 4,
          palette: 4, contour: 4, cluster: 4, material: 3, style: 4, craft: 4 },
        b: { recognition: 2, silhouette: 2, identity: 2, composition: 3, value: 3,
          palette: 3, contour: 3, cluster: 2, material: 3, style: 3, craft: 3 },
      },
      annotations: [{
        id: 'issue-ui',
        candidateId: 'a',
        tag: 'marking-loss',
        severity: 3,
        confidence: 0.9,
        note: 'ear marking',
        region: { x: 0.5, y: 0.25, width: 0.25, height: 0.5 },
        cells: [{ x: 18, y: 10 }],
      }],
      comparisons: [{ id: 'compare-ui', candidateIds: ['a', 'b'], choice: 'first' }],
      ranking: {
        order: ['a', 'b'],
        bestCandidateId: 'a',
        eliminated: [{ candidateId: 'b', reasons: ['identity loss'] }],
        compositeCandidateIds: [],
      },
      createdAt: 1_788_134_400_000,
      updatedAt: 1_788_134_460_000,
    }

    const converted = preferenceRecordFromWorkbenchSession(session)

    assert.equal(converted.source.subjectKind, 'person')
    assert.equal(converted.source.groupId, 'person-7')
    assert.equal(converted.candidates[0]!.route, 'learned-pixelization')
    assert.equal(converted.candidates[0]!.model?.name, 'pixel-model')
    assert.ok(converted.candidates[0]!.features.identityFeatures > 0.8)
    assert.equal(converted.axisScores.a!.subjectRecognition, 5)
    assert.equal(converted.issueAnnotations[0]!.issue, 'marking-loss')
    assert.equal(converted.issueAnnotations[0]!.severity, 5)
    assert.deepEqual(converted.issueAnnotations[0]!.region, { x: 16, y: 8, width: 8, height: 16 })
    assert.equal(converted.comparisons[0]!.choice, 'a')
    assert.equal(converted.bestCandidateId, 'a')
    assert.equal(converted.createdAt, '2026-08-31T00:00:00.000Z')
    validatePreferenceRecordV2(converted)
  })
})

describe('preference learning and bounded generation feedback', () => {
  it('learns multidimensional ranking and tag-conditioned weights', () => {
    const strong = candidate('strong', {
      identityFeatures: 0.95,
      thinStructure: 0.95,
      boundaryAnchors: 0.9,
      valueOrder: 0.9,
      pixelClusters: 0.9,
    })
    const weak = candidate('weak', {
      identityFeatures: 0.2,
      thinStructure: 0.15,
      boundaryAnchors: 0.2,
      valueOrder: 0.25,
      pixelClusters: 0.2,
    })
    const records = Array.from({ length: 12 }, (_, index) => record(
      `r-${index}`,
      `source-${index}`,
      strong,
      weak,
      'a',
      {
        issueAnnotations: [{
          id: `issue-${index}`,
          candidateId: 'weak',
          issue: index % 2 === 0 ? 'thin-structure-collapse' : 'facial-feature-loss',
          severity: 5,
          confidence: 1,
        }],
      },
    ))

    const model = fitPreferenceModelV2(records, { minimumStratumSamples: 4 })
    const ranking = rankPreferenceCandidates([weak, strong], model, {
      subjectKind: 'person',
      grid: { width: 32, height: 32 },
      style: 'faithful',
      paletteId: 'perler-standard',
    })

    assert.equal(ranking.rankedCandidateIds[0], 'strong')
    assert.ok(model.learnedWeights.identityFeatures > BASELINE_PREFERENCE_WEIGHTS.identityFeatures)
    assert.ok(model.learnedWeights.thinStructure > BASELINE_PREFERENCE_WEIGHTS.thinStructure)
    assert.ok(model.learnedWeights.boundaryAnchors > BASELINE_PREFERENCE_WEIGHTS.boundaryAnchors)
    assert.ok(model.generationAdjustments.featureProtection > 1)
    assert.ok(model.generationAdjustments.thinStructure > 1)
    assert.ok(model.generationAdjustments.boundaryAnchor > 1)
    assert.ok(model.generationAdjustments.featureProtection <= 1.5)
    assert.ok(model.confidenceIntervals.identityFeatures!.lower <= model.learnedWeights.identityFeatures)
    assert.ok(model.strata['subject:person']!.sampleCount >= 4)
  })

  it('maps value, refinement, and craft labels to bounded controls', () => {
    const a = candidate('a')
    const b = candidate('b')
    const issues: PreferenceRecordV2['issueAnnotations'] = [
      ['value-confusion', 'a'],
      ['jagged-contour', 'a'],
      ['isolated-cell', 'a'],
      ['craft-complexity', 'a'],
    ].map(([issue, candidateId], index) => ({
      id: `issue-${index}`,
      candidateId: candidateId!,
      issue: issue as PreferenceRecordV2['issueAnnotations'][number]['issue'],
      severity: 5,
      confidence: 1,
    }))
    const model = fitPreferenceModelV2([record('r-1', 'source-1', a, b, 'tie', {
      issueAnnotations: issues,
    })])

    assert.ok(model.generationAdjustments.valueOrder > 1)
    assert.ok(model.generationAdjustments.refinement > 1)
    assert.ok(model.generationAdjustments.craftCost > 1)
    for (const value of Object.values(model.generationAdjustments)) {
      assert.ok(value >= 0.75 && value <= 1.5)
    }
    const parameters = derivePreferenceGenerationParameters(model, {
      importanceStrength: 1,
      edgeStrength: 1,
      edgeProtection: 1,
      isolatedPixelPenalty: 1,
      stripePenalty: 1,
      valueOrderStrength: 1,
      localSearchIterations: 3,
      maxColorsScale: 1,
    })
    assert.ok(parameters.importanceStrength >= 1)
    assert.ok(parameters.edgeProtection >= 1)
    assert.ok(parameters.isolatedPixelPenalty > 1)
    assert.ok(parameters.stripePenalty > 1)
    assert.ok(parameters.localSearchIterations > 3)
    assert.ok(parameters.maxColorsScale < 1)
    assert.ok(parameters.importanceStrength <= 2)
    assert.ok(parameters.edgeProtection <= 4)
    assert.ok(parameters.localSearchIterations <= 12)
    assert.ok(parameters.maxColorsScale >= 0.6)
  })

  it('learns from multidimensional scores before a pairwise choice is submitted', () => {
    const clear = candidate('clear', { silhouette: 0.95, identityFeatures: 0.9 })
    const vague = candidate('vague', { silhouette: 0.2, identityFeatures: 0.25 })
    const withChoice = record('score-only', 'source-score-only', clear, vague, 'tie')
    const { ranking: _ranking, bestCandidateId: _best, ...scoreOnlyBase } = withChoice
    const scoreOnly: PreferenceRecordV2 = { ...scoreOnlyBase, comparisons: [] }

    const model = fitPreferenceModelV2([scoreOnly])
    const ranking = rankPreferenceCandidates([vague, clear], model, {
      subjectKind: 'person',
      grid: { width: 32, height: 32 },
      style: 'faithful',
      paletteId: 'perler-standard',
    })

    assert.equal(model.comparisonCount, 0)
    assert.equal(ranking.rankedCandidateIds[0], 'clear')
    assert.ok(model.learnedWeights.identityFeatures > 0)
  })
})

describe('active sampling and frozen evaluation', () => {
  it('selects an uncertain, high-disagreement, coverage-scarce pair deterministically', () => {
    const model = fitPreferenceModelV2([])
    const candidates = [
      candidate('a', { silhouette: 0.95, identityFeatures: 0.3 }),
      candidate('b', { silhouette: 0.3, identityFeatures: 0.95 }),
      candidate('c', { silhouette: 0.9, identityFeatures: 0.9 }),
    ]
    const context = {
      subjectKind: 'pet' as const,
      grid: { width: 48, height: 48 },
      style: 'cute' as const,
      paletteId: 'perler-standard',
    }
    const first = selectActivePreferencePair(candidates, model, {
      context,
      comparedPairs: [{ candidateAId: 'a', candidateBId: 'c', count: 4 }],
      issueCoverage: { 'pattern-loss': 0 },
    })
    const second = selectActivePreferencePair([...candidates].reverse(), model, {
      context,
      comparedPairs: [{ candidateAId: 'a', candidateBId: 'c', count: 4 }],
      issueCoverage: { 'pattern-loss': 0 },
    })

    assert.deepEqual(first, second)
    assert.deepEqual([first.candidateAId, first.candidateBId], ['a', 'b'])
    assert.ok(first.uncertainty >= 0 && first.uncertainty <= 1)
    assert.ok(first.priority > 0)
  })

  it('freezes source groups across train, validation, and holdout', () => {
    const a = candidate('a')
    const b = candidate('b')
    const records = [
      record('r-1', 'source-a', a, b),
      record('r-2', 'source-a-frame-2', a, b, 'a', {
        source: { id: 'source-a-frame-2', groupId: 'sequence-a', subjectKind: 'person' },
      }),
      record('r-3', 'source-a-frame-3', a, b, 'a', {
        source: { id: 'source-a-frame-3', groupId: 'sequence-a', subjectKind: 'person' },
      }),
      ...Array.from({ length: 17 }, (_, index) => record(`r-${index + 4}`, `source-${index + 4}`, a, b)),
    ]
    const split = createFrozenPreferenceSplit(records, { seed: 'frozen-v1' })
    const repeated = createFrozenPreferenceSplit([...records].reverse(), { seed: 'frozen-v1' })

    assert.deepEqual(split, repeated)
    const owner = (id: string) => Object.entries(split.recordIds).find(([, ids]) => ids.includes(id))?.[0]
    assert.equal(owner('r-2'), owner('r-3'))
    assert.ok(split.recordIds.train.length > split.recordIds.validation.length)
    assert.ok(split.recordIds.holdout.length > 0)

    const minimal = createFrozenPreferenceSplit([
      record('minimal-1', 'minimal-source-1', a, b),
      record('minimal-2', 'minimal-source-2', a, b),
      record('minimal-3', 'minimal-source-3', a, b),
    ], { seed: 'minimal-frozen-v1' })
    assert.ok(minimal.recordIds.train.length > 0)
    assert.ok(minimal.recordIds.validation.length > 0)
    assert.ok(minimal.recordIds.holdout.length > 0)
  })

  it('compares a challenger on holdout and rolls back weak or undersampled versions', () => {
    const good = candidate('good', { identityFeatures: 0.95, silhouette: 0.95 })
    const bad = candidate('bad', { identityFeatures: 0.1, silhouette: 0.1 })
    const records = Array.from({ length: 24 }, (_, index) => record(
      `r-${index}`,
      `source-${index}`,
      good,
      bad,
      'a',
    ))
    const split = createFrozenPreferenceSplit(records, { seed: 'evaluation-v1' })
    const trainingRecords = records.filter((entry) => split.recordIds.train.includes(entry.id))
    const holdoutRecords = records.filter((entry) => split.recordIds.holdout.includes(entry.id))
    const challenger = fitPreferenceModelV2(trainingRecords)
    const comparison = comparePreferenceModels(
      { ...challenger, version: 'baseline', learnedWeights: { ...BASELINE_PREFERENCE_WEIGHTS } },
      challenger,
      holdoutRecords,
    )
    const accepted = selectPreferenceModelVersion(
      { ...challenger, version: 'baseline', learnedWeights: { ...BASELINE_PREFERENCE_WEIGHTS } },
      challenger,
      comparison,
      { minimumTrainingSamples: 5, minimumAccuracyGain: 0, maximumLogLossRegression: 1 },
    )
    const rolledBack = selectPreferenceModelVersion(
      challenger,
      { ...challenger, version: 'tiny', sampleCount: 1 },
      comparison,
      { minimumTrainingSamples: 5, minimumAccuracyGain: 0 },
    )

    assert.ok(comparison.challenger.accuracy >= comparison.baseline.accuracy)
    assert.equal(accepted.selectedVersion, challenger.version, JSON.stringify({
      accepted,
      comparison,
      trainingSamples: trainingRecords.length,
      holdoutSamples: holdoutRecords.length,
    }))
    assert.equal(accepted.rolledBack, false)
    assert.equal(rolledBack.selectedVersion, challenger.version)
    assert.equal(rolledBack.rolledBack, true)
  })
})
