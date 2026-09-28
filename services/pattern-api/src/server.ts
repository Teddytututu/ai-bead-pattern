import { createServer, type IncomingMessage } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import sharp from 'sharp'
import { getPalette, listPalettes } from '@ai-bead-pattern/material-palettes'
import { createPatternAlgorithm, patternMaterialsCsv, patternSvg, validateFeatureOverrides, isDeepSaturatedInk } from '@ai-bead-pattern/pattern-core'
import { apiLimits, parseCreateJob, record, nonempty, ContractError, type JobView, type ApiErrorBody } from '@ai-bead-pattern/pattern-api-contracts'
import { Store, type Stored, type ImageRecord, type JobRecord, type SavedResult } from './store.js'

const day = 24 * 60 * 60 * 1000
const active = (job: JobRecord) => job.state === 'queued' || job.state === 'running'
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable = false) { super(message) }
}
export interface ApiOptions {
  dataDir: string; production?: boolean; devAuth?: boolean; appId?: string; appSecret?: string; rembgEndpoint?: string
  sam2Endpoint?: string
  remoteAnalysisLabel?: string
  concurrency?: number; maxQueue?: number; jobTimeoutMs?: number; queueTimeoutMs?: number; retentionMs?: number
  clock?: () => number
  login?: (code: string) => Promise<string>
  workerUrl?: URL
}

