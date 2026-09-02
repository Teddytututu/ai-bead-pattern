import {
  derivePreferenceGenerationParameters,
  selectPreferenceModelVersion,
} from '@ai-bead-pattern/pattern-core'

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

export function toGenerationOptions(model, baseline) {
  const parameters = derivePreferenceGenerationParameters(model, {
    importanceStrength: baseline.structure?.importanceStrength ?? 1,
    edgeStrength: baseline.structure?.edgeStrength ?? 1,
    edgeProtection: baseline.optimization?.edgeProtection ?? 0.7,
    isolatedPixelPenalty: baseline.optimization?.isolatedPixelPenalty ?? 1,
    stripePenalty: baseline.optimization?.stripePenalty ?? 1,
    valueOrderStrength: baseline.structure?.valueOrderStrength ?? 1,
    localSearchIterations: baseline.optimization?.localSearchIterations ?? 3,
    maxColorsScale: 1,
  })
  return {
    ...structuredClone(baseline),
    maxColors: Math.round(clamp(
      baseline.maxColors * parameters.maxColorsScale,
      2,
      baseline.maxColors * 1.25,
    )),
    structure: {
      ...baseline.structure,
      importanceStrength: parameters.importanceStrength,
      edgeStrength: parameters.edgeStrength,
      valueOrderStrength: parameters.valueOrderStrength,
    },
    optimization: {
      ...baseline.optimization,
      edgeProtection: clamp(parameters.edgeProtection, 0.25, 1),
      isolatedPixelPenalty: parameters.isolatedPixelPenalty,
      stripePenalty: parameters.stripePenalty,
      localSearchIterations: parameters.localSearchIterations,
    },
  }
}

export function selectIteration({ baseline, challenger, comparison, selectionOptions }) {
  const selection = selectPreferenceModelVersion(
    baseline,
    challenger,
    comparison,
    selectionOptions ?? {
      minimumTrainingSamples: 20,
      minimumAccuracyGain: 0,
      maximumLogLossRegression: 0.01,
    },
  )
  return {
    baseline,
    challenger,
    comparison,
    selection,
    selectedModel: selection.selectedVersion === challenger.version ? challenger : baseline,
  }
}
