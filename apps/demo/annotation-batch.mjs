import { validateAnnotation } from './annotation-state.mjs'
const $ = id => document.getElementById(id)
const CURSOR = 'region-annotation-batch-cursor-v1'
export const draftKey = id => 'region-annotation-draft-v1:' + id
function localDraft(id) {
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey(id)) || 'null')
    if (!draft) return null
    draft.annotation = validateAnnotation(draft.annotation, { allowIncompleteMetadata: true })
    return draft
  } catch { return null }
}
export function createBatchController({ getCurrent, adopt, saveCurrent, message }) {
  let batch = null, busy = false
  function index() { return batch?.items.findIndex(item => item.id === getCurrent().annotation?.id) ?? -1 }
  function refresh() {
    const selected = index()
    $('batchPrevious').disabled = busy || !batch || batch.offset === 0
    $('batchNext').disabled = busy || !batch?.hasNext
    $('itemPrevious').disabled = busy || !batch || selected < 0 || batch.offset + selected === 0
    $('itemNext').disabled = busy || !batch || selected < 0 || batch.offset + selected + 1 >= batch.total
    $('saveNext').disabled = busy || selected < 0
    $('batchStart').disabled = busy || !batch?.items.some(item => !item.error)
    $('batchItems').disabled = busy || !batch?.items.length
    if (!batch?.available || !batch.total) {
      $('batchInfo').textContent = '暂无已提取格图 JSON；仍可手动导入。'
      return
    }
    $('batchInfo').textContent = '第 ' + (batch.offset / 20 + 1) + '/' + Math.ceil(batch.total / 20) +
      ' 批 · 本批 ' + batch.items.length + ' 张 · 共 ' + batch.total + ' 张' +
      (selected >= 0 ? ' · 当前 ' + (batch.offset + selected + 1) + '/' + batch.total : ' · 当前打开的是独立标注')
    $('batchItems').value = selected < 0 ? '' : String(selected)
    for (const option of $('batchItems').options) {
      if (!option.value) continue
      const item = batch.items[Number(option.value)], local = localDraft(item.id)
      const record = item.id === getCurrent().annotation?.id ? getCurrent() : local ?? item.record
      const state = item.error ? '无法载入' : record?.annotation?.review.targetConfirmed ? '目标已确认'
        : record?.annotation?.inputReview?.confirmed ? '待改目标' : '待核对格图'
      option.textContent = (batch.offset + Number(option.value) + 1) + '. ' + item.title + ' · ' + state
    }
  }
  async function pending() {
    if (getCurrent().annotation && getCurrent().dirty) {
      await saveCurrent()
      if (getCurrent().dirty) throw new Error('保存期间又产生修改，请保存后再切换')
    }
  }
  function choose(position) {
    const item = batch.items[position]
    if (!item || item.error) throw new Error(item?.error ?? '该文件不可用')
    const local = localDraft(item.id), remote = item.record ?? { annotation: item.annotation, version: 0, dirty: false }
    const selected = local && (local.dirty || local.version >= remote.version) ? local : remote
    const annotation = structuredClone(selected.annotation)
    let dirty = Boolean(selected.dirty)
    if (!selected.version && !annotation.reviewer) {
      annotation.reviewer = localStorage.getItem('region-annotation-reviewer') || ''
      dirty ||= Boolean(annotation.reviewer)
    }
    adopt(annotation, selected.version, dirty)
    localStorage.setItem(CURSOR, JSON.stringify({ datasetId: batch.datasetId, offset: batch.offset, sampleId: item.sampleId }))
    refresh()
    message(local?.dirty && local.version < remote.version
      ? '本地草稿保留，但远端已有新版本。请先导出草稿，再处理版本冲突。'
      : '已载入图库第 ' + (batch.offset + position + 1) + ' 张：' + item.title)
  }
  async function load(offset, snapshot = '') {
    const response = await fetch('/api/annotation-dataset?offset=' + offset + (snapshot ? '&snapshot=' + encodeURIComponent(snapshot) : ''))
    const value = await response.json()
    if (!response.ok) throw new Error(value.detail || '图库加载失败')
    batch = value
    $('batchItems').replaceChildren(new Option('选择本批图纸',''), ...batch.items.map((item,i) => {
      const option = new Option(item.title, String(i)); option.disabled = Boolean(item.error); return option
    }))
    refresh()
  }
  async function run(operation) {
    if (busy) return
    busy = true; refresh()
    try { await operation() } catch (error) { message(error.message, true) }
    finally { busy = false; refresh() }
  }
  async function move(delta, forceSave = false) {
    const current = index()
    if (current < 0) return
    if (forceSave) {
      await saveCurrent()
      if (getCurrent().dirty) throw new Error('请先保存最新修改再切换')
    } else await pending()
    let next = current + delta
    if (next >= batch.items.length && batch.hasNext) { await load(batch.offset + 20, batch.datasetId); next = 0 }
    else if (next < 0 && batch.offset > 0) { await load(batch.offset - 20, batch.datasetId); next = batch.items.length - 1 }
    else if (next < 0 || next >= batch.items.length) { message('已保存，当前已到图库末尾。'); return }
    choose(next)
  }
  $('batchStart').onclick = () => run(async () => { await pending(); choose(batch.items.findIndex(item => !item.error)) })
  $('batchPrevious').onclick = () => run(async () => { await pending(); await load(batch.offset - 20, batch.datasetId); choose(0) })
  $('batchNext').onclick = () => run(async () => { await pending(); await load(batch.offset + 20, batch.datasetId); choose(0) })
  $('itemPrevious').onclick = () => run(() => move(-1))
  $('itemNext').onclick = () => run(() => move(1))
  $('saveNext').onclick = () => run(() => move(1, true))
  $('batchItems').onchange = () => { if ($('batchItems').value === '') return; const position = Number($('batchItems').value); run(async () => { await pending(); choose(position) }) }
  return {
    refresh,
    async initialize() {
      await run(async () => {
        let cursor = null
        try { cursor = JSON.parse(localStorage.getItem(CURSOR) || 'null') } catch {}
        try { await load(cursor?.offset ?? 0, cursor?.datasetId ?? '') }
        catch (error) { await load(0); message(error.message, true) }
        if (!batch.items.length) return
        const current = getCurrent().annotation
        if (!current) {
          const position = batch.items.findIndex(item => item.sampleId === cursor?.sampleId)
          choose(position >= 0 ? position : batch.items.findIndex(item => !item.error))
        }
        refresh()
      })
    },
  }
}
