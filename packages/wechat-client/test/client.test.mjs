import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { WechatPatternClient, ApiError } from '../dist/index.js'
function transport(request) { return { request, login: opts => opts.success({ code: 'code' }), uploadFile: () => {}, downloadFile: () => {} } }
test('retries creation with the same idempotency key and parses upload JSON strings', async () => {
  const calls = []
  const wx = transport(options => { calls.push(options); if (calls.length === 1) options.fail({ errMsg: 'offline' }); else options.success({ statusCode: 202, data: { data: { jobId: 'job_1' }, requestId: 'r' } }); return { abort() {} } })
  wx.uploadFile = opts => { assert.equal(opts.name, 'file'); opts.success({ statusCode: 201, data: JSON.stringify({ data: { imageId: 'img_1' }, requestId: 'r' }) }); return { abort() {} } }
  const client = new WechatPatternClient({ wx, baseUrl: 'https://example.test', token: 'token', sleep: async () => {} })
  assert.equal((await client.createPatternJob({ imageId: 'img_1' }, 'stable')).jobId, 'job_1')
  assert.deepEqual(calls.map(c => c.header['Idempotency-Key']), ['stable', 'stable'])
  assert.equal((await client.uploadImage('/tmp/image.png')).imageId, 'img_1')
})
test('HTTP failure is not success, 401 clears credentials, cancellation stops waiting', async () => {
  let expired = 0
  const wx = transport(opts => { opts.success({ statusCode: 401, data: { error: { code: 'SESSION_EXPIRED', message: 'expired', retryable: false }, requestId: 'r' } }); return { abort() {} } })
  const client = new WechatPatternClient({ wx, baseUrl: 'https://example.test', token: 'old', onSessionExpired: () => expired++ })
  await assert.rejects(client.getPatternJob('x'), error => error instanceof ApiError && error.status === 401)
  assert.equal(expired, 1)
  let calls = 0
  wx.request = opts => { calls++; assert.equal(opts.header.Authorization, undefined); opts.success({ statusCode: 200, data: { data: { state: 'running', pollAfterMs: 10_000 }, requestId: 'r' } }); return { abort() {} } }
  const wait = client.waitForPatternJob('x')
  wait.stop()
  await assert.rejects(wait.promise, e => e.code === 'WAIT_STOPPED')
  assert.equal(calls, 1)
})
test('CommonJS distribution loads without Node-only runtime dependencies', () => {
  const sdk = createRequire(import.meta.url)('../dist-cjs/index.js')
  assert.equal(typeof sdk.WechatPatternClient, 'function')
})

test('429 backs off and a download 401 invalidates the session', async () => {
  let calls = 0, expired = 0
  const sleeps = []
  const wx = transport(opts => {
    if (++calls === 1) opts.success({ statusCode: 429, data: { error: { code: 'RATE_LIMITED', message: 'busy', retryable: true } } })
    else { assert.equal(opts.header.Authorization, undefined); opts.success({ statusCode: 200, data: { data: [] } }) }
    return { abort() {} }
  })
  wx.downloadFile = opts => { opts.success({ statusCode: 401, tempFilePath: '' }); return { abort() {} } }
  const client = new WechatPatternClient({ wx, baseUrl: 'https://example.test', token: 'old', onSessionExpired: () => expired++, sleep: async ms => { sleeps.push(ms) } })
  await assert.rejects(client.downloadExport('job', 'candidate', 'png'), error => error.status === 401)
  assert.equal(expired, 1)
  assert.deepEqual(await client.listPalettes(), [])
  assert.equal(calls, 2); assert.equal(sleeps.length, 1); assert.ok(sleeps[0] >= 500)
})
