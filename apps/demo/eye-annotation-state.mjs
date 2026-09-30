import { importGrid, validateGrid } from './region-state.mjs'

export const EYE_SCHEMA = 'eye-annotation-v1'
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const fail = message => { throw new Error(message) }
const keys = (value, allowed, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) fail(name + '字段无效')
}
export function createEyeAnnotation(input, { id = crypto.randomUUID(), title = '眼睛标注', sourceKind = 'import', sourceName = '' } = {}) {
  if (['sourceImage','reference','referenceImage','originalImage'].some(k => k in input)) fail('眼睛标注不接收原照片，只使用拼豆格图')
  const currentGrid = importGrid(input)
  return { schemaVersion: EYE_SCHEMA, id, title,
    source: { kind: sourceKind, name: sourceName }, currentGrid,
    sourceOccupancy: input.inputReview?.occupancy ? [...input.inputReview.occupancy] : currentGrid.cells.map(c => c < 0 ? 0 : 1),
    eyeBoxes: [], eyeMask: currentGrid.cells.map(() => false), skinSample: null, prompt: '',
    status: 'draft', confirmation: null, conditioning: 'bead-grid-only',
    targetMode: 'unchanged-source-grid', trainingEligible: false }
}
export function eyeAnnotationFromDataset(region) {
  const a = createEyeAnnotation(region, { id: region.id, title: region.title, sourceKind: 'dataset', sourceName: region.source.name })
  const r = region.inputReview
  a.source = { ...a.source, datasetId: r.datasetId, sampleId: r.sampleId, gridSha256: r.gridSha256 }
  return validateEyeAnnotation(a)
}
export function maskFromBoxes(grid, boxes) {
  const mask = grid.cells.map(() => false)
  for (const b of boxes) {
    keys(b, ['x','y','width','height'], '眼睛框')
    if (![b.x,b.y,b.width,b.height].every(Number.isInteger) || b.x < 0 || b.y < 0 || b.width < 1 || b.height < 1 || b.x+b.width > grid.width || b.y+b.height > grid.height) fail('眼睛框必须在格图内')
    for (let y=b.y;y<b.y+b.height;y++) for (let x=b.x;x<b.x+b.width;x++) mask[y*grid.width+x]=true
  }
  return mask
}
export function boxBetween(start, end) {
  return { x: Math.min(start.x,end.x), y: Math.min(start.y,end.y),
    width: Math.abs(start.x-end.x)+1, height: Math.abs(start.y-end.y)+1 }
}
export function setEyeBoxes(a, boxes) {
  if (a.status === 'sealed') fail('记录已封存，不能修改')
  if (boxes.length > 64) fail('眼睛框超过数量上限')
  a.eyeMask = maskFromBoxes(a.currentGrid, boxes)
  a.eyeBoxes = structuredClone(boxes)
}
export function sampleSkin(a, x, y) {
  if (a.status === 'sealed') fail('记录已封存，不能修改')
  const g=a.currentGrid
  if (![x,y].every(Number.isInteger) || x<0 || y<0 || x>=g.width || y>=g.height || g.cells[y*g.width+x]<0) fail('请点选图中有颜色的肤色格')
  a.skinSample = { x, y, colorId: g.colors[g.cells[y*g.width+x]].id }
}
export function sealIssues(a) {
  return [
    ...(!a.eyeBoxes.length ? ['请为眼睛画框'] : []),
    ...(!a.skinSample ? ['请在拼豆图上点选肤色'] : []),
    ...(!a.prompt.trim() ? ['请填写 prompt'] : []),
  ]
}
export function validateEyeAnnotation(value) {
  const a=structuredClone(value)
  keys(a, ['schemaVersion','id','title','source','currentGrid','sourceOccupancy','eyeBoxes','eyeMask','skinSample','prompt','status','confirmation','conditioning','targetMode','trainingEligible'], '眼睛标注（仅支持拼豆格图）')
  if (a.schemaVersion!==EYE_SCHEMA || !UUID.test(a.id)) fail('眼睛标注格式或 ID 无效')
  if (typeof a.title!=='string' || a.title.length>200 || typeof a.prompt!=='string' || a.prompt.length>1500) fail('标题或 prompt 格式无效')
  keys(a.source,['kind','name','datasetId','sampleId','gridSha256'],'来源')
  if (!['dataset','import','workbench','region','synthetic'].includes(a.source.kind) || typeof a.source.name!=='string' || a.source.name.length>500) fail('来源无效')
  if (a.source.kind==='dataset' && (typeof a.source.sampleId!=='string' || a.source.sampleId.length>500 || !/^[a-f0-9]{64}$/.test(a.source.datasetId) || !/^[a-f0-9]{64}$/.test(a.source.gridSha256))) fail('图库来源无效')
  a.currentGrid=validateGrid(a.currentGrid)
  if (!Array.isArray(a.sourceOccupancy) || a.sourceOccupancy.length!==a.currentGrid.cells.length || a.sourceOccupancy.some((v,i)=>![0,1,null].includes(v) || (v===0 && a.currentGrid.cells[i]!==-1) || (v===1 && a.currentGrid.cells[i]<0))) fail('原始占用记录无效')
  if (!Array.isArray(a.eyeBoxes) || a.eyeBoxes.length>64) fail('眼睛框无效')
  const mask=maskFromBoxes(a.currentGrid,a.eyeBoxes)
  if (!Array.isArray(a.eyeMask) || JSON.stringify(a.eyeMask)!==JSON.stringify(mask)) fail('眼睛蒙版必须与所有矩形框一致')
  if (a.skinSample!==null) {
    keys(a.skinSample,['x','y','colorId'],'肤色取样')
    const {x,y,colorId}=a.skinSample,g=a.currentGrid
    if (![x,y].every(Number.isInteger) || x<0 || y<0 || x>=g.width || y>=g.height || typeof colorId!=='string' || g.cells[y*g.width+x]<0 || g.colors[g.cells[y*g.width+x]]?.id!==colorId) fail('肤色必须来自图上所点格子')
  }
  if (a.conditioning!=='bead-grid-only' || a.targetMode!=='unchanged-source-grid' || a.trainingEligible!==false) fail('只封存原拼豆图，不编辑目标或自动开启训练')
  if (!['draft','sealed'].includes(a.status)) fail('封存状态无效')
  if (a.status==='draft') {
    if (a.confirmation!==null) fail('草稿不能冒充已确认')
  } else {
    keys(a.confirmation,['method','confirmedAt','grid','eyeMask','skin','prompt'],'统一确认')
    if (a.confirmation.method!=='explicit-seal-click' || typeof a.confirmation.confirmedAt!=='string' || !Number.isFinite(Date.parse(a.confirmation.confirmedAt)) || ['grid','eyeMask','skin','prompt'].some(k=>a.confirmation[k]!==true) || sealIssues(a).length) fail('封存需要确认全部内容')
  }
  return a
}
export function sealEyeAnnotation(value, now = new Date().toISOString()) {
  const a=validateEyeAnnotation(value), issues=sealIssues(a)
  if (issues.length) fail(issues.join('；'))
  a.status='sealed'
  a.confirmation={method:'explicit-seal-click',confirmedAt:now,grid:true,eyeMask:true,skin:true,prompt:true}
  return validateEyeAnnotation(a)
}
