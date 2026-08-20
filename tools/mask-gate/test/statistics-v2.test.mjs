import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { wilsonInterval } from '../src/statistics.mjs'

describe('Wilson score interval', () => {
  it('returns bounded 95 percent intervals for proportions', () => {
    assert.deepEqual(wilsonInterval(0, 0), { lower: null, upper: null })
    const interval = wilsonInterval(8, 10)

    assert.ok(interval.lower > 0.49 && interval.lower < 0.50)
    assert.ok(interval.upper > 0.94 && interval.upper < 0.95)
  })

  it('rejects counts outside the sample total', () => {
    assert.throws(() => wilsonInterval(11, 10), /count/i)
  })
})
