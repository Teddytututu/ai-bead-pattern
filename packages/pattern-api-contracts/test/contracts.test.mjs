import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCreateJob, ContractError } from '../dist/index.js'

test('preserves independent contours and asymmetric manual facial components with bounded validation', () => {
  const featureOverrides = [{ id: 'near', kind: 'eye', x: 21, y: 12, templateId: 'eye-open-3x3' }, { id: 'far', kind: 'eye', x: 42, y: 20, hidden: true }]
  const contours = { external: true, internal: false, colorId: 'A1' }
  const result = parseCreateJob({ imageId: 'x', options: { structure: { contours }, featureOverrides } })
  assert.deepEqual(result.options.featureOverrides, featureOverrides)
  assert.deepEqual(result.options.structure.contours, contours)
  for (const options of [
    { structure: { contours: { external: 'yes' } } }, { structure: { contours: { width: 3 } } },
    { featureOverrides: [{ ...featureOverrides[0], kind: 'mouth' }] },
    { featureOverrides: [{ ...featureOverrides[0], x: 1024 }] },
    { featureOverrides: [{ ...featureOverrides[0], shape: { widthPx: 2, heightPx: 3, angleDegrees: 181 } }] },
    { featureOverrides: [featureOverrides[0], featureOverrides[0]] },
  ]) assert.throws(() => parseCreateJob({ imageId: 'x', options }), ContractError)
})
test('validates and preserves independent tone and outline controls', () => {
  const structure = { valueMode: 'preserve', valueStrength: 0, valueLevels: 4, outlineMode: 'full' }
  assert.deepEqual(parseCreateJob({ imageId: 'x', options: { structure } }).options.structure, { occupancyMode: 'auto', ...structure })
  for (const invalid of [{ valueMode: 'unknown' }, { valueStrength: -0.1 }, { valueStrength: 1.1 }, { valueStrength: '0' }, { valueStrength: NaN }, { valueLevels: 2.5 }, { outlineMode: 'unknown' }]) {
    assert.throws(() => parseCreateJob({ imageId: 'x', options: { structure: invalid } }), ContractError)
  }
})
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
