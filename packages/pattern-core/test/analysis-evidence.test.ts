import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { numericArrayFingerprintSync } from '../src/index.js'

describe('analysis evidence identity', () => {
  it('fingerprints large numeric arrays into a compact stable value', () => {
    const values = new Float32Array(1024 * 1024)
    values[0] = 0.25
    values[values.length - 1] = 0.75

    const first = numericArrayFingerprintSync(values)
    const second = numericArrayFingerprintSync(values)
    values[values.length - 1] = 0.5
    const changed = numericArrayFingerprintSync(values)

    assert.equal(first, second)
    assert.notEqual(first, changed)
    assert.ok(first.length <= 32)
  })
})
