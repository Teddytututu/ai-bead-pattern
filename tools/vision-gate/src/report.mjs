import {
  validateVisionGateManifest,
  validateVisionGatePrediction,
} from './schema.mjs'
import { evaluateVisionGateSample } from './metrics.mjs'

export const defaultVisionGateThresholds = Object.freeze({
  minimumSamples: 30,
  eyeWithinOneCellRate: 0.9,
  mouthWithinOneAndHalfCellsRate: 0.9,
  faceContainmentMinimum: 0.85,
  faceContainmentSampleRate: 0.9,
  semanticDiceMinimum: 0.5,
  hairReasonableSampleRate: 0.8,
  clothesReasonableSampleRate: 0.8,
  highConfidenceHardMismatchRate: 0.02,
})

function rate(count, total) {
  return total === 0 ? null : count / total
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}

function calibration(landmarks, bins = 10) {
  const output = Array.from({ length: bins }, (_, index) => ({
    lowerBound: index / bins,
    upperBound: (index + 1) / bins,
    count: 0,
    confidenceTotal: 0,
    correctCount: 0,
  }))
  for (const landmark of landmarks) {
    const index = Math.min(bins - 1, Math.floor(landmark.confidence * bins))
    const bin = output[index]
    bin.count += 1
    bin.confidenceTotal += landmark.confidence
    if (landmark.withinThreshold) bin.correctCount += 1
  }
  const total = landmarks.length
  const binsWithMetrics = output.map((bin) => ({
    lowerBound: bin.lowerBound,
    upperBound: bin.upperBound,
    count: bin.count,
    averageConfidence: bin.count === 0 ? null : bin.confidenceTotal / bin.count,
    accuracy: bin.count === 0 ? null : bin.correctCount / bin.count,
  }))
  const expectedCalibrationError = binsWithMetrics.reduce((sum, bin) =>
    bin.count === 0
      ? sum
      : sum + (bin.count / total) * Math.abs(bin.averageConfidence - bin.accuracy), 0)
  const brierScore = mean(landmarks.map((entry) =>
    (entry.confidence - Number(entry.withinThreshold)) ** 2))
  return { bins: binsWithMetrics, expectedCalibrationError, brierScore }
}

export function summarizeVisionGate(
  inputManifest,
  inputPredictions,
  thresholds = defaultVisionGateThresholds,
) {
  const manifest = validateVisionGateManifest(inputManifest)
  const predictions = inputPredictions.map(validateVisionGatePrediction)
  const predictionsById = new Map()
  for (const prediction of predictions) {
    if (prediction.datasetId !== manifest.datasetId) {
      throw new RangeError(`Prediction ${prediction.imageId} datasetId differs from the manifest`)
    }
    if (predictionsById.has(prediction.imageId)) {
      throw new RangeError(`Duplicate Vision Gate prediction: ${prediction.imageId}`)
    }
    predictionsById.set(prediction.imageId, prediction)
  }
  const results = manifest.samples.map((sample) => {
    const prediction = predictionsById.get(sample.imageId)
    if (prediction === undefined) throw new RangeError(`Missing Vision Gate prediction: ${sample.imageId}`)
    return evaluateVisionGateSample(sample, prediction, manifest.gridSize)
  })
  if (predictionsById.size !== manifest.samples.length) {
    throw new RangeError('Vision Gate predictions contain samples outside the manifest')
  }
  const landmarkRows = results.flatMap((result) => Object.values(result.landmarks)
    .map((landmark) => ({ imageId: result.imageId, ...landmark })))
  const eyes = landmarkRows.filter((entry) => entry.kind === 'eye')
  const mouths = landmarkRows.filter((entry) => entry.kind === 'mouth')
  const highConfidence = landmarkRows.filter((entry) => entry.confidence >= 0.9)
  const faceReasonable = results.filter((entry) =>
    entry.regions['face-skin'].containment >= thresholds.faceContainmentMinimum)
  const hairReasonable = results.filter((entry) =>
    entry.regions.hair.dice >= thresholds.semanticDiceMinimum)
  const clothesReasonable = results.filter((entry) =>
    entry.regions.clothes.dice >= thresholds.semanticDiceMinimum)
  const eyeWithinOneCellRate = rate(eyes.filter((entry) => entry.withinThreshold).length, eyes.length)
  const mouthWithinOneAndHalfCellsRate = rate(
    mouths.filter((entry) => entry.withinThreshold).length,
    mouths.length,
  )
  const faceContainmentSampleRate = rate(faceReasonable.length, results.length)
  const hairReasonableSampleRate = rate(hairReasonable.length, results.length)
  const clothesReasonableSampleRate = rate(clothesReasonable.length, results.length)
  const highConfidenceHardMismatchRate = rate(
    highConfidence.filter((entry) => entry.highConfidenceMismatch).length,
    highConfidence.length,
  )
  const confidenceCalibration = calibration(landmarkRows)
  const criteria = {
    sampleCoverage: results.length >= thresholds.minimumSamples,
    eyes: eyeWithinOneCellRate >= thresholds.eyeWithinOneCellRate,
    mouth: mouthWithinOneAndHalfCellsRate >= thresholds.mouthWithinOneAndHalfCellsRate,
    faceContainment: faceContainmentSampleRate >= thresholds.faceContainmentSampleRate,
    hair: hairReasonableSampleRate >= thresholds.hairReasonableSampleRate,
    clothes: clothesReasonableSampleRate >= thresholds.clothesReasonableSampleRate,
    confidence: highConfidenceHardMismatchRate !== null
      && highConfidenceHardMismatchRate <= thresholds.highConfidenceHardMismatchRate,
  }
  return {
    schemaVersion: 1,
    protocolVersion: manifest.protocolVersion,
    datasetId: manifest.datasetId,
    gridSize: manifest.gridSize,
    sampleCount: results.length,
    primarySelectionCount: results.filter((entry) => entry.selectionStatus === 'primary').length,
    ambiguousSelectionCount: results.filter((entry) => entry.selectionStatus === 'ambiguous').length,
    missingSelectionCount: results.filter((entry) => entry.selectionStatus === 'none').length,
    errorSelectionCount: results.filter((entry) => entry.selectionStatus === 'error').length,
    eyeWithinOneCellRate,
    mouthWithinOneAndHalfCellsRate,
    faceContainmentSampleRate,
    hairReasonableSampleRate,
    clothesReasonableSampleRate,
    highConfidenceHardMismatchRate,
    confidenceCalibration,
    criteria,
    thresholds,
    results,
    passed: Object.values(criteria).every(Boolean),
  }
}

