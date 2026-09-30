import { importGrid, validateGrid, resolveSkinIndex } from './region-state.mjs'

const clone = value => structuredClone(value)
const fail = message => { throw new Error(message) }
const text = (value, name, max = 1500) => {
  if (typeof value !== 'string' || value.length > max) fail(name + '格式不正确')
  return value
}
export function createAnnotation(value, { id, title = '未命名标注', sourceName = '', sourceKind = 'import' } = {}) {
  if (['sourceImage','reference','referenceImage','originalImage'].some(key => key in value)) fail('区域标注只接收拼豆格图，不接收原图条件')
  const grid = importGrid(value)
  const count = grid.cells.length
  return {
    schemaVersion: 'region-annotation-v1', id: id ?? crypto.randomUUID(), title, reviewer: '',
    source: { kind: sourceKind, name: sourceName },
    currentGrid: grid, targetGrid: clone(grid),
    editMask: clone(value.editMask ?? Array(count).fill(false)),
    lockedMask: clone(value.lockedMask ?? Array(count).fill(false)),
    skinColorId: value.skinColorId ?? '', prompt: value.prompt ?? '',
    review: { contextConfirmed: false, targetConfirmed: false, notes: '', confirmedAt: null },
    grouping: { groupId: '', confirmed: false },
    rights: { decision: 'pending', basis: 'pending', evidence: '' },
    conditioning: 'bead-grid-only', trainingEligible: false,
  }
}
export function effectiveMask(a) { return a.editMask.map((edit, i) => edit && !a.lockedMask[i]) }
export function invalidate(a, context = true) {
  if (context) a.review.contextConfirmed = false
  a.review.targetConfirmed = false
  a.review.confirmedAt = null
}
export function normalizeTarget(a) {
  const effective = effectiveMask(a)
  a.targetGrid.cells = a.targetGrid.cells.map((cell, i) => effective[i] ? cell : a.currentGrid.cells[i])
}
export function setMaskCell(a, index, mode) {
  if (!Number.isInteger(index) || index < 0 || index >= a.currentGrid.cells.length) return
  if (mode === 'edit' || mode === 'unedit') a.editMask[index] = mode === 'edit'
  else if (mode === 'lock' || mode === 'unlock') a.lockedMask[index] = mode === 'lock'
  else fail('未知蒙版画笔')
  normalizeTarget(a)
  invalidate(a)
}
export function paintTargetCell(a, index, color) {
  if (!a.review.contextConfirmed) fail('请先确认周边与肤色，再修改目标图')
  if (!effectiveMask(a)[index]) fail('只能修改可改区，锁定格与周边保持原样')
  if (!Number.isInteger(color) || color < -1 || color >= a.currentGrid.colors.length) fail('色号无效')
  if (color < 0 && a.currentGrid.cells[index] >= 0) fail('不能删除输入中已有的珠子')
  a.targetGrid.cells[index] = color
  invalidate(a, false)
}
export function contextIssues(a) {
  const mask = effectiveMask(a), issues = []
  if (!mask.some(Boolean)) issues.push('至少选择一格可改区')
  if (!a.currentGrid.cells.some((c, i) => c >= 0 && !mask[i])) issues.push('可改区外须保留有珠的全图周边')
  if (a.currentGrid.cells.some((c, i) => c < 0 && a.editMask[i] && a.lockedMask[i])) issues.push('蒙版中有空格被锁定，请解除锁定')
  if (!a.prompt.trim()) issues.push('填写区域修改指令')
  if (!a.reviewer.trim()) issues.push('填写标注者')
  if (new Set(a.currentGrid.cells.filter(c => c >= 0)).size > 48) issues.push('当前图纸超过 SDXL 的 48 色预算，请先在工作台调整')
  return issues
}
export function completionIssues(a) {
  const issues = contextIssues(a), mask = effectiveMask(a)
  if (!a.review.contextConfirmed) issues.push('尚未确认周边')
  if (a.targetGrid.cells.some((c, i) => mask[i] && c < 0)) issues.push('目标图可改区仍有空格')
  if (!a.targetGrid.cells.some((c, i) => c !== a.currentGrid.cells[i])) issues.push('目标图尚未产生修改')
  if (new Set(a.targetGrid.cells.filter(c => c >= 0)).size > 48) issues.push('目标图超过 48 色预算')
  if (!a.review.notes.trim()) issues.push('填写修改依据或验收说明')
  return issues
}
export function confirmContext(a) {
  const issues = contextIssues(a)
  if (issues.length) fail(issues.join('；'))
  a.review.contextConfirmed = true
}
export function confirmTarget(a) {
  const issues = completionIssues(a)
  if (issues.length) fail(issues.join('；'))
  a.review.targetConfirmed = true
  a.review.confirmedAt = new Date().toISOString()
}
export function modelInput(a) {
  const grid = clone(a.currentGrid), mask = effectiveMask(a)
  const skin = resolveSkinIndex(grid, a.editMask, a.lockedMask, a.skinColorId)
  grid.cells = grid.cells.map((c, i) => mask[i] ? skin : c)
  return grid
}
export function validateAnnotation(value, { allowIncompleteMetadata = false } = {}) {
  if (!value || typeof value !== 'object') fail('标注数据无效')
  const a = clone(value)
  const allowed = new Set(['schemaVersion','id','title','reviewer','source','currentGrid','targetGrid','editMask','lockedMask','skinColorId','prompt','review','grouping','rights','conditioning','trainingEligible'])
  if (Object.keys(a).some(key => !allowed.has(key)) || a.conditioning !== 'bead-grid-only') fail('标注仅支持拼豆格图条件，不能附加原图字段')
  if (a.schemaVersion !== 'region-annotation-v1') fail('不是区域配对标注文件')
  for (const [key, keys] of [
    ['source', ['kind','name']], ['review', ['contextConfirmed','targetConfirmed','notes','confirmedAt']],
    ['grouping', ['groupId','confirmed']], ['rights', ['decision','basis','evidence']],
  ]) {
    if (!a[key] || typeof a[key] !== 'object' || Object.keys(a[key]).some(field => !keys.includes(field))) fail('标注元数据字段无效，不能附加原图条件')
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(a.id)) fail('标注 ID 无效')
  text(a.title, '标题', 200); text(a.reviewer, '标注者', 200)
  if (!a.source || !['import', 'workbench', 'synthetic', 'region'].includes(a.source.kind)) fail('来源类型无效')
  text(a.source.name, '来源文件', 500)
  a.currentGrid = validateGrid(a.currentGrid); a.targetGrid = validateGrid(a.targetGrid)
  const g = a.currentGrid, t = a.targetGrid
  if (JSON.stringify({ ...g, cells: [] }) !== JSON.stringify({ ...t, cells: [] })) fail('目标图必须保留全图尺寸和材料色卡')
  for (const key of ['editMask', 'lockedMask']) {
    if (!Array.isArray(a[key]) || a[key].length !== g.cells.length || a[key].some(v => typeof v !== 'boolean')) fail('蒙版必须覆盖全图且使用布尔值')
  }
  const mask = effectiveMask(a)
  t.cells.forEach((c, i) => {
    if (!mask[i] && c !== g.cells[i]) fail('目标图越过了可改区或修改了锁定格')
    if (g.cells[i] >= 0 && c < 0) fail('目标图删除了已有珠子')
  })
  text(a.skinColorId, '肤色色号', 200)
  if (a.skinColorId && !g.colors.some(c => c.id === a.skinColorId)) fail('肤色色号不在材料色卡中')
  text(a.prompt, '指令')
  if (!a.review || typeof a.review.contextConfirmed !== 'boolean' || typeof a.review.targetConfirmed !== 'boolean') fail('审核状态无效')
  text(a.review.notes, '修改说明', 4000)
  if (a.review.confirmedAt !== null && (typeof a.review.confirmedAt !== 'string' || !Number.isFinite(Date.parse(a.review.confirmedAt)))) fail('审核时间无效')
  if (a.review.contextConfirmed && contextIssues(a).length) fail(contextIssues(a).join('；'))
  if (a.review.targetConfirmed && (completionIssues(a).length || !a.review.confirmedAt)) fail(completionIssues(a).join('；') || '缺少审核时间')
  if (!a.review.targetConfirmed && a.review.confirmedAt !== null) fail('草稿不能保留确认时间')
  if (!a.grouping || typeof a.grouping.confirmed !== 'boolean') fail('分组状态无效')
  text(a.grouping.groupId, '分组', 500)
  if (a.grouping.confirmed && (!a.grouping.groupId.trim() || !a.reviewer.trim())) fail('确认分组需要组名和标注者')
  if (!a.rights || !['pending','granted','denied'].includes(a.rights.decision) || !['pending','owned','author-permission','license'].includes(a.rights.basis)) fail('来源资格状态无效')
  text(a.rights.evidence, '来源依据', 4000)
  if (!allowIncompleteMetadata && a.rights.decision === 'granted' && (a.rights.basis === 'pending' || !a.rights.evidence.trim() || !a.reviewer.trim())) fail('已允许训练的记录需要标注者、依据和证据')
  if (a.trainingEligible !== false) fail('人工标注不能自动升级为训练资格')
  return a
}
export function exportPair(a) {
  a = validateAnnotation(a)
  if (!a.review.targetConfirmed) fail('先确认目标图，再导出配对目标')
  return {
    schemaVersion: 'region-training-pair-v1', annotationId: a.id, source: a.source,
    request: { schemaVersion: 'region-generation-v3', currentGrid: a.currentGrid, editMask: a.editMask,
      lockedMask: a.lockedMask, skinColorId: a.skinColorId || null, prompt: a.prompt,
      inputMode: 'grid-context', fillPolicy: 'all-editable', workingSize: 512,
      maximumColors: 48, adapter: 'none', contextSha256: null },
    targetGrid: a.targetGrid, reviewer: a.reviewer, review: a.review, grouping: a.grouping,
    rights: a.rights, conditioning: 'bead-grid-only', trainingEligible: false,
    pending: ['independent-split-not-frozen', 'dataset-quality-gates-not-passed'],
  }
}
