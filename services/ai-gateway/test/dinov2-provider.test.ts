import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { PixelImage } from '@ai-bead-pattern/pattern-core'

import { HttpVisionProvider, MODEL_CATALOG } from '../src/index.js'

function image(width = 32, height = 32): PixelImage {
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4).fill(255),
  }
}

describe('DINOv2 regional pair provider', () => {
  it('freezes the local ViT-S/14 runtime, weights, license, and patch-aligned input', () => {
    const manifest = MODEL_CATALOG.find((entry) => entry.providerId === 'dinov2-vits14-pair-local')

    assert.ok(manifest)
    assert.equal(manifest.modelId, 'facebook/dinov2-small')
    assert.equal(manifest.modelVersion, 'transformers-5.16.1+dinov2-vits14')
    assert.equal(manifest.sourceRevision, '7764ea0f912e53c92e82eb78a2a1631e92725fc8')
    assert.equal(manifest.weightRevision, 'hf:ed25f3a31f01632728cabb09d1542f84ab7b0056')
    assert.equal(manifest.license.spdx, 'Apache-2.0')
    assert.equal(manifest.weightLicense?.spdx, 'Apache-2.0')
    assert.deepEqual(manifest.capabilities, ['embedding', 'preference-scoring'])
    assert.deepEqual(manifest.execution.devices, ['cpu', 'cuda', 'mps'])
    assert.equal(manifest.privacy.imageLeavesDevice, false)
    assert.equal(manifest.input.preferredWidth % 14, 0)
    assert.equal(manifest.input.preferredHeight % 14, 0)
  })

  it('hydrates global, subject, head, and critical-local comparisons', async () => {
    const manifest = MODEL_CATALOG.find((entry) => entry.providerId === 'dinov2-vits14-pair-local')
    assert.ok(manifest)
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      assert.ok(init?.body instanceof FormData)
      assert.ok(init.body.get('image') instanceof Blob)
      assert.ok(init.body.get('referenceImage') instanceof Blob)
      const request = JSON.parse(String(init.body.get('request'))) as {
        sourceId: string
        candidateId: string
        capabilities: string[]
      }
      assert.equal(request.sourceId, 'source-cat-03')
      assert.equal(request.candidateId, 'candidate-48-quality')
      assert.deepEqual(request.capabilities, ['embedding', 'preference-scoring'])
      return Response.json({
        schemaVersion: 'ai-gateway-provider-v1',
        providerId: manifest.providerId,
        model: {
          modelId: manifest.modelId,
          modelVersion: manifest.modelVersion,
          sourceRevision: manifest.sourceRevision,
          weightRevision: manifest.weightRevision,
        },
        capabilities: ['embedding', 'preference-scoring'],
        confidence: 0.88,
        preferenceFeatures: {
          names: [
            'global.identitySimilarity', 'global.patchCorrespondence',
            'global.criticalPatchRetention', 'global.regionalCoverage',
            'subject.identitySimilarity', 'subject.patchCorrespondence',
            'subject.criticalPatchRetention', 'subject.regionalCoverage',
            'head.identitySimilarity', 'head.patchCorrespondence',
            'head.criticalPatchRetention', 'head.regionalCoverage',
            'critical-local.identitySimilarity', 'critical-local.patchCorrespondence',
            'critical-local.criticalPatchRetention', 'critical-local.regionalCoverage',
          ],
          values: [
            0.91, 0.87, 0.83, 0.79,
            0.9, 0.86, 0.82, 0.78,
            0.89, 0.85, 0.81, 0.77,
            0.88, 0.84, 0.8, 0.76,
          ],
          confidence: 0.88,
          scope: 'pair',
          candidateId: 'candidate-48-quality',
          regionalComparisons: [
            {
              view: 'global',
              identitySimilarity: 0.91,
              patchCorrespondence: 0.87,
              criticalPatchRetention: 0.83,
              regionalCoverage: 0.79,
              confidence: 0.88,
            },
            {
              view: 'subject',
              identitySimilarity: 0.9,
              patchCorrespondence: 0.86,
              criticalPatchRetention: 0.82,
              regionalCoverage: 0.78,
              confidence: 0.87,
            },
            {
              view: 'head',
              identitySimilarity: 0.89,
              patchCorrespondence: 0.85,
              criticalPatchRetention: 0.81,
              regionalCoverage: 0.77,
              confidence: 0.86,
            },
            {
              view: 'critical-local',
              identitySimilarity: 0.88,
              patchCorrespondence: 0.84,
              criticalPatchRetention: 0.8,
              regionalCoverage: 0.76,
              confidence: 0.85,
            },
          ],
        },
      })
    }
    const provider = new HttpVisionProvider({
      manifest,
      endpoint: 'http://127.0.0.1:7105',
      fetch,
    })

    const result = await provider.analyze({
      image: image(),
      referenceImage: image(),
      sourceId: 'source-cat-03',
      candidateId: 'candidate-48-quality',
      capabilities: ['embedding', 'preference-scoring'],
    })

    assert.equal(result.preferenceFeatures?.scope, 'pair')
    assert.equal(result.preferenceFeatures?.candidateId, 'candidate-48-quality')
    assert.deepEqual(
      result.preferenceFeatures?.regionalComparisons?.map((entry) => entry.view),
      ['global', 'subject', 'head', 'critical-local'],
    )
    assert.equal(result.preferenceFeatures?.regionalComparisons?.[2]?.identitySimilarity, 0.89)
    assert.equal(result.preferenceFeatures?.regionalComparisons?.[3]?.criticalPatchRetention, 0.8)
  })

  it('rejects duplicate or incomplete regional comparison sets', async () => {
    const manifest = MODEL_CATALOG.find((entry) => entry.providerId === 'dinov2-vits14-pair-local')
    assert.ok(manifest)
    const provider = new HttpVisionProvider({
      manifest,
      endpoint: 'http://127.0.0.1:7105',
      fetch: async () => Response.json({
        schemaVersion: 'ai-gateway-provider-v1',
        providerId: manifest.providerId,
        model: {
          modelId: manifest.modelId,
          modelVersion: manifest.modelVersion,
          sourceRevision: manifest.sourceRevision,
          weightRevision: manifest.weightRevision,
        },
        capabilities: ['embedding', 'preference-scoring'],
        confidence: 0.8,
        preferenceFeatures: {
          names: ['global.identitySimilarity'],
          values: [0.8],
          confidence: 0.8,
          scope: 'pair',
          candidateId: 'candidate-a',
          regionalComparisons: [
            {
              view: 'global', identitySimilarity: 0.8, patchCorrespondence: 0.8,
              criticalPatchRetention: 0.8, regionalCoverage: 0.8, confidence: 0.8,
            },
            {
              view: 'global', identitySimilarity: 0.8, patchCorrespondence: 0.8,
              criticalPatchRetention: 0.8, regionalCoverage: 0.8, confidence: 0.8,
            },
          ],
        },
      }),
    })

    await assert.rejects(() => provider.analyze({
      image: image(),
      referenceImage: image(),
      candidateId: 'candidate-a',
      capabilities: ['embedding', 'preference-scoring'],
    }), /regional comparisons/i)
  })
})
