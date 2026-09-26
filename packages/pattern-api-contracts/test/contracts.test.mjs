import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCreateJob, ContractError } from '../dist/index.js'
test('normalizes product defaults and exposes only bounded generation options', () => {
  const parsed = parseCreateJob({ imageId: 'img_1' })
  assert.equal(parsed.paletteId, 'mard-291'); assert.equal(parsed.options.maxColors, 20)
  assert.deepEqual(parseCreateJob({ imageId: 'img_1', options: { canvas: { mode: 'auto' } } }).options.canvas.candidates.map(s => s.width), [32, 48, 64])
  for (const input of [
    { imageId: 'x', endpoint: 'http://untrusted' }, { imageId: 'x', route: 'unknown' },
    { imageId: 'x', options: { maxColors: 49 } }, { imageId: 'x', options: { maxCandidates: 4 } },
    { imageId: 'x', options: { styles: ['faithful', 'faithful'] } },
    { imageId: 'x', options: { canvas: { mode: 'auto', size: { width: 48, height: 48 } } } },
    { imageId: 'x', options: { canvas: { mode: 'fixed', size: { width: 33, height: 33 } } } },
    { imageId: 'x', options: { optimization: { localSearchIterations: 999 } } },
  ]) assert.throws(() => parseCreateJob(input), ContractError)
})
