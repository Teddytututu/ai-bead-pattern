import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAnnotation, validateAnnotation, setMaskCell, paintTargetCell, confirmContext, confirmTarget, modelInput, exportPair } from '../../annotation-state.mjs'
import { createAnnotationApiHandler } from '../../server/annotation-api.mjs'

const grid = { width: 4, height: 3, paletteId: 'test', paletteVersion: '1',
  colors: [{ id: 'skin', rgb: [235,190,151] }, { id: 'dark', rgb: [30,40,50] }],
  cells: [0,0,0,0,0,-1,1,0,0,0,0,0] }
function draft() {
  const a = createAnnotation(grid, { id: randomUUID() })
  a.reviewer = 'automated-test-not-human-gold'; a.prompt = 'Repair the missing eye.'
  setMaskCell(a, 5, 'edit'); setMaskCell(a, 6, 'edit'); setMaskCell(a, 6, 'lock')
  return a
}
test('annotation uses full bead grid, skin conditioning, and requires ordered confirmation', () => {
  const a = draft()
  assert.throws(() => paintTargetCell(a, 5, 1), /先确认/)
  assert.equal(modelInput(a).cells[5], 0)
  assert.equal(modelInput(a).cells[6], 1)
  assert.equal(a.currentGrid.cells[5], -1)
  confirmContext(a)
  assert.throws(() => confirmTarget(a), /空格/)
  paintTargetCell(a, 5, 1)
  assert.throws(() => paintTargetCell(a, 6, 0), /锁定/)
  assert.throws(() => paintTargetCell(a, 0, 1), /可改区/)
  a.review.notes = 'Synthetic UI fixture only'
  confirmTarget(a)
  const pair = exportPair(a)
  assert.equal(pair.conditioning, 'bead-grid-only')
  assert.equal(pair.request.inputMode, 'grid-context')
  assert.equal(pair.request.currentGrid.cells[5], -1)
  assert.equal(pair.targetGrid.cells[5], 1)
  assert.equal(pair.trainingEligible, false)
  assert.equal('sourceImage' in pair.request, false)
  assert.equal('reference' in pair, false)
})
test('shrinking a mask restores original cells and invalidates confirmations', () => {
  const a = draft(); confirmContext(a); paintTargetCell(a, 5, 1)
  setMaskCell(a, 5, 'unedit')
  assert.equal(a.targetGrid.cells[5], -1)
  assert.equal(a.review.contextConfirmed, false)
  assert.equal(a.review.targetConfirmed, false)
})
test('annotation rejects source image conditions, outside edits, empty locked cells and forged eligibility', () => {
  const a = draft()
  assert.throws(() => createAnnotation({ ...grid, sourceImage: {} }), /不接收原图/)
  for (const key of ['sourceImage','reference','referenceImage','originalImage']) {
    assert.throws(() => validateAnnotation({ ...a, [key]: {} }), /原图字段/)
  }
  assert.throws(() => validateAnnotation({ ...a, source: { ...a.source, sourceImage: {} } }), /原图条件/)
  assert.throws(() => validateAnnotation({ ...a, trainingEligible: true }), /训练资格/)
  const outside = structuredClone(a); outside.targetGrid.cells[0] = 1
  assert.throws(() => validateAnnotation(outside), /越过/)
  setMaskCell(a, 5, 'lock')
  assert.throws(() => confirmContext(a), /空格被锁定/)
})
test('incomplete metadata survives local recovery but cannot claim a completed remote grant', () => {
  const a = draft(); a.rights.decision = 'granted'
  assert.throws(() => validateAnnotation(a), /依据/)
  assert.equal(validateAnnotation(a, { allowIncompleteMetadata: true }).rights.decision, 'granted')
})
test('remote saves enforce source immutability, versions, origin, validation and reviewed snapshots', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pindou-annotation-'))
  const handler = createAnnotationApiHandler({ directory })
  const server = createServer((req, res) => { handler(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    await rm(directory, { recursive: true, force: true })
  })
  const base = 'http://127.0.0.1:' + server.address().port + '/api/annotations'
  const post = (annotation, expectedVersion, headers = {}) => fetch(base, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ annotation, expectedVersion }),
  })
  const a = draft()
  assert.equal((await post(a, 0, { Origin: 'https://other.example' })).status, 403)
  assert.equal((await post({ ...a, sourceImage: {} }, 0)).status, 422)
  const initial = await (await post(a, 0)).json()
  assert.equal(initial.version, 1)
  assert.match(initial.sourceSha256, /^[a-f0-9]{64}$/)
  assert.equal((await post(a, 0)).status, 409)
  const changed = structuredClone(a)
  changed.currentGrid.cells[0] = 1; changed.targetGrid.cells[0] = 1
  assert.equal((await post(changed, 1)).status, 422)
  const loaded = await (await fetch(base + '/' + a.id)).json()
  assert.deepEqual(loaded.annotation.currentGrid, a.currentGrid)
  confirmContext(a); paintTargetCell(a, 5, 1); a.review.notes = 'Automated fixture'; confirmTarget(a)
  const saved = await (await post(a, 1)).json()
  assert.equal(saved.version, 2)
  assert.equal((await readdir(join(directory, 'reviewed'))).length, 1)
  assert.equal((await (await fetch(base)).json()).records[0].confirmed, true)
  const concurrent = await Promise.all([post(a, 2), post(a, 2)])
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200,409])
})
