import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import sharp from 'sharp'

import {
  RembgHttpSegmentationProvider,
  type SegmentationRequest,
} from '../src/index.js'

function request(width = 2, height = 2): SegmentationRequest {
  return {
    image: {
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4).fill(255),
    },
  }
}

async function maskPng(width: number, height: number, values: readonly number[]): Promise<Buffer> {
  return sharp(Buffer.from(values), {
    raw: { width, height, channels: 1 },
  }).png().toBuffer()
}

describe('rembg HTTP segmentation provider', () => {
  it('requests the lightweight BiRefNet mask and maps it into ImageAnalysis', async () => {
    const output = await maskPng(2, 2, [0, 64, 160, 255])
    const fetch: typeof globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'http://127.0.0.1:7000/api/remove')
      assert.equal(init?.method, 'POST')
      const form = init?.body as FormData
      assert.equal(form.get('model'), 'birefnet-general-lite')
      assert.equal(form.get('om'), 'true')
      assert.equal(form.get('ppm'), 'true')
      assert.ok(form.get('file') instanceof Blob)
      return new Response(Uint8Array.from(output), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    }
    const provider = new RembgHttpSegmentationProvider({ fetch })

    const result = await provider.segment(request())

    assert.equal(result.provider, 'rembg-http')
    assert.equal(result.model, 'birefnet-general-lite')
    assert.deepEqual(result.analysis.suggestedCrop, { x: 0, y: 1, width: 2, height: 1 })
    assert.equal(result.analysis.suggestedCropSource, 'automatic')
    assert.equal(result.analysis.modelVersions?.segmentation, 'rembg/birefnet-general-lite')
    assert.equal(result.analysis.subjectMaskEvidence?.confidence, result.analysis.confidence)
    assert.equal(result.analysis.subjectMaskEvidence?.source, 'ai')
    assert.equal(result.analysis.subjectMaskEvidence?.revision, 'rembg-http:birefnet-general-lite:mask-v1-certainty-v1')
    assert.deepEqual(result.analysis.subjectMaskEvidence?.provenance, [{
      origin: 'model',
      provider: 'rembg-http',
      model: 'birefnet-general-lite',
      version: 'mask-v1-certainty-v1',
    }])
    assert.deepEqual(
      [...result.analysis.subjectMask!.values].map((value) => Math.round(value * 255)),
      [0, 64, 160, 255],
    )
    assert.ok(result.analysis.importanceMap!.weights[2]! > result.analysis.subjectMask!.values[2]!)
    assert.ok((result.analysis.confidence ?? 0) > 0.5)
  })

  it('rejects a mask whose dimensions differ from the source image', async () => {
    const output = await maskPng(1, 1, [255])
    const fetch: typeof globalThis.fetch = async () => new Response(Uint8Array.from(output), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })
    const provider = new RembgHttpSegmentationProvider({ fetch })

    await assert.rejects(() => provider.segment(request()), /dimensions/)
  })

  it('surfaces rembg failures with a bounded response message', async () => {
    const fetch: typeof globalThis.fetch = async () => new Response('model unavailable', { status: 503 })
    const provider = new RembgHttpSegmentationProvider({ fetch })

    await assert.rejects(() => provider.segment(request()), /503.*model unavailable/)
  })

  it('rejects unsupported models and oversized source images at runtime', async () => {
    const provider = new RembgHttpSegmentationProvider()

    await assert.rejects(() => provider.segment({
      ...request(),
      model: 'future-model' as never,
    }), /model/)
    await assert.rejects(() => provider.segment({
      image: {
        width: 2049,
        height: 1,
        data: new Uint8ClampedArray(2049 * 4),
      },
    }), /limit/)
  })

  it('rejects malformed provider configuration', () => {
    assert.throws(() => new RembgHttpSegmentationProvider({ timeoutMs: Number.NaN }), /timeout/)
    assert.throws(() => new RembgHttpSegmentationProvider({ cropThreshold: 2 }), /threshold/)
    assert.throws(() => new RembgHttpSegmentationProvider({ cropPaddingRatio: -1 }), /padding/)
    assert.throws(() => new RembgHttpSegmentationProvider({
      defaultModel: 'future-model' as never,
    }), /model/)
  })

  it('stops reading a response after the configured byte limit', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40 * 1024 * 1024))
        controller.enqueue(new Uint8Array(40 * 1024 * 1024))
        controller.close()
      },
    })
    const fetch: typeof globalThis.fetch = async () => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })
    const provider = new RembgHttpSegmentationProvider({ fetch })

    await assert.rejects(() => provider.segment(request()), /response limit/)
  })

  it('stops before HTTP when the caller signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled by caller'))
    const provider = new RembgHttpSegmentationProvider({
      fetch: async () => assert.fail('Aborted request must stop before HTTP'),
    })

    await assert.rejects(
      () => provider.segment({ ...request(), signal: controller.signal }),
      /cancelled by caller/,
    )
  })
})