function percent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`
}

function criterion(value) {
  return value ? 'PASS' : 'FAIL'
}

export function renderVisionGateReport(summary) {
  return `# Portrait Vision Gate\n\n`
    + `Result: **${summary.passed ? 'PASS' : 'FAIL'}**\n\n`
    + `Samples: ${summary.sampleCount}; primary: ${summary.primarySelectionCount}; ambiguous: ${summary.ambiguousSelectionCount}; missing: ${summary.missingSelectionCount}; errors: ${summary.errorSelectionCount}.\n\n`
    + `| Criterion | Result | Observed | Target |\n`
    + `| --- | --- | ---: | ---: |\n`
    + `| Sample coverage | ${criterion(summary.criteria.sampleCoverage)} | ${summary.sampleCount} | >= ${summary.thresholds.minimumSamples} |\n`
    + `| Eye centers within 1 cell | ${criterion(summary.criteria.eyes)} | ${percent(summary.eyeWithinOneCellRate)} | >= ${percent(summary.thresholds.eyeWithinOneCellRate)} |\n`
    + `| Mouth center within 1.5 cells | ${criterion(summary.criteria.mouth)} | ${percent(summary.mouthWithinOneAndHalfCellsRate)} | >= ${percent(summary.thresholds.mouthWithinOneAndHalfCellsRate)} |\n`
    + `| Face containment | ${criterion(summary.criteria.faceContainment)} | ${percent(summary.faceContainmentSampleRate)} | >= ${percent(summary.thresholds.faceContainmentSampleRate)} |\n`
    + `| Hair overlap | ${criterion(summary.criteria.hair)} | ${percent(summary.hairReasonableSampleRate)} | >= ${percent(summary.thresholds.hairReasonableSampleRate)} |\n`
    + `| Clothes overlap | ${criterion(summary.criteria.clothes)} | ${percent(summary.clothesReasonableSampleRate)} | >= ${percent(summary.thresholds.clothesReasonableSampleRate)} |\n`
    + `| High-confidence hard mismatch | ${criterion(summary.criteria.confidence)} | ${percent(summary.highConfidenceHardMismatchRate)} | <= ${percent(summary.thresholds.highConfidenceHardMismatchRate)} |\n\n`
    + `Calibration ECE: ${percent(summary.confidenceCalibration.expectedCalibrationError)}; Brier score: ${summary.confidenceCalibration.brierScore?.toFixed(4) ?? 'n/a'}.\n`
}
