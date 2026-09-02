const preferenceRuntimeStorageKey = 'ai-bead-pattern.preference-records.v2'

function loadRecords(storage, core) {
  const encoded = storage?.getItem(preferenceRuntimeStorageKey)
  if (encoded === null || encoded === undefined) return []
  try {
    const parsed = JSON.parse(encoded)
    return Array.isArray(parsed) ? core.deduplicatePreferenceRecords(parsed) : []
  } catch {
    return []
  }
}

function saveRecords(storage, records) {
  storage?.setItem(preferenceRuntimeStorageKey, JSON.stringify(records))
}

function recordContext(record) {
  const candidate = record.candidates[0]
  return {
    subjectKind: record.source.subjectKind,
    grid: candidate.grid,
    style: candidate.style,
    paletteId: candidate.paletteId,
  }
}

function comparedPairs(record) {
  const counts = new Map()
  for (const comparison of record.comparisons) {
    const ids = [comparison.candidateAId, comparison.candidateBId].sort()
    const key = `${ids[0]}\u0000${ids[1]}`
    counts.set(key, { candidateAId: ids[0], candidateBId: ids[1], count: (counts.get(key)?.count ?? 0) + 1 })
  }
  return [...counts.values()]
}

function issueCoverage(records) {
  const counts = {}
  for (const record of records) {
    for (const annotation of record.issueAnnotations) {
      counts[annotation.issue] = (counts[annotation.issue] ?? 0) + 1
    }
  }
  const maximum = Math.max(1, ...Object.values(counts))
  return Object.fromEntries(Object.entries(counts).map(([issue, count]) => [issue, count / maximum]))
}

function feedbackBaseline(options) {
  return {
    importanceStrength: Math.max(0.25, options.structure?.importanceStrength ?? 1),
    edgeStrength: Math.max(0.25, options.structure?.edgeStrength ?? 1),
    edgeProtection: Math.max(0.25, options.optimization?.edgeProtection ?? 1),
    isolatedPixelPenalty: Math.max(0.25, options.optimization?.isolatedPixelPenalty ?? 1),
    stripePenalty: Math.max(0.25, options.optimization?.stripePenalty ?? 1),
    valueOrderStrength: 1,
    localSearchIterations: Math.max(1, options.optimization?.localSearchIterations ?? 2),
    maxColorsScale: 1,
  }
}

export function createPreferenceRuntime({ core, storage = globalThis.localStorage }) {
  let records = loadRecords(storage, core)
  let state

  function recordFromSession(session) {
    return core.preferenceRecordFromWorkbenchSession(session, {
      recordId: `workbench-${session.generationId}-${session.annotatorId}`,
    })
  }

  function buildState(record, evaluationEvidence = {}) {
    const split = core.createFrozenPreferenceSplit(records, { seed: 'preference-runtime-v1' })
    const train = records.filter((entry) => split.recordIds.train.includes(entry.id))
    const holdout = records.filter((entry) => split.recordIds.holdout.includes(entry.id))
    const baselineModel = core.fitPreferenceModelV2([])
    const challengerModel = core.fitPreferenceModelV2(train)
    const comparison = core.comparePreferenceModels(baselineModel, challengerModel, holdout)
    const selection = core.selectPreferenceModelVersion(
      baselineModel,
      challengerModel,
      comparison,
      { minimumTrainingSamples: 3, minimumAccuracyGain: 0, maximumLogLossRegression: 0.02 },
    )
    const selectedModel = selection.selectedVersion === challengerModel.version
      ? challengerModel
      : baselineModel
    const context = recordContext(record)
    const rule = core.rankPreferenceCandidates(record.candidates, baselineModel, context)
    const challenger = core.rankPreferenceCandidates(record.candidates, challengerModel, context)
    const selected = core.rankPreferenceCandidates(record.candidates, selectedModel, context)
    const activePair = core.selectActivePreferencePair(record.candidates, selectedModel, {
      context,
      comparedPairs: comparedPairs(record),
      issueCoverage: issueCoverage(records),
    })
    const generationParameters = core.derivePreferenceGenerationParameters(selectedModel)
    const providerContributions = evaluationEvidence.providerContributions ?? []
    const providerByModel = new Map(providerContributions.map((entry) => [entry.modelId, entry.providerId]))
    const neuralPreferenceFeatures = (evaluationEvidence.neuralPreferenceFeatures ?? []).map((entry) => ({
      ...entry,
      providerId: entry.providerId ?? providerByModel.get(entry.modelId) ?? entry.modelId,
    }))
    const candidateEvaluation = evaluationEvidence.ruleScores === undefined
      ? undefined
      : core.composeCandidateEvaluationV2({
        scores: evaluationEvidence.ruleScores,
        selectedPreferenceRanking: {
          rankedCandidateIds: selected.rankedCandidateIds,
          scores: Object.fromEntries(Object.entries(selected.scores)
            .map(([candidateId, candidateScore]) => [candidateId, candidateScore.total])),
          model: {
            name: selectedModel.model ?? 'preference-linear-v2',
            version: selectedModel.version,
          },
        },
        neuralPreferenceFeatures,
        providerContributions,
      })
    return {
      record,
      sampleCount: records.length,
      split,
      baselineModel,
      challengerModel,
      selectedModel,
      comparison,
      selection,
      ruleRanking: rule.rankedCandidateIds,
      learnedRanking: selected.rankedCandidateIds,
      learnedScores: selected.scores,
      challengerRanking: challenger.rankedCandidateIds,
      activePair,
      generationParameters,
      weightEntries: Object.entries(selectedModel.learnedWeights ?? {})
        .sort((first, second) => second[1] - first[1]),
      candidateEvaluation,
    }
  }

  function ingestSession(session, evaluationEvidence) {
    const record = recordFromSession(session)
    records = core.deduplicatePreferenceRecords([
      ...records.filter((entry) => entry.id !== record.id),
      record,
    ])
    saveRecords(storage, records)
    state = buildState(record, evaluationEvidence)
    return state
  }

  function applyGenerationOptions(input) {
    if (state === undefined) return structuredClone(input)
    const parameters = core.derivePreferenceGenerationParameters(
      state.selectedModel,
      feedbackBaseline(input),
    )
    return {
      ...input,
      maxColors: Math.max(2, Math.round(input.maxColors * parameters.maxColorsScale)),
      structure: {
        ...input.structure,
        importanceStrength: parameters.importanceStrength,
        edgeStrength: parameters.edgeStrength,
        valueOrderStrength: parameters.valueOrderStrength,
      },
      optimization: {
        ...input.optimization,
        isolatedPixelPenalty: parameters.isolatedPixelPenalty,
        stripePenalty: parameters.stripePenalty,
        edgeProtection: parameters.edgeProtection,
        localSearchIterations: parameters.localSearchIterations,
      },
    }
  }

  return {
    ingestSession,
    recordFromSession,
    applyGenerationOptions,
    getRecords: () => records,
    getState: () => state,
  }
}
