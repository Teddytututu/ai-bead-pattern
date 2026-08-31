import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  analysisCapabilitiesForRoute,
  hydrateAiAnalysisResult,
  pixelImageRequestBody,
  routeAvailability,
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
})
