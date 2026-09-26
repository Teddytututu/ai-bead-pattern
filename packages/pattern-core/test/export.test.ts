import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPatternDocument, patternMaterialsCsv, patternSvg, type BeadPattern } from '../src/index.js'
const pattern: BeadPattern = {
  width: 2, height: 2,
  palette: [{ id: 'A10', code: 'A10', name: 'A10', hex: '#000000', rgb: [0, 0, 0] },
    { id: 'A2', code: 'A2', name: 'A2', hex: '#ffffff', rgb: [255, 255, 255] }],
  cells: [{ x: 0, y: 0, colorId: 'A10' }, { x: 1, y: 1, colorId: 'A2' }],
  metadata: { paletteId: 'mard-291', paletteVersion: 'v1', paletteBrand: 'MARD', sourceWidth: 2, sourceHeight: 2, totalBeads: 2, generatedAt: 0, algorithmVersion: 'test', aiEnhanced: false, style: 'faithful', baseline: 'a0' },
}
test('exports a sparse grid, exact counts, natural color order and version', () => {
  const doc = createPatternDocument(pattern)
  assert.deepEqual(doc.grid, [0, -1, -1, 1])
  assert.deepEqual(doc.materials.map(m => m.code), ['A2', 'A10'])
  assert.equal(doc.totalBeads, 2)
  assert.match(patternMaterialsCsv(pattern), /"MARD","mard-291","v1","A2","#ffffff","1"/)
  assert.match(patternSvg(pattern), /A10/)
  assert.match(patternSvg(pattern), /v1/)
  assert.throws(() => createPatternDocument({ ...pattern, cells: [...pattern.cells, pattern.cells[0]!] }), /Duplicate/)
  assert.throws(() => createPatternDocument({ ...pattern, cells: [{ x: 0, y: 0, colorId: 'missing' }] }), /Invalid/)
})
test('export indices above 255 do not wrap or collide with empty cells', () => {
  const colors = Array.from({ length: 291 }, (_, i) => ({ ...pattern.palette[0]!, id: `c${i}` }))
  const doc = createPatternDocument({ ...pattern, palette: colors, cells: [{ x: 0, y: 0, colorId: 'c290' }] })
  assert.deepEqual(doc.grid, [290, -1, -1, -1])
})
