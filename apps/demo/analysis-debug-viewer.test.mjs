import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import {
  applyCorrectedSubjectEvidence,
  featureCellSourceRect,
  fitAnalysisDebugCanvas,
  resolveAnalysisDebugLayer,
} from './analysis-debug-viewer.mjs'

const aiEvidence = {
  mask: { width: 2, height: 2, values: new Float32Array([1, 1, 0, 0]) },
  confidence: 0.8,
  source: 'ai',
  revision: 'ai:mask',
  provenance: [{ origin: 'model', provider: 'rembg', model: 'birefnet', version: '1' }],
}

const correctedEvidence = {
  mask: { width: 2, height: 2, values: new Float32Array([1, 1, 1, 0]) },
  confidence: 1,
  source: 'ai+manual',
  revision: 'confirmed:mask',
  userConfirmed: true,
  provenance: [{ origin: 'manual', provider: 'mask-editor', version: '1' }],
}

const analysis = {
  subjectMaskEvidence: correctedEvidence,
  semanticRegions: [
    { id: 'face-skin', label: 'face-skin', mask: { width: 2, height: 2, values: new Float32Array([0, 1, 0, 0]) }, confidence: 0.9, importance: 1 },
    { id: 'body-skin', label: 'body-skin', mask: { width: 2, height: 2, values: new Float32Array([0, 0, 1, 0]) }, confidence: 0.7, importance: 0.7 },
    { id: 'hair', label: 'hair', mask: { width: 2, height: 2, values: new Float32Array([1, 0, 0, 0]) }, confidence: 0.85, importance: 0.9 },
  ],
  landmarks: [{
    id: 'left-eye-center',
    kind: 'eye',
    x: 1,
    y: 0.5,
    confidence: 0.95,
    priority: 'hard',
    sourceRadiusPx: 4,
    gridRadiusCells: 1,
    affectsOccupancy: false,
    provenance: [{ origin: 'model', provider: 'mediapipe-face-landmarker', model: 'face-landmarker', version: 'v1' }],
  }],
  modelVersions: {
    faceLandmarks: 'mediapipe/face-v1',
    portraitSemantics: 'mediapipe/semantic-v1',
  },
}

const featureCandidate = {
  canvasPlan: {
    size: { width: 48, height: 48 },
    crop: { x: 0, y: 0, width: 4, height: 2 },
  },
  featurePlacements: [{
    featureId: 'left-eye-center',
    kind: 'eye',
    templateId: 'eye-e1',
    center: [18, 24],
    occupiedCells: [24 * 48 + 18],
    roles: [{ cell: 24 * 48 + 18, role: 'eye-dark' }],
    shift: [0, 0],
    score: 0.95,
  }],
  pattern: { metadata: { algorithmVersion: 'feature-planning-v1' } },
}

