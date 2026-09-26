import type { ApiResponse, ApiErrorBody, CreateJobInput, JobView, ResultView, ImageView, SessionView, PaletteSummary, PaletteView } from '../../pattern-api-contracts/dist/index.js'
export type { CreateJobInput, JobView, ResultView, ImageView, SessionView }
export interface WxTask { abort(): void; onProgressUpdate?(callback: (value: { progress: number }) => void): void }
interface WxFailure { errMsg: string }
export interface WxTransport {
  request(options: { url: string; method: 'GET' | 'POST' | 'DELETE'; data?: unknown; header: Record<string, string>; timeout: number; success: (value: { statusCode: number; data: unknown }) => void; fail: (error: WxFailure) => void }): WxTask
  uploadFile(options: { url: string; filePath: string; name: string; header: Record<string, string>; timeout: number; success: (value: { statusCode: number; data: string }) => void; fail: (error: WxFailure) => void }): WxTask
  downloadFile(options: { url: string; header: Record<string, string>; timeout: number; success: (value: { statusCode: number; tempFilePath: string }) => void; fail: (error: WxFailure) => void }): WxTask
  login(options: { success: (value: { code: string }) => void; fail: (error: WxFailure) => void }): void
}
export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly status = 0, readonly requestId?: string) { super(message); this.name = 'ApiError' }
}
export interface ClientOptions {
  baseUrl: string; wx: WxTransport; token?: string; timeoutMs?: number
  onSessionExpired?: () => void; sleep?: (ms: number) => Promise<void>
}
export class WechatPatternClient {
  private token: string
  private readonly baseUrl: string
  constructor(private readonly options: ClientOptions) {
    if (!/^https?:\/\//.test(options.baseUrl)) throw new Error('API baseUrl must use HTTP(S)')
    this.baseUrl = options.baseUrl.replace(/\/+$/, ''); this.token = options.token ?? ''
  }
  setToken(token: string): void { this.token = token }
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...extra }
  }
  private decode<T>(status: number, input: unknown): T {
    let value = input as ApiResponse<T>
    if (typeof input === 'string') {
      try { value = JSON.parse(input) as ApiResponse<T> }
      catch { throw new ApiError('INVALID_RESPONSE', '服务器响应格式错误', status >= 500, status) }
    }
    if (status === 401) { this.token = ''; this.options.onSessionExpired?.() }
    if (status >= 200 && status < 300 && value && typeof value === 'object' && 'data' in value) return value.data
    const error: ApiErrorBody | undefined = value && typeof value === 'object' && 'error' in value ? value.error : undefined
    throw new ApiError(error?.code ?? 'HTTP_ERROR', error?.message ?? `请求失败 (${status})`, error?.retryable ?? (status >= 500 || status === 429), status, value?.requestId)
  }
  private async request<T>(path: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', data?: unknown, extra: Record<string, string> = {}, retry = method === 'GET'): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await new Promise<T>((resolve, reject) => {
          this.options.wx.request({ url: `${this.baseUrl}${path}`, method, ...(data === undefined ? {} : { data }), header: this.headers({ 'Content-Type': 'application/json', ...extra }), timeout: this.options.timeoutMs ?? 20_000,
            success: value => { try { resolve(this.decode<T>(value.statusCode, value.data)) } catch (e) { reject(e) } },
            fail: () => reject(new ApiError('NETWORK_ERROR', '网络连接失败，请重试', true)),
          })
        })
      } catch (error) {
        if (!retry || attempt >= 2 || !(error instanceof ApiError) || !error.retryable) throw error
        await (this.options.sleep ?? (ms => new Promise(r => setTimeout(r, ms))))(Math.min(5000, 500 * 2 ** attempt) + Math.random() * 200)
      }
    }
  }
  async login(): Promise<SessionView> {
    const code = await new Promise<string>((resolve, reject) => this.options.wx.login({ success: v => v.code ? resolve(v.code) : reject(new ApiError('LOGIN_FAILED', '未取得登录凭证')), fail: () => reject(new ApiError('LOGIN_FAILED', '微信登录失败')) }))
    const session = await this.request<SessionView>('/v1/auth/wechat', 'POST', { code })
    this.token = session.token; return session
  }
  async loginDev(userId: string): Promise<SessionView> {
    const session = await this.request<SessionView>('/v1/auth/dev', 'POST', { userId })
    this.token = session.token; return session
  }
  getCapabilities(): Promise<{ apiVersion: string; defaultPaletteId: string; routes: string[]; analysis: { configured: boolean; requiresConsent: boolean; locationLabel: string }; retentionMs: number; limits: { maxColors: number; gridSizes: number[] } }> { return this.request('/v1/capabilities') }
  listPalettes(): Promise<PaletteSummary[]> { return this.request('/v1/palettes') }
  getPalette(id: string, version?: string): Promise<PaletteView> { return this.request(`/v1/palettes/${encodeURIComponent(id)}${version ? `?version=${encodeURIComponent(version)}` : ''}`) }
  uploadImage(filePath: string, onProgress?: (percent: number) => void): Promise<ImageView> {
    return new Promise((resolve, reject) => {
      const task = this.options.wx.uploadFile({ url: `${this.baseUrl}/v1/images`, filePath, name: 'file', header: this.headers(), timeout: 60_000,
        success: v => { try { resolve(this.decode<ImageView>(v.statusCode, v.data)) } catch (e) { reject(e) } },
        fail: () => reject(new ApiError('UPLOAD_FAILED', '上传失败，请重试', true)),
      })
      if (onProgress) task.onProgressUpdate?.(value => onProgress(value.progress))
    })
  }
  deleteImage(imageId: string): Promise<{ deleted: boolean }> { return this.request(`/v1/images/${encodeURIComponent(imageId)}`, 'DELETE') }
  createPatternJob(input: CreateJobInput, idempotencyKey: string): Promise<JobView> {
    if (!idempotencyKey) return Promise.reject(new ApiError('IDEMPOTENCY_KEY_REQUIRED', '需要幂等键'))
    return this.request('/v1/pattern-jobs', 'POST', input, { 'Idempotency-Key': idempotencyKey }, true)
  }
  getPatternJob(id: string): Promise<JobView> { return this.request(`/v1/pattern-jobs/${encodeURIComponent(id)}`) }
  getResult(id: string): Promise<ResultView> { return this.request(`/v1/pattern-jobs/${encodeURIComponent(id)}/result`) }
  cancelJob(id: string): Promise<JobView> { return this.request(`/v1/pattern-jobs/${encodeURIComponent(id)}/cancel`, 'POST', {}, {}, true) }
  waitForPatternJob(id: string, options: { onUpdate?: (job: JobView) => void; timeoutMs?: number } = {}): { promise: Promise<JobView>; stop: () => void } {
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined
    const startedAt = Date.now()
    const promise = (async () => {
      let interval = 1000
      while (!stopped) {
        const job = await this.getPatternJob(id)
        if (stopped) break
        options.onUpdate?.(job)
        if (!['queued', 'running'].includes(job.state)) return job
        if (Date.now() - startedAt > (options.timeoutMs ?? 15 * 60_000)) throw new ApiError('WAIT_TIMEOUT', '等待超时，可稍后继续查询', true)
        await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, Math.max(job.pollAfterMs, interval) + Math.random() * 200) })
        interval = Math.min(5000, interval * 1.5)
      }
      throw new ApiError('WAIT_STOPPED', '已暂停查询')
    })()
    return { promise, stop: () => { stopped = true; if (timer) clearTimeout(timer); wake?.() } }
  }
  downloadExport(jobId: string, candidateId: string, format: 'png' | 'csv' | 'json', acceptBestEffort = false): Promise<string> {
    const path = `/v1/pattern-jobs/${encodeURIComponent(jobId)}/exports/${encodeURIComponent(candidateId)}?format=${format}${acceptBestEffort ? '&acceptBestEffort=true' : ''}`
    return new Promise((resolve, reject) => this.options.wx.downloadFile({ url: `${this.baseUrl}${path}`, header: this.headers(), timeout: 60_000,
      success: v => {
        if (v.statusCode === 401) { this.token = ''; this.options.onSessionExpired?.() }
        if (v.statusCode === 200) resolve(v.tempFilePath)
        else reject(new ApiError('DOWNLOAD_FAILED', `下载失败 (${v.statusCode})`, v.statusCode >= 500 || v.statusCode === 429, v.statusCode))
      },
      fail: () => reject(new ApiError('NETWORK_ERROR', '下载连接失败', true)),
    }))
  }
}
