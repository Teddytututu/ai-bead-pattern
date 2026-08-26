import {
  validateVisionGatePrediction,
  visionGateProtocolVersion,
} from './schema.mjs'

const landmarkIds = new Set(['left-eye-center', 'right-eye-center', 'mouth-center'])
const regionIds = new Set(['face-skin', 'hair', 'clothes'])

function positiveInteger(value, name) {
  if (Number.isInteger(value) === false || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`)
  }
  return value
}

export function createVisionGatePredictionFromAnalysis(input) {
  const width = positiveInteger(input.width, 'Vision Gate source width')
  const height = positiveInteger(input.height, 'Vision Gate source height')
  const primary = input.selectionStatus === 'primary'
  const analysis = input.analysis ?? {}
  const prediction = {
    schemaVersion: 1,
    protocolVersion: visionGateProtocolVersion,
    datasetId: input.datasetId,
    imageId: input.imageId,
    selectionStatus: input.selectionStatus,
    landmarks: primary
      ? (analysis.landmarks ?? []).filter((entry) => landmarkIds.has(entry.id)).map((entry) => ({
        id: entry.id,
        x: entry.x / width,
        y: entry.y / height,
        confidence: entry.confidence,
      }))
      : [],
    regions: primary
      ? Object.fromEntries((analysis.semanticRegions ?? [])
        .filter((entry) => regionIds.has(entry.id))
        .map((entry) => [entry.id, entry.mask]))
      : {},
    modelVersions: analysis.modelVersions ?? input.modelVersions ?? {},
  }
  return validateVisionGatePrediction(prediction)
}
