import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { annotationFromDatasetTask, createAnnotationDataset, datasetAnnotationId } from '../../server/annotation-dataset.mjs'
import { createAnnotationApiHandler } from '../../server/annotation-api.mjs'
import { validateAnnotation, confirmContext, setInputOccupancy, confirmInput } from '../../annotation-state.mjs'

function task(i) {
  return { sampleId: 'sample-' + i, title: 'Sample ' + i, gridSha256: 'a'.repeat(64),
    grid: { width: 2, height: 2, rgb: [[255,255,255],[255,255,255],[30,40,50],[235,190,151]], occupancy: [null,null,null,null] } }
}
test('JSON intake keeps unknown occupancy until human review, preserving white beads and source RGB', () => {
  const a = annotationFromDatasetTask(task(0), 'b'.repeat(64))
  assert.equal(a.id, datasetAnnotationId(task(0)))
  assert.equal(a.currentGrid.colors.length, 3)
  assert.deepEqual(a.inputReview.occupancy, [null,null,null,null])
  a.reviewer = 'automated-fixture'; a.editMask[2] = true
  assert.throws(() => confirmContext(a), /复核输入/)
  assert.throws(() => confirmInput(a), /未知占用/)
  setInputOccupancy(a, [0,1,2,3], 1)
  setInputOccupancy(a, [0], 0)
  assert.equal(a.currentGrid.cells[0], -1)
  assert.equal(a.currentGrid.cells[1], 0)
  assert.deepEqual(a.currentGrid.colors[0].rgb, [255,255,255])
  confirmInput(a); confirmContext(a)
  assert.throws(() => setInputOccupancy(a, [1], 0), /输入已固定/)
  assert.equal(validateAnnotation(a).inputReview.confirmed, true)
  assert.equal(a.trainingEligible, false)
  a.inputReview.sampledGrid.unusedMetadata = { sourceImage: 'must-not-persist' }
  assert.equal('unusedMetadata' in validateAnnotation(a).inputReview.sampledGrid, false)
})
test('server reads fixed 20-file pages, preserves final partial page and stable IDs without dropping invalid entries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'annotation-dataset-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'packet.json')
  const tasks = Array.from({ length: 24 }, (_,i) => task(i))
  await writeFile(path, JSON.stringify({ tasks }))
  const loader = createAnnotationDataset({ packetPath: path })
  const first = await loader(0), second = await loader(20, first.datasetId)
  assert.equal(first.items.length, 20); assert.equal(second.items.length, 4)
  assert.equal(first.total, 24); assert.equal(second.hasNext, false)
  assert.equal(new Set([...first.items,...second.items].map(s => s.id)).size, 24)
  const restarted = await createAnnotationDataset({ packetPath: path })(0)
  assert.equal(first.items[0].id, restarted.items[0].id)
  await assert.rejects(loader(1), /20/)
  await assert.rejects(loader(20, '0'.repeat(64)), /索引已更新/)
  tasks[0].grid.width = 65
  const invalidPath = join(directory, 'invalid.json')
  await writeFile(invalidPath, JSON.stringify({ tasks }))
  const invalid = await createAnnotationDataset({ packetPath: invalidPath })(0)
  assert.equal(invalid.items.length, 20); assert.ok(invalid.items[0].error)
})
test('intake drafts may correct occupancy, but confirmed inputs and provenance cannot change', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'annotation-intake-api-'))
  const packetPath = join(directory, 'packet.json')
  await writeFile(packetPath, JSON.stringify({ tasks: [task(randomUUID())] }))
  const handler = createAnnotationApiHandler({ directory: join(directory,'records'), packetPath })
  const server = createServer((req,res) => handler(req,res))
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    await rm(directory, { recursive: true, force: true })
  })
  const origin = 'http://127.0.0.1:' + server.address().port
  const page = await (await fetch(origin + '/api/annotation-dataset?offset=0')).json()
  const a = page.items[0].annotation
  const post = version => fetch(origin + '/api/annotations', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ annotation:a,expectedVersion:version }) })
  assert.equal((await post(0)).status,200)
  a.reviewer = 'automated-fixture'
  setInputOccupancy(a,[0,1,2,3],1);setInputOccupancy(a,[0],0)
  assert.equal((await post(1)).status,200)
  confirmInput(a)
  assert.equal((await post(2)).status,200)
  const batch = await (await fetch(origin + '/api/annotation-dataset?offset=0')).json()
  assert.equal(batch.items[0].record.version,3)
  a.inputReview.confirmed = false
  assert.equal((await post(3)).status,422)
  a.inputReview.confirmed = true; a.inputReview.sampleId = 'forged'
  assert.equal((await post(3)).status,422)
})
