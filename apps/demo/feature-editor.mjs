export function createFeatureEditor({ container, canvas, templates, getImage, getAnalysis, onChange, validate }) {
  container.innerHTML = `<details><summary>五官定位与模板</summary><p>保留原图倾斜和透视；坐标使用原图像素。</p>
    <label>部件 <select data-field="existing"><option value="">新增部件</option></select></label>
    <label>标识 <input data-field="id" value="manual-eye-1" maxlength="128"></label>
    <label>类型 <select data-field="kind"><option value="eye">眼睛</option><option value="nose">鼻子</option><option value="mouth">嘴巴</option></select></label>
    <label>模板 <select data-field="template"></select></label>
    <div class="feature-coordinates"><label>X <input data-field="x" type="number" min="0" value="0" step="0.1"></label><label>Y <input data-field="y" type="number" min="0" value="0" step="0.1"></label></div>
    <div class="feature-coordinates"><label>宽（原图像素）<input data-field="width" type="number" min="1" placeholder="自动"></label><label>高 <input data-field="height" type="number" min="1" placeholder="自动"></label></div>
    <label>角度 <input data-field="angle" type="number" min="-180" max="180" value="0"></label>
    <label><input data-field="hidden" type="checkbox"> 隐藏此部件（遮挡 / 不可见）</label>
    <label><input data-field="locked" type="checkbox" checked> 锁定位置</label>
    <div class="file-actions"><button type="button" class="file-button" data-action="pick">在原图点选</button><button type="button" class="file-button" data-action="save">应用校正</button><button type="button" class="file-button" data-action="remove">撤销此校正</button></div>
    <p data-field="status" aria-live="polite">尚无手动校正</p></details>`
  const field = name => container.querySelector(`[data-field="${name}"]`)
  const changes = new Map()
  let image = getImage(), picking = false
  const status = message => { field('status').textContent = message }
  function refreshTemplates(value = '') {
    field('template').replaceChildren(new Option('自动选择', ''), ...templates.filter(t => t.kind === field('kind').value).map(t => new Option(`${t.id} · ${t.width}×${t.height}`, t.id)))
    field('template').value = value
  }
  function refreshList() {
    const selected = field('existing').value
    const available = new Map((getAnalysis()?.landmarks ?? []).filter(p => ['eye', 'nose', 'mouth'].includes(p.kind) && !/mouth-(left|right)$/.test(p.id)).map(p => [p.id, p]))
    for (const [id, value] of changes) available.set(id, value)
    field('existing').replaceChildren(new Option('新增部件', ''), ...[...available.keys()].map(id => new Option(`${changes.has(id) ? '已校正 · ' : ''}${id}`, id)))
    field('existing').value = selected
  }
  function syncImage() {
    if (image === getImage()) return
    image = getImage(); changes.clear(); picking = false; canvas.style.cursor = ''
    status('新图片：手动校正已清空'); refreshList()
  }
  field('existing').addEventListener('focus', refreshList)
  field('existing').addEventListener('change', () => {
    const id = field('existing').value, p = changes.get(id) ?? getAnalysis()?.landmarks?.find(p => p.id === id)
    if (!p) { field('id').value = `manual-${field('kind').value}-${changes.size + 1}`; return }
    field('id').value = p.id; field('kind').value = p.kind; field('x').value = p.x; field('y').value = p.y
    field('hidden').checked = p.hidden ?? p.observationState === 'missing'; field('locked').checked = p.locked ?? true
    const shape = p.shape ?? p.featureShape
    field('width').value = shape?.widthPx ?? ''; field('height').value = shape?.heightPx ?? ''; field('angle').value = shape?.angleDegrees ?? 0
    refreshTemplates(p.templateId)
  })
  field('kind').addEventListener('change', () => refreshTemplates())
  container.querySelector('[data-action="pick"]').addEventListener('click', () => { picking = true; canvas.style.cursor = 'crosshair'; status('请点击上方原图；点击后再应用校正') })
  canvas.addEventListener('click', event => {
    if (!picking) return
    syncImage()
    const rect = canvas.getBoundingClientRect(), scale = Math.min(canvas.width / image.width, canvas.height / image.height)
    const x = ((event.clientX - rect.left - canvas.clientLeft) * canvas.width / canvas.clientWidth - (canvas.width - image.width * scale) / 2) / scale
    const y = ((event.clientY - rect.top - canvas.clientTop) * canvas.height / canvas.clientHeight - (canvas.height - image.height * scale) / 2) / scale
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) { status('请选择原图内容，不能点在留白区域'); return }
    field('x').value = Math.min(image.width - 0.1, Math.round(x * 10) / 10); field('y').value = Math.min(image.height - 0.1, Math.round(y * 10) / 10)
    picking = false; canvas.style.cursor = ''; status('位置已选定，点击“应用校正”保存')
  })
  container.querySelector('[data-action="save"]').addEventListener('click', () => {
    try {
      syncImage()
      const previous = getAnalysis()?.landmarks?.find(p => p.id === field('id').value)
      const shape = field('width').value && field('height').value ? { widthPx: Number(field('width').value), heightPx: Number(field('height').value), angleDegrees: Number(field('angle').value) } : undefined
      if (Number(field('angle').value) !== 0 && !shape) throw new Error('指定旋转角度时请同时填写原图中的部件宽高')
      const entry = { id: field('id').value, kind: field('kind').value, x: Number(field('x').value), y: Number(field('y').value), hidden: field('hidden').checked, locked: field('locked').checked,
        ...(previous?.instanceId ? { instanceId: previous.instanceId } : {}), ...(field('template').value ? { templateId: field('template').value } : {}), ...(shape ? { shape } : {}) }
      const next = new Map(changes).set(entry.id, entry)
      validate([...next.values()], image.width, image.height)
      changes.set(entry.id, entry); refreshList(); onChange(); status(`已保存 ${changes.size} 个校正；点击“生成图纸”查看结果`)
    } catch (error) { status(`未保存：${error.message}`) }
  })
  container.querySelector('[data-action="remove"]').addEventListener('click', () => { changes.delete(field('id').value); refreshList(); onChange(); status(`剩余 ${changes.size} 个校正`) })
  refreshTemplates(); refreshList()
  return {
    overrides() { syncImage(); return [...changes.values()] },
    draw() {
      syncImage()
      const context = canvas.getContext('2d'), scale = Math.min(canvas.width / image.width, canvas.height / image.height)
      context.save(); context.lineWidth = 2; context.strokeStyle = '#e34822'; context.fillStyle = '#e34822'; context.font = '10px sans-serif'
      for (const p of changes.values()) {
        const x = (canvas.width - image.width * scale) / 2 + p.x * scale, y = (canvas.height - image.height * scale) / 2 + p.y * scale
        context.beginPath(); context.arc(x, y, 4, 0, Math.PI * 2); context.stroke(); context.fillText(p.hidden ? '×' : p.kind, x + 5, y - 5)
      }
      context.restore()
    },
  }
}
