import { WechatPatternClient, ApiError, type ResultView, type JobView, type CreateJobInput, type PaletteSummary } from '../../vendor/sdk'
import { config } from '../../config'
const client = new WechatPatternClient({ baseUrl: config.apiBaseUrl, wx,
  token: String(wx.getStorageSync('patternToken') || ''),
  onSessionExpired: () => wx.removeStorageSync('patternToken'),
})
const stageNames: Record<string, string> = { queued: '排队中', decoding: '读取图片', analyzing: '分析主体', generating: '生成图纸', exporting: '整理结果', succeeded: '生成完成', cancelled: '已取消', failed: '生成失败' }
let result: ResultView | undefined
let waiter: ReturnType<WechatPatternClient['waitForPatternJob']> | undefined
let visible = true
Page({
  data: { imagePath: '', paletteId: 'mard-291', paletteNames: ['正在加载色卡'], paletteIndex: 0,
    palettes: [] as PaletteSummary[], paletteLoading: false, paletteNote: '',
    sizes: [32, 48, 64, 96], sizeIndex: 1, maxColors: 20, colorLimit: 48, busy: false,
    valueModes: ['随风格（还原默认保色）', '保色', '适度增强', '风格化'], valueModeIndex: 0, valueStrength: 100,
    externalContour: true, internalContour: true, contourStatus: '',
    status: '选择图片，生成你的拼豆图纸', error: '', jobId: '', candidates: [] as { id: string; label: string }[],
    selectedIndex: 0, materials: [] as { code: string; hex: string; count: number }[], totalBeads: 0, quality: '', hasResult: false,
  },
  onShow() {
    visible = true
    if (!this.data.palettes.length && !this.data.paletteLoading) void this.loadPalettes()
    const id = wx.getStorageSync('activePatternJob')
    if (typeof id === 'string' && id) { this.setData({ jobId: id }); void this.watch(id) }
  },
  onHide() { visible = false; waiter?.stop() },
  onUnload() { visible = false; waiter?.stop() },
  async loadPalettes() {
    if (this.data.paletteLoading) return
    this.setData({ paletteLoading: true, error: '' })
    try {
      const palettes = await client.listPalettes()
      if (!palettes.length) throw new Error('没有可用色卡')
      const index = Math.max(0, palettes.findIndex(palette => palette.id === this.data.paletteId))
      this.setData({ palettes, paletteNames: palettes.map(palette => palette.name) })
      this.changePalette({ detail: { value: String(index) } })
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : '色卡加载失败，请重试' })
    } finally { this.setData({ paletteLoading: false }) }
  },
  chooseImage() {
    wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['compressed'],
      success: value => { wx.removeStorageSync('pendingPatternRequest'); this.setData({ imagePath: value.tempFiles[0]?.tempFilePath ?? '', error: '' }) },
      fail: () => this.setData({ error: '选图已取消，或相册权限不可用' }),
    })
  },
  changePalette(event: { detail: { value: string } }) {
    const index = Number(event.detail.value), palette = this.data.palettes[index]
    if (!palette) return
    const automaticCount = palette.automaticColorCount ?? palette.colorCount, limit = Math.min(48, automaticCount)
    if (palette.id !== this.data.paletteId) wx.removeStorageSync('pendingPatternRequest')
    this.setData({ paletteIndex: index, paletteId: palette.id, colorLimit: limit, maxColors: Math.min(this.data.maxColors, limit),
      paletteNote: automaticCount < palette.colorCount ? `${palette.colorCount} 色登记，自动配色使用 ${automaticCount} 色；特殊材质色不参与。` : '' })
  },
  changeSize(event: { detail: { value: string } }) { wx.removeStorageSync('pendingPatternRequest'); this.setData({ sizeIndex: Number(event.detail.value) }) },
  changeColors(event: { detail: { value: number } }) { wx.removeStorageSync('pendingPatternRequest'); this.setData({ maxColors: event.detail.value }) },
  changeValueMode(event: { detail: { value: string } }) { wx.removeStorageSync('pendingPatternRequest'); this.setData({ valueModeIndex: Number(event.detail.value) }) },
  changeValueStrength(event: { detail: { value: number } }) { wx.removeStorageSync('pendingPatternRequest'); this.setData({ valueStrength: event.detail.value }) },
  changeExternalContour(event: { detail: { value: boolean } }) { wx.removeStorageSync('pendingPatternRequest'); this.setData({ externalContour: event.detail.value }) },
  changeInternalContour(event: { detail: { value: boolean } }) { wx.removeStorageSync('pendingPatternRequest'); this.setData({ internalContour: event.detail.value }) },
  async generate() {
    if (!this.data.imagePath || this.data.busy || !this.data.palettes.length || this.data.paletteLoading) return
    waiter?.stop(); result = undefined; wx.removeStorageSync('activePatternJob')
    this.setData({ busy: true, hasResult: false, error: '', jobId: '', status: '登录中' })
    try {
      const session = config.devUserId ? await client.loginDev(config.devUserId) : await client.login()
      wx.setStorageSync('patternToken', session.token)
      let pending = wx.getStorageSync('pendingPatternRequest') as { key: string; input: CreateJobInput } | undefined
      if (!pending) {
        this.setData({ status: '上传图片' })
        const image = await client.uploadImage(this.data.imagePath, percent => this.setData({ status: `上传 ${percent}%` }))
        const palette = await client.getPalette(this.data.paletteId), side = this.data.sizes[this.data.sizeIndex]
        pending = { key: `mini-${Date.now()}-${Math.random().toString(36).slice(2)}`, input: { imageId: image.imageId, paletteId: palette.id, paletteVersion: palette.version,
          options: { canvas: { mode: 'fixed', size: { width: side, height: side } }, maxColors: this.data.maxColors, maxCandidates: 3,
            structure: { ...(this.data.valueModeIndex === 0 ? {} : { valueMode: (['preserve', 'adaptive', 'stylized'] as const)[this.data.valueModeIndex - 1] }), valueStrength: this.data.valueStrength / 100,
              contours: { external: this.data.externalContour, internal: this.data.internalContour } } } } }
        wx.setStorageSync('pendingPatternRequest', pending)
      }
      const job = await client.createPatternJob(pending.input, pending.key)
      wx.setStorageSync('activePatternJob', job.jobId); wx.removeStorageSync('pendingPatternRequest')
      this.setData({ jobId: job.jobId, hasResult: false, candidates: [], materials: [] })
      await this.watch(job.jobId)
    } catch (error) { this.handleError(error) }
  },
  async watch(id: string) {
    if (!visible) return
    waiter?.stop()
    this.setData({ busy: true, error: '' })
    const current = client.waitForPatternJob(id, { onUpdate: (job: JobView) => this.setData({ status: stageNames[job.stage] ?? '处理中' }) })
    waiter = current
    try {
      const job = await current.promise
      if (!visible || waiter !== current) return
      if (job.state === 'failed') throw new ApiError(job.error?.code ?? 'FAILED', job.error?.message ?? '生成失败', true)
      if (job.state === 'cancelled') { this.setData({ busy: false, status: '已取消生成' }); return }
      const nextResult = await client.getResult(id)
      if (!visible || waiter !== current) return
      result = nextResult
      this.setData({ busy: false, quality: result.generationStatus, status: result.generationStatus === 'success' ? '图纸已就绪' : result.generationStatus === 'best-effort' ? '此结果需要检查后再制作' : '没有合格候选，请调整尺寸或图片',
        candidates: result.candidates.map((c, i) => ({ id: c.id, label: `${i + 1} · ${c.pattern.colors.length} 色` })), hasResult: result.candidates.length > 0, selectedIndex: 0 }, () => this.renderCandidate(0))
    } catch (error) { if (waiter === current) this.handleError(error) }
  },
  handleError(error: unknown) {
    if (error instanceof ApiError && error.code === 'WAIT_STOPPED') return
    if (error instanceof ApiError && [404, 410].includes(error.status)) { wx.removeStorageSync('activePatternJob'); wx.removeStorageSync('pendingPatternRequest') }
    this.setData({ busy: false, error: error instanceof Error ? error.message : '操作失败，请重试' })
  },
  selectCandidate(event: { currentTarget: { dataset: { index: number } } }) { this.renderCandidate(Number(event.currentTarget.dataset.index)) },
  renderCandidate(index: number) {
    const candidate = result?.candidates[index]
    if (!candidate) return
    const pattern = candidate.pattern
    const contour = candidate.contourPlan
    this.setData({ selectedIndex: index, materials: pattern.materials, totalBeads: pattern.totalBeads,
      contourStatus: contour ? `轮廓 ${contour.diagnostics.retainedCells}/${contour.diagnostics.selectedCells} 格，对比不足 ${contour.diagnostics.unresolvedContrastCells} 格${contour.diagnostics.externalSource === 'unavailable' && contour.options.external ? '；缺少主体蒙版' : ''}${contour.diagnostics.internalSource === 'unavailable' && contour.options.internal ? '；缺少内部区域证据' : ''}` : '' })
    const context = wx.createCanvasContext('patternCanvas', this), cell = 300 / pattern.width
    context.clearRect(0, 0, 300, 300)
    pattern.grid.forEach((colorIndex, i) => {
      if (colorIndex < 0) return
      context.setFillStyle(pattern.colors[colorIndex].hex)
      context.fillRect(i % pattern.width * cell, Math.floor(i / pattern.width) * cell, cell, cell)
    })
    context.draw()
  },
  async cancel() {
    if (!this.data.jobId) return
    try {
      const job = await client.cancelJob(this.data.jobId)
      if (job.state === 'cancelled') { waiter?.stop(); this.setData({ busy: false, status: '已取消生成' }) }
      else await this.watch(job.jobId)
    }
    catch (error) { this.handleError(error) }
  },
  async exportFile(event: { currentTarget: { dataset: { format: 'png' | 'csv' | 'json' } } }) {
    const candidate = result?.candidates[this.data.selectedIndex]
    if (!candidate) return
    let accept = false
    if (result?.generationStatus === 'best-effort') {
      accept = await new Promise<boolean>(resolve => wx.showModal({ title: '检查图纸', content: '此候选未满足全部质量条件，请检查关键特征后再制作。是否继续导出？', success: v => resolve(v.confirm) }))
      if (!accept) return
    }
    try {
      const format = event.currentTarget.dataset.format, filePath = await client.downloadExport(this.data.jobId, candidate.id, format, accept)
      if (format === 'png') wx.saveImageToPhotosAlbum({ filePath, success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }), fail: () => this.setData({ error: '保存失败，请检查相册权限后重试' }) })
      else wx.shareFileMessage({ filePath, fileName: `bead-pattern.${format}`, fail: () => this.setData({ error: '文件分享未完成，可再次下载' }) })
    } catch (error) { this.handleError(error) }
  },
})