export async function createPatternApi(options: ApiOptions) {
  const endpoints = [options.rembgEndpoint, options.sam2Endpoint].filter((value): value is string => Boolean(value)).map(value => new URL(value))
  if (endpoints.some(endpoint => !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)) throw new Error('Invalid model endpoint')
  const remoteAnalysis = endpoints.some(endpoint => !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))
  if (remoteAnalysis && !options.remoteAnalysisLabel?.trim()) throw new Error('Remote model endpoints require a processing location label')
  if (options.production && (options.devAuth || !options.appId || !options.appSecret || options.login || options.workerUrl)) {
    throw new Error('Production requires WeChat credentials and forbids development overrides')
  }
  const concurrency = options.concurrency ?? 1, maxQueue = options.maxQueue ?? 20
  const algorithmVersion = createPatternAlgorithm().version
  for (const [key, value] of Object.entries({ concurrency, maxQueue, jobTimeoutMs: options.jobTimeoutMs ?? 60_000, queueTimeoutMs: options.queueTimeoutMs ?? 300_000, retentionMs: options.retentionMs ?? day })) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${key}`)
  }
  const clock = options.clock ?? Date.now, ttl = options.retentionMs ?? day
  const dataDir = resolve(options.dataDir)
  await mkdir(dataDir, { recursive: true })
  await listPalettes()
  const store = new Store(join(dataDir, 'state.sqlite'))
  const imagePath = (id: string) => join(dataDir, `${id}.png`)
  const resultPath = (id: string) => join(dataDir, `${id}.json`)
  const running = new Map<string, { worker: Worker; timer: ReturnType<typeof setTimeout> }>()
  const uploading = new Set<string>()
  const rate = new Map<string, { count: number; until: number }>()
  let closed = false
  function owned<T extends Stored>(kind: string, id: string, owner: string): T {
    const value = store.get<T>(kind, id)
    if (!value || value.owner !== owner) throw new HttpError(404, 'NOT_FOUND', '资源不存在')
    if (value.expiresAt <= clock()) throw new HttpError(410, 'EXPIRED', '资源已过期，请重新上传或生成')
    return value
  }
  function view(job: JobRecord): JobView {
    return { jobId: job.id, state: job.state, stage: job.stage, createdAt: job.createdAt, updatedAt: job.updatedAt,
      expiresAt: job.expiresAt, pollAfterMs: 1500, statusUrl: `/v1/pattern-jobs/${job.id}`,
      ...(job.state === 'succeeded' ? { resultUrl: `/v1/pattern-jobs/${job.id}/result` } : {}),
      ...(job.error ? { error: job.error } : {}) }
  }
  function terminal(id: string, state: 'failed' | 'cancelled' | 'succeeded', error?: ApiErrorBody) {
    const job = store.get<JobRecord>('job', id)
    if (!job || !active(job)) return
    job.state = state; job.stage = state; job.updatedAt = clock(); job.expiresAt = clock() + ttl
    if (error) job.error = error
    store.put('job', job)
    const image = store.get<ImageRecord>('image', job.imageId)
    if (image) { image.expiresAt = Math.max(image.expiresAt, clock() + ttl); store.put('image', image) }
  }
  for (const job of store.list<JobRecord>('job')) if (job.state === 'running') {
    terminal(job.id, 'failed', { code: 'SERVICE_RESTARTED', message: '服务已重启，请重新生成', retryable: true })
  }
  async function release(id: string) {
    const task = running.get(id)
    if (task) { clearTimeout(task.timer); await task.worker.terminate(); running.delete(id) }
    if (!closed) pump()
  }
  function pump() {
    if (closed) return
    const jobs = store.list<JobRecord>('job').filter(j => j.state === 'queued').sort((a, b) => a.createdAt - b.createdAt)
    for (const job of jobs) {
      if (running.size >= concurrency) break
      if (job.algorithmVersion !== algorithmVersion) {
        terminal(job.id, 'failed', { code: 'ALGORITHM_VERSION_CHANGED', message: '算法版本已更新，请重新生成', retryable: true }); continue
      }
      if (clock() - job.createdAt >= (options.queueTimeoutMs ?? 300_000)) {
        terminal(job.id, 'failed', { code: 'QUEUE_TIMEOUT', message: '排队超时，请稍后重试', retryable: true }); continue
      }
      job.state = 'running'; job.stage = 'decoding'; job.updatedAt = clock(); store.put('job', job)
      let worker: Worker
      try {
        worker = new Worker(options.workerUrl ?? new URL('./worker.js', import.meta.url), {
          workerData: { job, imagePath: imagePath(job.imageId), rembgEndpoint: options.rembgEndpoint, sam2Endpoint: options.sam2Endpoint },
          resourceLimits: { maxOldGenerationSizeMb: 512 },
        })
      } catch {
        terminal(job.id, 'failed', { code: 'WORKER_UNAVAILABLE', message: '计算服务暂不可用', retryable: true }); continue
      }
      let received = false
      const timer = setTimeout(() => {
        terminal(job.id, 'failed', { code: 'JOB_TIMEOUT', message: '生成超时，请减少尺寸或候选数', retryable: true })
        void release(job.id)
      }, options.jobTimeoutMs ?? (job.request.route === 'neural-analysis' ? (options.sam2Endpoint ? 300_000 : 180_000) : 60_000))
      running.set(job.id, { worker, timer })
      worker.on('message', (message: { type: string; stage?: string; error?: ApiErrorBody; result?: SavedResult }) => {
        if (closed) return
        const current = store.get<JobRecord>('job', job.id)
        if (!current || current.state !== 'running') return
        if (message.type === 'stage') {
          current.stage = message.stage ?? 'generating'; current.updatedAt = clock(); store.put('job', current)
        } else if (message.type === 'failure') {
          received = true; terminal(job.id, 'failed', message.error); void release(job.id)
        } else if (message.type === 'result' && message.result) {
          received = true
          void (async () => {
            try {
              await writeFile(resultPath(job.id), JSON.stringify(message.result))
              if (!closed && store.get<JobRecord>('job', job.id)?.state === 'running') terminal(job.id, 'succeeded')
              else await rm(resultPath(job.id), { force: true })
            } catch {
              if (!closed) terminal(job.id, 'failed', { code: 'STORAGE_FAILED', message: '结果保存失败', retryable: true })
            } finally { await release(job.id) }
          })()
        }
      })
      worker.on('error', () => {
        if (!closed) terminal(job.id, 'failed', { code: 'WORKER_FAILED', message: '计算进程失败，请重试', retryable: true })
        void release(job.id)
      })
      worker.on('exit', () => {
        if (!closed && !received && running.has(job.id) && store.get<JobRecord>('job', job.id)?.state === 'running') {
          terminal(job.id, 'failed', { code: 'WORKER_EXITED', message: '计算进程已退出', retryable: true }); void release(job.id)
        }
      })
    }
  }
  async function cleanup() {
    const now = clock(), protectedImages = new Set(store.list<JobRecord>('job').filter(active).map(j => j.imageId))
    for (const kind of ['image', 'job', 'session']) for (const value of store.list<Stored>(kind)) {
      if (value.expiresAt > now || (kind === 'image' && protectedImages.has(value.id)) || (kind === 'job' && active(value as JobRecord))) continue
      if (kind !== 'session') await rm(kind === 'image' ? imagePath(value.id) : resultPath(value.id), { force: true })
      if (kind === 'session' || value.expiresAt + ttl < now) store.remove(kind, value.id)
    }
    store.db.prepare('DELETE FROM idempotency WHERE expires <= ?').run(now)
    for (const [key, entry] of rate) if (entry.until < now) rate.delete(key)
    for (const job of store.list<JobRecord>('job')) if (job.state === 'queued' && now - job.createdAt >= (options.queueTimeoutMs ?? 300_000)) {
      terminal(job.id, 'failed', { code: 'QUEUE_TIMEOUT', message: '排队超时', retryable: true })
    }
  }
  async function body(request: IncomingMessage, limit: number): Promise<Buffer> {
    if (Number(request.headers['content-length'] ?? 0) > limit) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求内容过大')
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk); size += buffer.length
      if (size > limit) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求内容过大')
      chunks.push(buffer)
    }
    return Buffer.concat(chunks)
  }
  async function json(request: IncomingMessage): Promise<unknown> {
    if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '需要 application/json')
    try { return JSON.parse((await body(request, 64 * 1024)).toString('utf8')) }
    catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'INVALID_JSON', 'JSON 格式错误') }
  }
  async function login(code: string): Promise<string> {
    if (options.login) return options.login(code)
    if (!options.appId || !options.appSecret) throw new HttpError(503, 'AUTH_NOT_CONFIGURED', '微信登录尚未配置')
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
    url.search = new URLSearchParams({ appid: options.appId, secret: options.appSecret, js_code: code, grant_type: 'authorization_code' }).toString()
    let response: Response
    try { response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' }) }
    catch { throw new HttpError(503, 'WECHAT_UNAVAILABLE', '微信登录暂不可用', true) }
    if (!response.ok) throw new HttpError(503, 'WECHAT_UNAVAILABLE', '微信登录暂不可用', true)
    const result = record(await response.json())
    if (typeof result.openid !== 'string' || result.errcode) throw new HttpError(401, 'WECHAT_CODE_INVALID', '登录凭证失效，请重新登录')
    return hash(`${options.appId}:${result.openid}`)
  }
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000, maxHeaderSize: 16 * 1024 }, async (request, response) => {
    const requestId = randomUUID()
    response.setHeader('X-Request-Id', requestId); response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff')
    const send = (data: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ data, requestId })) }
    try {
      const ip = request.socket.remoteAddress ?? 'unknown', now = clock()
      let bucket = rate.get(ip)
      if (!bucket || bucket.until <= now) { bucket = { count: 0, until: now + 60_000 }; if (rate.size >= 10_000) throw new HttpError(429, 'RATE_LIMITED', '请求过多', true); rate.set(ip, bucket) }
      if (++bucket.count > 120) throw new HttpError(429, 'RATE_LIMITED', '请求过多，请稍后重试', true)
      const url = new URL(request.url ?? '/', 'http://localhost'), path = url.pathname, method = request.method
      if (path === '/healthz' && method === 'GET') return send({ status: 'ok' })
      if (path === '/v1/capabilities' && method === 'GET') return send({ apiVersion: 'v1', defaultPaletteId: 'mard-291', routes: ['deterministic', ...(options.rembgEndpoint || options.sam2Endpoint ? ['neural-analysis'] : [])], limits: apiLimits,
        features: { independentContours: true, manualFeatureOverrides: true, featureCoordinateSpace: 'normalized-upload-pixels', templateVersion: 'feature-templates-v2' },
        analysis: { configured: endpoints.length > 0, requiresConsent: remoteAnalysis, locationLabel: options.remoteAnalysisLabel ?? '自有本机服务' }, retentionMs: ttl })
      if ((path === '/v1/auth/wechat' || path === '/v1/auth/dev') && method === 'POST') {
        const input = record(await json(request), path.endsWith('/dev') ? ['userId'] : ['code'])
        let owner: string
        if (path.endsWith('/dev')) {
          if (!options.devAuth || options.production) throw new HttpError(404, 'NOT_FOUND', '资源不存在')
          owner = `dev:${nonempty(input.userId, 'userId')}`
        } else owner = await login(nonempty(input.code, 'code', 512))
        const token = randomBytes(32).toString('base64url'), expiresAt = now + day
        store.put('session', { id: hash(token), owner, expiresAt })
        return send({ token, expiresAt })
      }
      if (path === '/v1/palettes' && method === 'GET') return send((await listPalettes()).map(({ id, name, version, colorCount, automaticColorCount, brand }) => ({ id, name, version, colorCount, automaticColorCount, brand })))
      const paletteRoute = /^\/v1\/palettes\/([a-z0-9-]+)$/.exec(path)
      if (paletteRoute && method === 'GET') {
        let palette
        try { palette = await getPalette(paletteRoute[1]!, url.searchParams.get('version') ?? undefined) }
        catch { throw new HttpError(404, 'PALETTE_NOT_FOUND', '色卡或版本不存在') }
        const etag = `"${palette.version}"`; response.setHeader('ETag', etag); response.setHeader('Cache-Control', 'public, max-age=300')
        if (request.headers['if-none-match'] === etag) { response.writeHead(304); response.end(); return }
        return send(palette)
      }
      const authorization = request.headers.authorization
      const session = authorization?.startsWith('Bearer ') ? store.get<Stored>('session', hash(authorization.slice(7))) : undefined
      if (!session || session.expiresAt <= now) throw new HttpError(401, 'SESSION_EXPIRED', '请重新登录')
      const owner = session.owner
      if (path === '/v1/images' && method === 'POST') {
        if (uploading.has(owner) || uploading.size >= 2) throw new HttpError(429, 'UPLOAD_BUSY', '图片处理中，请稍后重试', true)
        uploading.add(owner)
        try {
        const contentType = request.headers['content-type'] ?? ''
        if (!contentType.startsWith('multipart/form-data;')) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '需要 multipart 图片上传')
        let form: FormData
        try { form = await new Request('http://localhost', { method: 'POST', headers: { 'content-type': contentType }, body: new Uint8Array(await body(request, apiLimits.uploadBytes + 16 * 1024)) }).formData() }
        catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'INVALID_MULTIPART', '上传格式错误') }
        const entries = [...form.entries()], file = form.get('file')
        if (entries.length !== 1 || !file || typeof file === 'string' || file.size === 0) throw new HttpError(422, 'INVALID_IMAGE', '请上传一个 file 图片文件')
        if (file.size > apiLimits.uploadBytes) throw new HttpError(413, 'IMAGE_TOO_LARGE', '图片超过 5 MiB')
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new HttpError(415, 'IMAGE_FORMAT', '仅支持 JPEG、PNG、WebP')
        let normalized: Buffer, width: number, height: number
        try {
          const bytes = Buffer.from(await file.arrayBuffer())
          const decoder = sharp(bytes, { limitInputPixels: apiLimits.sourcePixels, failOn: 'warning' })
          const meta = await decoder.metadata()
          const mimeByFormat: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
          const formatMime = mimeByFormat[meta.format ?? '']
          if (!formatMime || formatMime !== file.type || (meta.pages ?? 1) !== 1) throw new Error('format')
          const output = await decoder.rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).toColourspace('srgb').png().toBuffer({ resolveWithObject: true })
          normalized = output.data; width = output.info.width; height = output.info.height
        } catch { throw new HttpError(422, 'INVALID_IMAGE', '图片损坏、尺寸过大或格式不支持') }
        const digest = hash(normalized), prior = store.list<ImageRecord>('image', owner).find(i => i.hash === digest && i.expiresAt > now)
        if (prior) return send({ imageId: prior.id, width: prior.width, height: prior.height, expiresAt: prior.expiresAt })
        if (store.list<ImageRecord>('image', owner).filter(i => i.expiresAt > now).length >= 10) throw new HttpError(429, 'IMAGE_QUOTA', '图片数量已达上限，请先删除旧图片', true)
        const id = `img_${randomUUID()}`, expiresAt = now + ttl
        await writeFile(imagePath(id), normalized)
        const value: ImageRecord = { id, owner, expiresAt, hash: digest, width, height }; store.put('image', value)
        return send({ imageId: id, width, height, expiresAt }, 201)
        } finally { uploading.delete(owner) }
      }
      const imageRoute = /^\/v1\/images\/(img_[\w-]+)$/.exec(path)
      if (imageRoute && method === 'DELETE') {
        const image = owned<ImageRecord>('image', imageRoute[1]!, owner)
        if (store.list<JobRecord>('job', owner).some(j => j.imageId === image.id && active(j))) throw new HttpError(409, 'IMAGE_IN_USE', '图片正在用于生成')
        store.remove('image', image.id)
        try { await rm(imagePath(image.id), { force: true }) }
        catch (error) { store.put('image', image); throw error }
        return send({ deleted: true })
      }
      if (path === '/v1/pattern-jobs' && method === 'POST') {
        const input = parseCreateJob(await json(request)), key = nonempty(request.headers['idempotency-key'], 'Idempotency-Key')
        const fingerprint = hash(JSON.stringify(input))
        const prior = store.db.prepare('SELECT * FROM idempotency WHERE owner=? AND key=? AND expires>?').get(owner, key, now)
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键的参数不同')
          return send(view(owned<JobRecord>('job', String(prior.jobId), owner)), 202)
        }
        const image = owned<ImageRecord>('image', input.imageId, owner)
        try { validateFeatureOverrides(input.options.featureOverrides, image.width, image.height) }
        catch { throw new HttpError(422, 'INVALID_FEATURE', '五官坐标或模板无效，请使用上传接口返回的图片尺寸') }
        let palette
        try { palette = await getPalette(input.paletteId, input.paletteVersion) }
        catch { throw new HttpError(404, 'PALETTE_NOT_FOUND', '色卡或版本不存在') }
        // Recheck after asynchronous palette loading; retries must bypass current queue quotas.
        const raced = store.db.prepare('SELECT * FROM idempotency WHERE owner=? AND key=? AND expires>?').get(owner, key, now)
        if (raced) {
          if (raced.fingerprint !== fingerprint) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键的参数不同')
          return send(view(owned<JobRecord>('job', String(raced.jobId), owner)), 202)
        }
        if (input.options.maxColors > palette.automaticColorCount) throw new HttpError(422, 'COLOR_LIMIT', '用色数量超过当前色卡可自动匹配的颜色数')
        if (input.options.structure?.contours?.colorId !== undefined && !palette.colors.some(color => color.id === input.options.structure!.contours!.colorId && color.automaticMatch !== false)) throw new HttpError(422, 'INVALID_CONTOUR_COLOR', '轮廓色必须属于当前色卡且可自动匹配')
        if (palette.id === 'mard-291' && input.options.structure?.contours?.colorId !== undefined
          && !isDeepSaturatedInk(palette.colors.find(color => color.id === input.options.structure!.contours!.colorId)!)) throw new HttpError(422, 'INVALID_CONTOUR_COLOR', `MARD 291 描边必须选用深色高饱和子集：${palette.colors.filter(isDeepSaturatedInk).map(color => color.id).join('、')}`)
        if (input.route === 'neural-analysis' && remoteAnalysis && input.consentToRemoteAnalysis !== true) throw new HttpError(422, 'REMOTE_CONSENT_REQUIRED', '使用此分析服务前需要单独同意图片传输')
        if (input.route === 'neural-analysis' && !options.rembgEndpoint && !options.sam2Endpoint && input.failureMode === 'strict') throw new HttpError(503, 'AI_UNAVAILABLE', 'AI 分析尚未配置', true)
        const allJobs = store.list<JobRecord>('job'), mine = allJobs.filter(j => j.owner === owner && j.expiresAt > now)
        if (allJobs.filter(j => j.state === 'queued').length >= maxQueue || mine.filter(active).length >= 3 || mine.length >= 100) throw new HttpError(429, 'QUEUE_FULL', '任务数量已达上限，请稍后重试', true)
        const id = `job_${randomUUID()}`
        const job: JobRecord = { id, owner, imageId: image.id, state: 'queued', stage: 'queued', request: { ...input, paletteVersion: palette.version }, palette, algorithmVersion, createdAt: now, updatedAt: now, expiresAt: now + ttl }
        // No await between idempotency lookup, ownership checks, quotas, and transaction writes.
        owned<ImageRecord>('image', image.id, owner)
        store.db.exec('BEGIN IMMEDIATE')
        try {
          store.put('job', job)
          store.db.prepare('INSERT OR REPLACE INTO idempotency VALUES (?,?,?,?,?)').run(owner, key, fingerprint, id, now + day)
          store.db.exec('COMMIT')
        } catch (e) { store.db.exec('ROLLBACK'); throw e }
        send(view(job), 202); pump(); return
      }
      const jobRoute = /^\/v1\/pattern-jobs\/(job_[\w-]+)(?:\/(result|cancel|exports)(?:\/([\w-]+))?)?$/.exec(path)
      if (jobRoute) {
        const job = owned<JobRecord>('job', jobRoute[1]!, owner), action = jobRoute[2]
        if (!action && method === 'GET') return send(view(job))
        if (action === 'cancel' && method === 'POST') {
          terminal(job.id, 'cancelled'); await release(job.id)
          return send(view(owned<JobRecord>('job', job.id, owner)))
        }
        if (method === 'GET' && (action === 'result' || action === 'exports')) {
          if (job.state !== 'succeeded') throw new HttpError(409, 'RESULT_NOT_READY', '结果尚未就绪')
          const saved = JSON.parse(await readFile(resultPath(job.id), 'utf8')) as SavedResult
          if (action === 'result') return send(saved.view)
          const candidate = saved.view.candidates.find(c => c.id === jobRoute[3])
          if (!candidate) throw new HttpError(404, 'CANDIDATE_NOT_FOUND', '候选不存在')
          if (saved.view.generationStatus === 'no-valid-candidate' || (!candidate.valid && (saved.view.generationStatus !== 'best-effort' || url.searchParams.get('acceptBestEffort') !== 'true'))) throw new HttpError(409, 'QUALITY_CONFIRMATION_REQUIRED', '此候选需确认质量后导出')
          const pattern = saved.patterns[candidate.id]!, format = url.searchParams.get('format') ?? 'png'
          let bytes: Buffer, type: string
          if (format === 'json') { bytes = Buffer.from(JSON.stringify(candidate.pattern)); type = 'application/json' }
          else if (format === 'csv') { bytes = Buffer.from(patternMaterialsCsv(pattern)); type = 'text/csv; charset=utf-8' }
          else if (format === 'png') { bytes = await sharp(Buffer.from(patternSvg(pattern))).png().toBuffer(); type = 'image/png' }
          else throw new HttpError(422, 'INVALID_FORMAT', '导出格式无效')
          response.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Content-Disposition': `attachment; filename="${job.id}.${format}"` }); response.end(bytes); return
        }
      }
      throw new HttpError(404, 'NOT_FOUND', '接口不存在')
    } catch (error) {
      const issue = error instanceof HttpError ? error : error instanceof ContractError
        ? new HttpError(422, 'INVALID_REQUEST', error.message) : new HttpError(500, 'INTERNAL_ERROR', '服务暂不可用', true)
      if (!response.headersSent && !response.destroyed) {
        if (issue.status === 429) response.setHeader('Retry-After', '5')
        response.writeHead(issue.status, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: { code: issue.code, message: issue.message, retryable: issue.retryable }, requestId }))
      }
    }
  })
  const cleanupTimer = setInterval(() => { if (!closed) void cleanup().catch(() => {}) }, 30_000)
  cleanupTimer.unref()
  await cleanup(); pump()
  return { server, store, cleanup,
    async close() {
      closed = true; clearInterval(cleanupTimer)
      for (const task of running.values()) clearTimeout(task.timer)
      await Promise.all([...running.values()].map(task => task.worker.terminate()))
      running.clear()
      if (server.listening) await new Promise<void>((resolveClose, reject) => { server.close(error => error ? reject(error) : resolveClose()); server.closeAllConnections() })
      store.close()
    },
  }
}
