import test from 'node:test'
import assert from 'node:assert/strict'
import { createPatternWorkerHandler } from '../src/worker.js'
import type { PatternAlgorithm } from '../src/algorithm.js'

test('worker protocol returns generation results and serializes errors', async () => {
  const messages: unknown[] = []
  const algorithm = {
    version: 'test', engine: 'baseline',
    generate: async (request: unknown) => ({ status: 'success', request }),
    adapt: async () => { throw new RangeError('bad adaptation') },
  } as unknown as PatternAlgorithm
  const handle = createPatternWorkerHandler(algorithm, { postMessage: (message) => messages.push(message) })
  await handle({ id: 'g1', type: 'generate', request: {} as never })
  await handle({ id: 'a1', type: 'adapt', request: {} as never })
  assert.deepEqual(messages[0], { id: 'g1', type: 'result', result: { status: 'success', request: {} } })
  assert.deepEqual(messages[1], { id: 'a1', type: 'error', error: { name: 'RangeError', message: 'bad adaptation' } })
})
