import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { importGrid, verifyCandidate, exportDocument, resolveSkinIndex } from '../../region-state.mjs'
import { createRegionApiHandler } from '../../server/region-api.mjs'
const grid = { width: 2, height: 2, paletteId: 'test', paletteVersion: '1', colors: [{ id: 'white', rgb: [255, 255, 255] }, { id: 'black', rgb: [0, 0, 0] }], cells: [0, -1, 1, 0] }
const request = { currentGrid: grid, editMask: [true, true, false, true], lockedMask: [false, false, false, true], maximumColors: 2, contextSha256: 'a'.repeat(64) }
const result = { schemaVersion: 'region-generation-v3', decision: 'candidate', validation: { status: 'passed' }, contextSha256: request.contextSha256,
  grid: { ...grid, cells: [1, 0, 1, 0] }, changedCells: [{ index: 0, before: 0, after: 1 }, { index: 1, before: -1, after: 0 }] }
test('skin prefill selects visible surrounding material, permits an explicit choice and excludes the target', () => {
  const edit = [false, true, false, false], locked = [false, false, false, false]
  assert.equal(resolveSkinIndex(grid, edit, locked), 0)
  assert.equal(resolveSkinIndex({ ...grid, cells: [0, 1, 1, 0] }, edit, locked), 0)
  assert.equal(resolveSkinIndex(grid, edit, locked, 'black'), 1)
  assert.throws(() => resolveSkinIndex(grid, edit, locked, 'missing'), /色卡/)
})
test('region accepts only changes within the request and rejects stale/invalid candidates', () => {
  assert.equal(verifyCandidate(request, result, grid).cells[0], 1)
  assert.throws(() => verifyCandidate(request, result, { ...grid, cells: [1, -1, 1, 0] }), /已变化/)
  for (const cells of [[1, -1, 1, 0], [1, 0, 0, 0], [1, 0, 1, 1]]) {
    assert.throws(() => verifyCandidate(request, { ...result, grid: { ...grid, cells } }, grid))
  }
  assert.throws(() => verifyCandidate(request, { ...result, grid: { ...result.grid, paletteVersion: '2' } }, grid), /材料/)
  assert.throws(() => verifyCandidate(request, { ...result, changedCells: [] }, grid), /清单/)
  assert.throws(() => verifyCandidate(request, { ...result, contextSha256: 'b'.repeat(64) }, grid), /上下文/)
  assert.throws(() => verifyCandidate(request, { ...result, decision: 'rejected', grid: null }, grid), /填充检查/)
})
test('region document export recomputes material counts, preserves empty cells and removes stale metrics', () => {
  const original = { schema: 'bead-pattern-document-v1', ...grid, grid: grid.cells, metadata: { qualityScore: 99 } }
  assert.deepEqual(importGrid(original), grid)
  const doc = exportDocument(result.grid, original, [{ reason: 'test' }])
  assert.equal(doc.totalBeads, 4)
  assert.equal(doc.materials.find(m => m.colorId === 'black').count, 2)
  assert.equal(doc.materials.find(m => m.colorId === 'white').count, 2)
  assert.equal(doc.metadata.qualityScore, undefined)
  assert.equal(doc.grid[1], 0)
  assert.deepEqual(importGrid(doc), result.grid)
})
test('region proxy forwards versioned JSON and upstream errors; rejects cross origin and malformed requests', async (t) => {
  const calls = []
  const handler = createRegionApiHandler({ fetchImpl: async (url, init) => { calls.push([String(url), init]); return Response.json({ detail: 'busy' }, { status: 409 }) } })
  const server = createServer((req, res) => handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const base = `http://127.0.0.1:${server.address().port}/api/ai/region`
  const send = (body, headers = {}) => fetch(base + '/generate', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })
  assert.equal((await send('{}')).status, 409)
  assert.equal(calls[0][0], 'http://127.0.0.1:7117/v1/regions/generate')
  assert.equal((await send('{}', { Origin: 'https://unrelated.example' })).status, 403)
  assert.equal((await send('bad')).status, 400)
  assert.equal((await send('{}', { 'Content-Type': 'text/plain' })).status, 415)
  assert.equal((await fetch(base + '/generate')).status, 405)
  assert.equal(calls.length, 1)
  const prepared = await fetch(base + '/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(prepared.status, 409)
  assert.equal(calls[1][0], 'http://127.0.0.1:7117/v1/regions/prepare')
  assert.throws(() => createRegionApiHandler({ endpoint: 'https://remote.example' }), /local/)
})