describe('Analysis Debug Viewer layers', () => {
  it('separates original AI subject evidence from the confirmed correction', () => {
    const ai = resolveAnalysisDebugLayer('ai-subject', { analysis, originalSubjectEvidence: aiEvidence })
    const corrected = resolveAnalysisDebugLayer('corrected-subject', {
      analysis,
      originalSubjectEvidence: aiEvidence,
    })

    assert.equal(ai.available, true)
    assert.equal(ai.revision, 'ai:mask')
    assert.equal(corrected.available, true)
    assert.equal(corrected.revision, 'confirmed:mask')
  })

  it('combines face and body skin while retaining semantic model identity', () => {
    const skin = resolveAnalysisDebugLayer('skin', { analysis, originalSubjectEvidence: aiEvidence })

    assert.deepEqual([...skin.mask.values], [0, 1, 1, 0])
    assert.equal(skin.confidence, 0.8)
    assert.equal(skin.modelVersion, 'mediapipe/semantic-v1')
  })

  it('returns landmark evidence and a clear unavailable layer state', () => {
    const landmarks = resolveAnalysisDebugLayer('landmarks', {
      analysis,
      originalSubjectEvidence: aiEvidence,
    })
    const clothes = resolveAnalysisDebugLayer('clothes', {
      analysis,
      originalSubjectEvidence: aiEvidence,
    })

    assert.equal(landmarks.landmarks.length, 1)
    assert.equal(landmarks.modelVersion, 'mediapipe/face-v1')
    assert.equal(clothes.available, false)
  })

  it('exposes resolved feature placements as a debug layer', () => {
    const features = resolveAnalysisDebugLayer('features', {
      analysis,
      originalSubjectEvidence: aiEvidence,
      candidate: featureCandidate,
    })

    assert.equal(features.available, true)
    assert.equal(features.placements.length, 1)
    assert.equal(features.modelVersion, 'feature-planning-v1')
  })

  it('maps edge, depth, and embedding outputs into inspectable layers', () => {
    const learnedAnalysis = {
      ...analysis,
      confidence: 0.88,
      importanceMap: { width: 2, height: 2, weights: new Float32Array([0.1, 0.9, 0.4, 0]) },
      semanticRegions: [
        ...analysis.semanticRegions,
        { id: 'depth', label: 'depth', mask: { width: 2, height: 2, values: new Float32Array([0, 0.3, 0.7, 1]) }, confidence: 0.75 },
      ],
      modelVersions: { ...analysis.modelVersions, segmentation: 'birefnet-v1', depth: 'depth-v2' },
    }
    const preferenceFeatures = [{
      modelId: 'dinov2-v1',
      names: ['embedding-similarity'],
      values: new Float32Array([0.82]),
      confidence: 0.9,
    }]

    const edges = resolveAnalysisDebugLayer('edges', { analysis: learnedAnalysis })
    const depth = resolveAnalysisDebugLayer('depth', { analysis: learnedAnalysis })
    const embedding = resolveAnalysisDebugLayer('embedding', { analysis: learnedAnalysis, preferenceFeatures })

    assert.deepEqual([...edges.mask.values], [0.1, 0.9, 0.4, 0].map(Math.fround))
    assert.equal(edges.modelVersion, 'birefnet-v1')
    assert.equal(depth.modelVersion, 'depth-v2')
    assert.match(embedding.detail, /embedding-similarity 0\.820/)
  })

  it('projects a grid cell through fitted square margins without stretching', () => {
    assert.deepEqual(featureCellSourceRect(featureCandidate, 24 * 48 + 18), {
      x: 1.5,
      y: 1,
      width: 1 / 12,
      height: 1 / 12,
    })
  })

  it('fits rectangular sources into the viewer without stretching', () => {
    assert.deepEqual(fitAnalysisDebugCanvas(800, 400, 600, 600), {
      width: 600,
      height: 300,
    })
  })

  it('reconstrains semantic regions after a confirmed subject correction', () => {
    const updated = applyCorrectedSubjectEvidence({
      ...analysis,
      semanticRegions: [
        { id: 'subject', label: 'subject', mask: aiEvidence.mask, confidence: 0.8, importance: 0.8 },
        ...analysis.semanticRegions,
      ],
    }, {
      ...correctedEvidence,
      mask: { width: 2, height: 2, values: new Float32Array([0, 1, 1, 0]) },
    })

    const regions = new Map(updated.semanticRegions.map((entry) => [entry.id, entry]))
    assert.deepEqual([...regions.get('subject').mask.values], [0, 1, 1, 0])
    assert.equal(regions.has('hair'), false)
    assert.deepEqual([...regions.get('face-skin').mask.values], [0, 1, 0, 0])
  })

  it('passes the complete analysis object into Pattern Core generation', async () => {
    const html = await readFile(new URL('./index.html', import.meta.url), 'utf8')

    assert.match(html, /analysis: sourceAnalysis/)
    assert.match(html, /data-analysis-layer="features"/)
  })
})
