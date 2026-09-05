import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  analysisCapabilitiesForRoute,
  createContainSourceFrame,
  hydrateAiAnalysisResult,
  pixelImageRequestBody,
  projectSourceAnalysisToProposal,
  routeAvailability,
  selectLearnedProposal,
} from './ai-runtime.mjs'

describe('demo AI runtime client', () => {
  it('maps each route to its declared model capabilities', () => {
    assert.deepEqual(analysisCapabilitiesForRoute('deterministic'), [])
    assert.deepEqual(analysisCapabilitiesForRoute('neural-analysis'), [
      'subject-segmentation',
      'edge-thin-structure',
    ])
    assert.deepEqual(analysisCapabilitiesForRoute('learned-pixelization'), ['learned-pixelization'])
    assert.deepEqual(analysisCapabilitiesForRoute('generative-proposal'), ['generative-proposal'])
    assert.deepEqual(analysisCapabilitiesForRoute('preference-scoring'), [
      'embedding',
      'preference-scoring',
    ])
    assert.throws(() => analysisCapabilitiesForRoute('future-route'), /route/)
  })

  it('encodes complete RGBA input and rejects malformed images', () => {
    const body = pixelImageRequestBody({
      width: 2,
      height: 1,
      data: Uint8ClampedArray.from([1, 2, 3, 255, 4, 5, 6, 255]),
    }, 'neural-analysis')

    assert.equal(body.image.rgbaBase64, 'AQID/wQFBv8=')
    assert.deepEqual(body.capabilities, ['subject-segmentation', 'edge-thin-structure'])
    assert.throws(() => pixelImageRequestBody({
      width: 2,
      height: 1,
      data: new Uint8ClampedArray(4),
    }, 'neural-analysis'), /RGBA/)
  })

  it('forwards the requested target grid and proposal controls', () => {
    const body = pixelImageRequestBody({
      width: 1,
      height: 1,
      data: Uint8ClampedArray.from([20, 30, 40, 255]),
    }, 'learned-pixelization', {
      targetGrid: { width: 48, height: 48 },
      styleId: 'faithful',
      prompt: 'preserve cat eyes and ear tips',
    })

    assert.deepEqual(body.targetGrid, { width: 48, height: 48 })
    assert.equal(body.styleId, 'faithful')
    assert.equal(body.prompt, 'preserve cat eyes and ear tips')
  })

  it('encodes the source and candidate as one bounded preference-scoring request', () => {
    const body = pixelImageRequestBody({
      width: 1,
      height: 1,
      data: Uint8ClampedArray.from([10, 20, 30, 255]),
    }, 'preference-scoring', {
      referenceImage: {
        width: 2,
        height: 1,
        data: Uint8ClampedArray.from([
          1, 2, 3, 255,
          4, 5, 6, 255,
        ]),
      },
      sourceId: 'source-cat-03',
      candidateId: 'candidate-quality-48',
      providerIds: ['dinov2-vits14-pair-local', 'openclip-vit-b32-pair-local'],
    })

    assert.deepEqual(body.capabilities, ['embedding', 'preference-scoring'])
    assert.deepEqual(body.image, {
      width: 1,
      height: 1,
      rgbaBase64: 'ChQe/w==',
    })
    assert.deepEqual(body.referenceImage, {
      width: 2,
      height: 1,
      rgbaBase64: 'AQID/wQFBv8=',
    })
    assert.equal(body.sourceId, 'source-cat-03')
    assert.equal(body.candidateId, 'candidate-quality-48')
    assert.deepEqual(body.providerIds, [
      'dinov2-vits14-pair-local',
      'openclip-vit-b32-pair-local',
    ])
  })

  it('hydrates mask, region, edge, proposal, and preference arrays', () => {
    const result = hydrateAiAnalysisResult({
      route: 'neural-analysis',
      status: 'ready',
      analysis: {
        subjectMask: { width: 2, height: 1, values: [0.25, 1] },
        importanceMap: { width: 2, height: 1, weights: [0.4, 0.9] },
        semanticRegions: [{
          id: 'depth',
          label: 'depth',
          confidence: 0.8,
          mask: { width: 2, height: 1, values: [0.1, 0.9] },
        }],
      },
      learnedProposals: [{
        id: 'proposal-1',
        kind: 'learned-pixelization',
        modelId: 'test/model',
        confidence: 0.7,
        image: { width: 1, height: 1, data: [10, 20, 30, 255] },
        sourceFrame: {
          fit: 'contain',
          sourceWidth: 2,
          sourceHeight: 1,
          x: 0,
          y: 0.25,
          width: 1,
          height: 0.5,
        },
      }],
      preferenceFeatures: [{
        modelId: 'test/embedding',
        names: ['embedding-similarity'],
        values: [0.82],
        confidence: 0.9,
      }],
      contributions: [],
      uncoveredCapabilities: [],
    })

    assert.ok(result.analysis.subjectMask.values instanceof Float32Array)
    assert.ok(result.analysis.importanceMap.weights instanceof Float32Array)
    assert.ok(result.analysis.semanticRegions[0].mask.values instanceof Float32Array)
    assert.ok(result.learnedProposals[0].image.data instanceof Uint8ClampedArray)
    assert.ok(result.preferenceFeatures[0].values instanceof Float32Array)
  })

  it('rejects malformed model arrays before they enter Pattern Core', () => {
    assert.throws(() => hydrateAiAnalysisResult({
      analysis: { subjectMask: { width: 2, height: 2, values: [1, 0] } },
    }), /dimensions/)
    assert.throws(() => hydrateAiAnalysisResult({
      analysis: {},
      preferenceFeatures: [{ modelId: 'test', names: ['a'], values: [0.2, 0.3], confidence: 0.8 }],
    }), /features/)
    assert.throws(() => hydrateAiAnalysisResult({
      analysis: {},
      learnedProposals: [{
        id: 'proposal-1',
        kind: 'learned-pixelization',
        modelId: 'test/model',
        confidence: 0.8,
        targetGrid: { width: 0, height: 32 },
        image: { width: 1, height: 1, data: [0, 0, 0, 255] },
        sourceFrame: {
          fit: 'contain', sourceWidth: 1, sourceHeight: 1,
          x: 0, y: 0, width: 1, height: 1,
        },
      }],
    }), /target grid/)
    assert.throws(() => hydrateAiAnalysisResult({
      analysis: {},
      learnedProposals: [{
        id: 'proposal-1',
        kind: 'learned-pixelization',
        modelId: 'test/model',
        confidence: Number.NaN,
        image: { width: 1, height: 1, data: [0, 0, 0, 255] },
        sourceFrame: {
          fit: 'contain', sourceWidth: 1, sourceHeight: 1,
          x: 0, y: 0, width: 1, height: 1,
        },
      }],
    }), /confidence/)
    assert.throws(() => hydrateAiAnalysisResult({
      analysis: {},
      learnedProposals: [{
        id: 'proposal-1',
        kind: 'learned-pixelization',
        modelId: 'test/model',
        confidence: 0.8,
        image: { width: 4, height: 4, data: new Array(4 * 4 * 4).fill(255) },
        sourceFrame: {
          fit: 'contain', sourceWidth: 4, sourceHeight: 2,
          x: 0, y: 0, width: 4, height: 4,
        },
      }],
    }), /contain/)
  })

  it('reports explicit route availability from health metadata', () => {
    const health = {
      routes: {
        deterministic: { available: true, status: 'ready' },
        'neural-analysis': { available: true, status: 'ready' },
        'learned-pixelization': { available: false, status: 'unavailable' },
        'generative-proposal': { available: false, status: 'unavailable' },
      },
    }

    assert.equal(routeAvailability(health, 'neural-analysis').available, true)
    assert.equal(routeAvailability(health, 'generative-proposal').available, false)
    assert.equal(routeAvailability(undefined, 'neural-analysis').status, 'checking')
  })

  it('selects the strongest learned proposal and carries its target grid into generation', () => {
    const proposals = [{
      id: 'weak',
      kind: 'learned-pixelization',
      image: { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) },
      confidence: 0.45,
      modelId: 'pixel/model',
      targetGrid: { width: 32, height: 32 },
      sourceFrame: {
        fit: 'contain', sourceWidth: 16, sourceHeight: 16,
        x: 0, y: 0, width: 16, height: 16,
      },
    }, {
      id: 'strong',
      kind: 'learned-pixelization',
      image: { width: 24, height: 24, data: new Uint8ClampedArray(24 * 24 * 4) },
      confidence: 0.91,
      modelId: 'pixel/model',
      targetGrid: { width: 48, height: 48 },
      sourceFrame: {
        fit: 'contain', sourceWidth: 24, sourceHeight: 24,
        x: 0, y: 0, width: 24, height: 24,
      },
    }]

    const selected = selectLearnedProposal(proposals, 'learned-pixelization')
    assert.equal(selected?.id, 'strong')
    assert.deepEqual(selected?.targetGrid, { width: 48, height: 48 })
    assert.equal(selectLearnedProposal(proposals, 'generative-proposal'), undefined)
  })

  it('projects source landmarks, masks, semantic regions, importance, and crop into proposal pixels', () => {
    const values = new Float32Array([
      0, 1, 0, 0,
      0, 0, 1, 0,
    ])
    const proposal = {
      id: 'cat-proposal',
      kind: 'learned-pixelization',
      modelId: 'pixel/model',
      confidence: 0.9,
      image: { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4) },
      sourceFrame: createContainSourceFrame(
        { width: 4, height: 2 },
        { width: 4, height: 4 },
      ),
    }
    const projected = projectSourceAnalysisToProposal({
      subjectMaskEvidence: {
        mask: { width: 4, height: 2, values },
        confidence: 0.9,
        source: 'ai',
        revision: 'mask-1',
      },
      semanticRegions: [{
        id: 'face',
        label: 'face',
        confidence: 0.9,
        mask: { width: 4, height: 2, values },
      }],
      importanceMap: { width: 4, height: 2, weights: values },
      landmarks: [{
        id: 'eye', kind: 'eye', x: 1, y: 0,
        confidence: 0.9, priority: 'hard', sourceRadiusPx: 1,
      }],
      suggestedCrop: { x: 1, y: 0, width: 2, height: 2 },
      imageType: 'pet',
    }, proposal)

    assert.deepEqual(projected.suggestedCrop, { x: 1, y: 1, width: 2, height: 2 })
    assert.deepEqual(
      [projected.landmarks[0].x, projected.landmarks[0].y],
      [1, 1],
    )
    assert.deepEqual([...projected.semanticRegions[0].mask.values], [
      0, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 0,
    ])
    assert.deepEqual(
      [...projected.importanceMap.weights],
      [...projected.semanticRegions[0].mask.values],
    )
    assert.deepEqual(
      [...projected.subjectMaskEvidence.mask.values],
      [...projected.semanticRegions[0].mask.values],
    )

    const upscaled = projectSourceAnalysisToProposal({
      importanceMap: { width: 2, height: 1, weights: new Float32Array([1, 0]) },
    }, {
      ...proposal,
      sourceFrame: createContainSourceFrame(
        { width: 2, height: 1 },
        { width: 4, height: 4 },
      ),
    })
    assert.deepEqual(
      [...upscaled.importanceMap.weights.slice(4, 8)].map((value) => Math.round(value * 100)),
      [100, 75, 25, 0],
    )
  })
})
