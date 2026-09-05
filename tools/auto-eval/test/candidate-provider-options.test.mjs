import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { candidateProviderOptions } from '../src/candidate-provider-options.mjs'

describe('candidate generation provider options', () => {
  it('reads DINOv2 endpoint and timeout from command arguments', () => {
    assert.deepEqual(candidateProviderOptions({
      'dinov2-endpoint': 'http://127.0.0.1:7105',
      'dinov2-timeout-ms': '45000',
    }, {}), {
      dinoV2Endpoint: 'http://127.0.0.1:7105',
      dinoV2TimeoutMs: 45_000,
    })
  })

  it('uses DINOV2_ENDPOINT while command arguments retain precedence', () => {
    assert.deepEqual(candidateProviderOptions({}, {
      DINOV2_ENDPOINT: 'http://127.0.0.1:7205',
      OPENCLIP_ENDPOINT: 'http://127.0.0.1:7204',
    }), {
      dinoV2Endpoint: 'http://127.0.0.1:7205',
      openClipEndpoint: 'http://127.0.0.1:7204',
    })
    assert.equal(candidateProviderOptions({
      'dinov2-endpoint': 'http://127.0.0.1:7105',
    }, {
      DINOV2_ENDPOINT: 'http://127.0.0.1:7205',
    }).dinoV2Endpoint, 'http://127.0.0.1:7105')
  })

  it('rejects invalid provider timeouts before candidate generation starts', () => {
    assert.throws(
      () => candidateProviderOptions({ 'dinov2-timeout-ms': '0' }, {}),
      /positive number/i,
    )
  })

  it('reads the paired Grounded-SAM2 and MMPose analysis endpoints and timeouts', () => {
    assert.deepEqual(candidateProviderOptions({
      'grounded-sam2-endpoint': 'http://127.0.0.1:7111',
      'grounded-sam2-timeout-ms': '55000',
      'mmpose-endpoint': 'http://127.0.0.1:7112',
      'mmpose-timeout-ms': '25000',
    }, {}), {
      groundedSam2Endpoint: 'http://127.0.0.1:7111',
      groundedSam2TimeoutMs: 55_000,
      mmposeEndpoint: 'http://127.0.0.1:7112',
      mmposeTimeoutMs: 25_000,
    })
  })

  it('uses pet-analysis environment endpoints and keeps command arguments authoritative', () => {
    assert.deepEqual(candidateProviderOptions({
      'grounded-sam2-endpoint': 'http://127.0.0.1:7111',
    }, {
      GROUNDED_SAM2_ENDPOINT: 'http://127.0.0.1:7211',
      GROUNDED_SAM2_TIMEOUT_MS: '50000',
      MMPOSE_ENDPOINT: 'http://127.0.0.1:7212',
      MMPOSE_TIMEOUT_MS: '20000',
    }), {
      groundedSam2Endpoint: 'http://127.0.0.1:7111',
      groundedSam2TimeoutMs: 50_000,
      mmposeEndpoint: 'http://127.0.0.1:7212',
      mmposeTimeoutMs: 20_000,
    })
  })

  it('rejects partial pet-analysis configuration and manifest-breaking timeouts', () => {
    assert.throws(() => candidateProviderOptions({
      'grounded-sam2-endpoint': 'http://127.0.0.1:7111',
    }, {}), /configured together/i)
    assert.throws(() => candidateProviderOptions({
      'grounded-sam2-endpoint': 'http://127.0.0.1:7111',
      'mmpose-endpoint': 'http://127.0.0.1:7112',
      'mmpose-timeout-ms': '30001',
    }, {}), /model limit/i)
  })
})
