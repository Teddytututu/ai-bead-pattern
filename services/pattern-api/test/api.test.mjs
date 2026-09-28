import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, basename } from 'node:path'
import sharp from 'sharp'
import { createPatternApi } from '../dist/server.js'
const png = await sharp({ create: { width: 20, height: 10, channels: 4, background: '#fae0b0' } }).png().toBuffer()
async function harness(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bead-api-'))
  let api = await createPatternApi({ dataDir, devAuth: true, ...options })
  let base
  async function listen() { await new Promise(r => api.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${api.server.address().port}` }
  await listen()
  t.after(async () => { await api.close(); if (dirname(resolve(dataDir)) === resolve(tmpdir()) && basename(dataDir).startsWith('bead-api-')) await rm(dataDir, { recursive: true, force: true }) })
  async function call(path, { token, method = 'GET', data, key, body, headers = {} } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...headers }, ...(data !== undefined ? { body: JSON.stringify(data) } : body ? { body } : {}) })
    const text = await response.text()
    let json; try { json = JSON.parse(text) } catch {}
    return { status: response.status, headers: response.headers, json, text }
  }
  async function auth(userId = 'alice') { const res = await call('/v1/auth/dev', { method: 'POST', data: { userId } }); assert.equal(res.status, 200); return res.json.data.token }
  async function upload(token, bytes = png, type = 'image/png') { const form = new FormData(); form.append('file', new Blob([bytes], { type }), 'image.png'); return call('/v1/images', { method: 'POST', token, body: form }) }
  async function done(id, token) {
    for (let i = 0; i < 80; i++) { const job = await call(`/v1/pattern-jobs/${id}`, { token }); if (!['queued', 'running'].includes(job.json.data.state)) return job.json.data; await new Promise(r => setTimeout(r, 100)) }
    throw new Error('Job did not finish')
  }
  return { call, auth, upload, done, dataDir, get base() { return base }, get api() { return api }, async restart() { await api.close(); api = await createPatternApi({ dataDir, devAuth: true, ...options }); await listen() } }
}
test('real multipart -> persistent async MARD 291 -> exact grid, CSV and PNG', async t => {
  const h = await harness(t), token = await h.auth(), other = await h.auth('bob')
  const palette = await h.call('/v1/palettes/mard-291'); assert.equal(palette.json.data.colors.length, 291)
  assert.equal((await h.call('/v1/palettes/mard-291', { headers: { 'If-None-Match': palette.headers.get('etag') } })).status, 304)
  const upload = await h.upload(token); assert.equal(upload.status, 201)
  const imageId = upload.json.data.imageId
  assert.equal((await h.upload(token)).json.data.imageId, imageId)
  const data = { imageId, options: { canvas: { mode: 'fixed', size: { width: 32, height: 32 } }, maxCandidates: 1, styles: ['faithful'], structure: { valueMode: 'stylized', valueStrength: 0, outlineMode: 'off' } } }
  const [first, duplicate] = await Promise.all([1, 2].map(() => h.call('/v1/pattern-jobs', { token, method: 'POST', key: 'same', data })))
  assert.equal(first.status, 202); assert.equal(first.json.data.jobId, duplicate.json.data.jobId)
  const jobId = first.json.data.jobId
  assert.equal((await h.call('/v1/pattern-jobs', { token, method: 'POST', key: 'same', data: { ...data, options: { maxColors: 2 } } })).status, 409)
  assert.equal((await h.call(`/v1/pattern-jobs/${jobId}`, { token: other })).status, 404)
  assert.equal((await h.call(`/v1/images/${imageId}`, { token: other, method: 'DELETE' })).status, 404)
  assert.equal((await h.done(jobId, token)).state, 'succeeded')
  const result = (await h.call(`/v1/pattern-jobs/${jobId}/result`, { token })).json.data
  assert.equal(result.generationStatus, 'success'); assert.equal(result.actualRoute, 'deterministic')
  const c = result.candidates[0], doc = c.pattern
  assert.equal(doc.metadata.valueMode, 'stylized'); assert.equal(doc.metadata.valueStrength, 0)
  assert.equal(doc.metadata.outlineMode, 'off')
  assert.equal(doc.paletteId, 'mard-291'); assert.match(doc.paletteVersion, /^sha256:/)
  assert.equal(doc.materials.reduce((n, m) => n + m.count, 0), doc.grid.filter(v => v >= 0).length)
  assert.ok(doc.grid.includes(-1)); assert.ok(doc.materials.every(m => /^[A-Z]+\d+$/.test(m.code)))
  const csv = await h.call(`/v1/pattern-jobs/${jobId}/exports/${c.id}?format=csv`, { token }); assert.equal(csv.status, 200); assert.match(csv.text, /MARD/)
  const image = await fetch(`${h.base}/v1/pattern-jobs/${jobId}/exports/${c.id}?format=png`, { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(image.status, 200); assert.equal((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).format, 'png')
  assert.equal((await h.call(`/v1/pattern-jobs/${jobId}/exports/${c.id}?format=json`, { token: other })).status, 404)
  await h.restart()
  assert.equal((await h.call(`/v1/pattern-jobs/${jobId}/result`, { token })).json.data.generationId, result.generationId)
})

test('Perler 123 reaches worker, API catalog and all exports with real SKUs', async t => {
  const h = await harness(t), token = await h.auth()
  const summaries = (await h.call('/v1/palettes')).json.data
  const summary = summaries.find(p => p.id === 'perler-123')
  assert.equal(summary.colorCount, 123); assert.equal(summary.automaticColorCount, 118)
  const palette = (await h.call('/v1/palettes/perler-123')).json.data
  assert.equal(palette.version, summary.version); assert.equal(palette.colors.length, 123)
  const imageId = (await h.upload(token)).json.data.imageId
  const data = { imageId, paletteId: palette.id, paletteVersion: palette.version,
    options: { canvas: { mode: 'fixed', size: { width: 32, height: 32 } }, maxCandidates: 1, styles: ['faithful'] } }
  assert.equal((await h.call('/v1/pattern-jobs', { method: 'POST', token, key: 'perler-stale', data: { ...data, paletteVersion: 'stale' } })).status, 404)
  const badInk = await h.call('/v1/pattern-jobs', { method: 'POST', token, key: 'perler-transparent-ink',
    data: { ...data, options: { ...data.options, structure: { contours: { colorId: '80-19019' } } } } })
  assert.equal(badInk.status, 422); assert.equal(badInk.json.error.code, 'INVALID_CONTOUR_COLOR')
  const job = await h.call('/v1/pattern-jobs', { method: 'POST', token, key: 'perler', data })
  assert.equal(job.status, 202)
  const jobId = job.json.data.jobId
  assert.equal((await h.done(jobId, token)).state, 'succeeded')
  const result = (await h.call(`/v1/pattern-jobs/${jobId}/result`, { token })).json.data
  assert.equal(result.generationStatus, 'success')
  const candidate = result.candidates[0], doc = candidate.pattern
  assert.equal(doc.paletteId, 'perler-123'); assert.equal(doc.paletteVersion, palette.version)
  assert.equal(doc.brand, 'Perler'); assert.ok(doc.colors.every(c => c.automaticMatch && c.finish === 'solid'))
  assert.ok(doc.materials.every(m => /^(80-\d{5}|PER\d{5})$/.test(m.code)))
  assert.equal(doc.materials.reduce((n, m) => n + m.count, 0), doc.grid.filter(i => i >= 0).length)
  const path = `/v1/pattern-jobs/${jobId}/exports/${candidate.id}`
  assert.deepEqual((await h.call(`${path}?format=json`, { token })).json, doc)
  const csv = await h.call(`${path}?format=csv`, { token })
  assert.match(csv.text, /"Perler","perler-123"/)
  for (const material of doc.materials) assert.ok(csv.text.includes(`"${material.code}"`))
  const png = await fetch(`${h.base}${path}?format=png`, { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(png.status, 200)
  const metadata = await sharp(Buffer.from(await png.arrayBuffer())).metadata()
  assert.equal(metadata.format, 'png'); assert.ok(metadata.width >= 32 * 46)
})

test('manual feature coordinates and contour switches reach the worker and final result', async t => {
  const h = await harness(t), token = await h.auth(), uploaded = (await h.upload(token)).json.data
  const base = { imageId: uploaded.imageId, options: { canvas: { mode: 'fixed', size: { width: 32, height: 32 } }, styles: ['faithful'], maxCandidates: 1,
    structure: { contours: { external: false, internal: true } }, featureOverrides: [
      { id: 'near', kind: 'eye', x: 6, y: 3, templateId: 'eye-open-3x3' },
      { id: 'far', kind: 'eye', x: 14, y: 6, templateId: 'eye-e1' },
    ] } }
  const bad = await h.call('/v1/pattern-jobs', { token, method: 'POST', key: 'bad-face', data: { ...base, options: { ...base.options, featureOverrides: [{ ...base.options.featureOverrides[0], x: uploaded.width }] } } })
  assert.equal(bad.status, 422)
  const badInk = await h.call('/v1/pattern-jobs', { token, method: 'POST', key: 'bad-ink', data: { ...base,
    options: { ...base.options, structure: { contours: { external: true, colorId: 'H7' } } } } })
  assert.equal(badInk.status, 422); assert.equal(badInk.json.error.code, 'INVALID_CONTOUR_COLOR')
  const submitted = await h.call('/v1/pattern-jobs', { token, method: 'POST', key: 'manual-face', data: base })
  assert.equal(submitted.status, 202)
  const jobId = submitted.json.data.jobId
  assert.equal((await h.done(jobId, token)).state, 'succeeded')
  const c = (await h.call(`/v1/pattern-jobs/${jobId}/result`, { token })).json.data.candidates[0]
  assert.equal(c.contourPlan.options.external, false); assert.equal(c.contourPlan.options.internal, true)
  assert.equal(c.pattern.metadata.contours.external, false); assert.equal(c.pattern.metadata.contours.internal, true)
  assert.ok(c.contourPlan.diagnostics.warnings.includes('contour-internal-evidence-unavailable'))
  assert.equal(c.featurePlacements.length, 2)
  const near = c.featurePlacements.find(p => p.featureId === 'near'), far = c.featurePlacements.find(p => p.featureId === 'far')
  assert.ok(near.center[1] < far.center[1]); assert.equal(near.occupiedCells.length, 5); assert.equal(far.occupiedCells.length, 1)
  assert.ok(c.pattern.materials.length > 1)
})
test('rejects unauthenticated, oversized, invalid and unsupported requests', async t => {
  const h = await harness(t), token = await h.auth()
  assert.equal((await h.upload(undefined)).status, 401)
  assert.equal((await h.upload(token, Buffer.from('not an image'))).status, 422)
  assert.equal((await h.upload(token, png, 'application/octet-stream')).status, 415)
  assert.equal((await h.upload(token, Buffer.alloc(5 * 1024 * 1024 + 1))).status, 413)
  const imageId = (await h.upload(token)).json.data.imageId
  for (const [data, status] of [[{ imageId, options: { maxColors: 291 } }, 422], [{ imageId, paletteId: 'missing' }, 404], [{ imageId, paletteVersion: 'old' }, 404], [{ imageId, route: 'neural-analysis' }, 503]]) {
    assert.equal((await h.call('/v1/pattern-jobs', { method: 'POST', token, key: 'different-' + status, data })).status, status)
  }
  const fallback = await h.call('/v1/pattern-jobs', { method: 'POST', token, key: 'fallback', data: { imageId, route: 'neural-analysis', failureMode: 'best-effort', options: { maxCandidates: 1, styles: ['faithful'] } } })
  assert.equal((await h.done(fallback.json.data.jobId, token)).state, 'succeeded')
  const result = (await h.call(`/v1/pattern-jobs/${fallback.json.data.jobId}/result`, { token })).json.data
  assert.equal(result.actualRoute, 'deterministic'); assert.equal(result.warnings.length, 1)
})
test('cancels running and queued jobs without late completion; reports restart', async t => {
  const h = await harness(t, { workerUrl: new URL('./fixtures/slow-worker.mjs', import.meta.url) }), token = await h.auth()
  const imageId = (await h.upload(token)).json.data.imageId
  const create = key => h.call('/v1/pattern-jobs', { method: 'POST', token, key, data: { imageId } })
  const first = (await create('one')).json.data.jobId, second = (await create('two')).json.data.jobId
  const third = (await create('quota-third')).json.data.jobId
  assert.equal((await create('quota-fourth')).status, 429)
  assert.equal((await create('one')).json.data.jobId, first)
  await h.call(`/v1/pattern-jobs/${third}/cancel`, { token, method: 'POST', data: {} })
  assert.equal((await h.call(`/v1/images/${imageId}`, { token, method: 'DELETE' })).status, 409)
  assert.equal((await h.call(`/v1/pattern-jobs/${second}`, { token })).json.data.state, 'queued')
  for (const id of [second, first]) assert.equal((await h.call(`/v1/pattern-jobs/${id}/cancel`, { token, method: 'POST', data: {} })).json.data.state, 'cancelled')
  assert.equal((await h.call(`/v1/pattern-jobs/${first}/cancel`, { token, method: 'POST', data: {} })).json.data.state, 'cancelled')
  const interrupted = (await create('three')).json.data.jobId
  const queued = (await create('four')).json.data.jobId
  const stale = (await create('old-algorithm')).json.data.jobId
  h.api.store.put('job', { ...h.api.store.get('job', stale), algorithmVersion: 'obsolete' })
  await h.restart()
  assert.equal((await h.call(`/v1/pattern-jobs/${interrupted}`, { token })).json.data.error.code, 'SERVICE_RESTARTED')
  assert.equal((await h.call(`/v1/pattern-jobs/${queued}`, { token })).json.data.state, 'running')
  await h.call(`/v1/pattern-jobs/${queued}/cancel`, { token, method: 'POST', data: {} })
  assert.equal((await h.call(`/v1/pattern-jobs/${stale}`, { token })).json.data.error.code, 'ALGORITHM_VERSION_CHANGED')
})
test('timeout, expiry and production configuration are explicit', async t => {
  let now = Date.now()
  const h = await harness(t, { workerUrl: new URL('./fixtures/slow-worker.mjs', import.meta.url), jobTimeoutMs: 50, retentionMs: 1000, clock: () => now }), token = await h.auth()
  const imageId = (await h.upload(token)).json.data.imageId
  const jobId = (await h.call('/v1/pattern-jobs', { method: 'POST', token, key: 'timeout', data: { imageId } })).json.data.jobId
  assert.equal((await h.done(jobId, token)).error.code, 'JOB_TIMEOUT')
  now += 1500; await h.api.cleanup()
  assert.equal((await h.call(`/v1/pattern-jobs/${jobId}/result`, { token })).status, 410)
  assert.equal((await h.call(`/v1/images/${imageId}`, { token, method: 'DELETE' })).status, 410)
  await assert.rejects(createPatternApi({ dataDir: '.', production: true, devAuth: true }), /Production/)
})
test('quality states preserve explicit export acceptance and empty results', async t => {
  const h = await harness(t, { workerUrl: new URL('./fixtures/quality-worker.mjs', import.meta.url) }), token = await h.auth()
  const imageId = (await h.upload(token)).json.data.imageId
  for (const imageType of ['portrait', 'general']) {
    const jobId = (await h.call('/v1/pattern-jobs', { token, method: 'POST', key: imageType, data: { imageId, options: { imageType } } })).json.data.jobId
    assert.equal((await h.done(jobId, token)).state, 'succeeded')
    const result = (await h.call(`/v1/pattern-jobs/${jobId}/result`, { token })).json.data
    assert.equal(result.generationStatus, imageType === 'portrait' ? 'best-effort' : 'no-valid-candidate')
    const exportPath = `/v1/pattern-jobs/${jobId}/exports/fixture-candidate?format=json`
    assert.equal((await h.call(exportPath, { token })).status, imageType === 'portrait' ? 409 : 404)
    assert.equal((await h.call(exportPath + '&acceptBestEffort=true', { token })).status, imageType === 'portrait' ? 200 : 404)
  }
})
test('enforces remote-analysis consent without contacting the remote provider', async t => {
  const h = await harness(t, { rembgEndpoint: 'https://model.example.test', remoteAnalysisLabel: 'Test operator' }), token = await h.auth()
  const capabilities = (await h.call('/v1/capabilities')).json.data
  assert.equal(capabilities.analysis.requiresConsent, true)
  const imageId = (await h.upload(token)).json.data.imageId
  const request = await h.call('/v1/pattern-jobs', { token, method: 'POST', key: 'remote', data: { imageId, route: 'neural-analysis' } })
  assert.equal(request.status, 422); assert.equal(request.json.error.code, 'REMOTE_CONSENT_REQUIRED')
})

test('normalizes EXIF and alpha without filling transparent board cells', async t => {
  const h = await harness(t), token = await h.auth()
  const oriented = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#cc3311' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer()
  const rotated = await h.upload(token, oriented, 'image/jpeg')
  assert.equal(rotated.status, 201); assert.equal(rotated.json.data.width, 20); assert.equal(rotated.json.data.height, 40)
  const rotatedMeta = await sharp(await readFile(join(h.dataDir, `${rotated.json.data.imageId}.png`))).metadata()
  assert.equal(rotatedMeta.orientation, undefined); assert.equal(rotatedMeta.exif, undefined)
  const pixels = Buffer.alloc(32 * 32 * 4)
  for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) pixels.set([230, 190, 130, 255], (y * 32 + x) * 4)
  const transparent = await sharp(pixels, { raw: { width: 32, height: 32, channels: 4 } }).png().toBuffer()
  const imageId = (await h.upload(token, transparent)).json.data.imageId
  const normalized = await sharp(await readFile(join(h.dataDir, `${imageId}.png`))).raw().toBuffer({ resolveWithObject: true })
  assert.equal(normalized.info.channels, 4); assert.equal(normalized.data[3], 0)
  const jobId = (await h.call('/v1/pattern-jobs', { token, method: 'POST', key: 'alpha', data: { imageId, options: { canvas: { mode: 'fixed', size: { width: 32, height: 32 } }, maxCandidates: 1, styles: ['faithful'], structure: { occupancyMode: 'subject-shape' } } } })).json.data.jobId
  assert.equal((await h.done(jobId, token)).state, 'succeeded')
  const result = (await h.call(`/v1/pattern-jobs/${jobId}/result`, { token })).json.data
  const doc = result.candidates[0].pattern
  assert.equal(doc.grid[0], -1); assert.ok(doc.totalBeads > 0 && doc.totalBeads < 1024)
  assert.equal(doc.totalBeads, doc.materials.reduce((n, m) => n + m.count, 0))
})
