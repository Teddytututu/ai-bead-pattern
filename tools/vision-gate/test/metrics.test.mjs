import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createVisionGateProtocolFixtures,
  createVisionGateProtocolPredictions,
} from '../src/schema.mjs'
import { evaluateVisionGateSample } from '../src/metrics.mjs'
import { createVisionGatePredictionFromAnalysis } from '../src/prediction.mjs'

describe('Vision Gate metrics', () => {
  it('measures landmark error in 48-grid cells and region overlap', () => {
    const manifest = createVisionGateProtocolFixtures()
    const predictions = createVisionGateProtocolPredictions(manifest)
    const result = evaluateVisionGateSample(manifest.samples[0], predictions[0], manifest.gridSize)

    assert.equal(result.landmarks['left-eye-center'].errorCells, 0)
    assert.equal(result.landmarks['right-eye-center'].withinThreshold, true)
    assert.equal(result.landmarks['mouth-center'].withinThreshold, true)
    assert.equal(result.regions['face-skin'].containment, 1)
    assert.equal(result.regions.hair.dice, 1)
    assert.equal(result.regions.clothes.dice, 1)
  })

  it('marks a high-confidence eye outside one grid cell as a hard mismatch', () => {
    const manifest = createVisionGateProtocolFixtures()
    const prediction = createVisionGateProtocolPredictions(manifest)[0]
    prediction.landmarks.find((entry) => entry.id === 'left-eye-center').x += 2 / 48
    const result = evaluateVisionGateSample(manifest.samples[0], prediction, manifest.gridSize)

    assert.equal(result.landmarks['left-eye-center'].withinThreshold, false)
    assert.equal(result.landmarks['left-eye-center'].highConfidenceMismatch, true)
  })

  it('normalizes gateway pixel landmarks while retaining source-size semantic masks', () => {
    const prediction = createVisionGatePredictionFromAnalysis({
      datasetId: 'vision-gate-real-30',
      imageId: 'portrait-01',
      width: 200,
      height: 100,
      selectionStatus: 'primary',
      analysis: {
        landmarks: [
          { id: 'left-eye-center', x: 50, y: 25, confidence: 0.9 },
          { id: 'right-eye-center', x: 150, y: 25, confidence: 0.9 },
          { id: 'mouth-center', x: 100, y: 60, confidence: 0.8 },
        ],
        semanticRegions: [{
          id: 'face-skin',
          mask: { width: 2, height: 1, values: new Float32Array([1, 0]) },
        }],
        modelVersions: { faceLandmarks: 'mediapipe/v1' },
      },
    })

    assert.equal(prediction.landmarks[0].x, 0.25)
    assert.equal(prediction.landmarks[0].y, 0.25)
    assert.deepEqual([...prediction.regions['face-skin'].values], [1, 0])
  })

  it('area-averages semantic masks when source pixels straddle a grid cell', () => {
    const manifest = createVisionGateProtocolFixtures()
    const prediction = createVisionGateProtocolPredictions(manifest)[0]
    const reference = new Set(manifest.samples[0].annotations.regions['face-skin'].cells)
    const values = new Float32Array(96 * 48)
    for (let y = 0; y < 48; y += 1) {
      for (let x = 0; x < 48; x += 1) {
        if (reference.has(y * 48 + x)) values[y * 96 + x * 2] = 1
      }
    }
    prediction.regions['face-skin'] = { width: 96, height: 48, values }
    const result = evaluateVisionGateSample(manifest.samples[0], prediction, manifest.gridSize)

    assert.equal(result.regions['face-skin'].containment, 1)
  })
})
