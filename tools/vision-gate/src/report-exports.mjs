function csv(value) {
  const source = value === undefined || value === null ? '' : String(value)
  return /[",\r\n]/.test(source) ? `"${source.replaceAll('"', '""')}"` : source
}

function rows(header, values) {
  return `${[header, ...values.map((row) => row.map(csv).join(','))].join('\n')}\n`
}

export function renderSampleBreakdownCsv(summary) {
  return rows('imageId,challengeTags,selectionStatus,eyesWithinThreshold,mouthWithinThreshold,faceContainment,hairDice,clothesDice',
    summary.results.map((result) => [
      result.imageId,
      result.challengeTags.join('|'),
      result.selectionStatus,
      result.landmarks['left-eye-center'].withinThreshold
        && result.landmarks['right-eye-center'].withinThreshold,
      result.landmarks['mouth-center'].withinThreshold,
      result.regions['face-skin'].containment,
      result.regions.hair.dice,
      result.regions.clothes.dice,
    ]))
}

export function renderLandmarkErrorsCsv(summary) {
  return rows('imageId,landmarkId,kind,errorCells,thresholdCells,confidence,withinThreshold,highConfidenceMismatch',
    summary.results.flatMap((result) => Object.values(result.landmarks).map((entry) => [
      result.imageId,
      entry.id,
      entry.kind,
      Number.isFinite(entry.errorCells) ? entry.errorCells : 'Infinity',
      entry.thresholdCells,
      entry.confidence,
      entry.withinThreshold,
      entry.highConfidenceMismatch,
    ])))
}

export function renderRegionOverlapCsv(summary) {
  return rows('imageId,regionId,containment,dice,intersectionCells',
    summary.results.flatMap((result) => Object.values(result.regions).map((entry) => [
      result.imageId,
      entry.id,
      entry.containment,
      entry.dice,
      entry.intersection,
    ])))
}

export function renderCalibrationBinsCsv(summary) {
  return rows('lowerBound,upperBound,count,averageConfidence,accuracy',
    summary.confidenceCalibration.bins.map((bin) => [
      bin.lowerBound,
      bin.upperBound,
      bin.count,
      bin.averageConfidence,
      bin.accuracy,
    ]))
}
