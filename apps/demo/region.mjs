import { importProductGrid, eyeRectangle, mergeEyeGuidance, PRODUCT_MASK_PURPOSE } from './src/eye-region-guidance.mjs'
import { verifyCandidate, exportDocument, resolveSkinIndex } from './region-state.mjs'
const $ = (id) => document.getElementById(id)
let grid = null, original = null, editMask = [], lockedMask = [], prepared = null
let paintedMask = [], eyeBoxes = [], eyeDrag = null
let candidate = null, pendingRequest = null, busy = false, history = [], accepted = [], events = [], revision = 0
const status = (message, error = false) => { $('status').textContent = message; $('status').dataset.error = String(error) }
const clone = (v) => structuredClone(v)
function updateButtons() {
  $('prepare').disabled = busy || !grid
  $('clear').disabled = busy || !grid
  $('removeEyeBox').disabled = busy || !eyeBoxes.length
  $('guidanceStatus').textContent = grid ? '生成辅助区域 · '+eyeBoxes.length+' 个眼睛框 · '+editMask.filter(Boolean).length+' 格（原图保持到接受候选）' : '先从工作台带入完整格图'
  $('generate').disabled = busy || !prepared
  $('accept').disabled = busy || !candidate || candidate.changedCells.length === 0
  $('reject').disabled = busy || !candidate
  $('undo').disabled = busy || !history.length
  $('export').disabled = busy || !grid || grid.cells.some((v, i) => editMask[i] && v < 0)
  $('audit').disabled = busy || !events.length
}
function invalidate() { revision++; prepared = null; candidate = null; pendingRequest = null; $('phase').textContent = '周边未确认或输入已变化，请先完成第 1 步'; draw(); updateButtons() }
function geometry(g, size = 640) {
  const scale = Math.floor(size / Math.max(g.width, g.height))
  return { scale, x: Math.floor((size - g.width * scale) / 2), y: Math.floor((size - g.height * scale) / 2) }
}
function paint(canvas, g, overlay = false, hole = false) {
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f6f8fa'; ctx.fillRect(0, 0, canvas.width, canvas.height)
  if (!g) return
  const { scale, x, y } = geometry(g)
  const skinIndex = hole ? resolveSkinIndex(g, editMask, lockedMask, $('skin').value) : 0
  g.cells.forEach((c, i) => {
    const px = x + i % g.width * scale, py = y + Math.floor(i / g.width) * scale
    {
      const empty = hole && editMask[i] && !lockedMask[i]
      ctx.fillStyle = empty ? `rgb(${g.colors[skinIndex].rgb.join(',')})` : c < 0 ? '#e1e7eb' : `rgb(${g.colors[c].rgb.join(',')})`
      ctx.fillRect(px, py, scale, scale)
      if (c < 0 && !empty) { ctx.strokeStyle = '#bcc7cf'; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + scale, py + scale); ctx.stroke() }
    }
    if (overlay && (lockedMask[i] || editMask[i])) { ctx.fillStyle = lockedMask[i] ? '#f2923377' : '#16b6b577'; ctx.fillRect(px, py, scale, scale) }
    ctx.strokeStyle = '#53647422'; ctx.strokeRect(px, py, scale, scale)
  })
  if (overlay) {
    const boxes = [...eyeBoxes, ...(eyeDrag ? [eyeRectangle(eyeDrag.start, eyeDrag.end, g)] : [])]
    for (const [index, box] of boxes.entries()) {
      ctx.strokeStyle = '#086c64'; ctx.lineWidth = 2
      ctx.strokeRect(x+box.x*scale+1,y+box.y*scale+1,box.width*scale-2,box.height*scale-2)
      ctx.fillStyle='#086c64';ctx.font='12px sans-serif';ctx.fillText(String(index+1),x+box.x*scale+3,y+box.y*scale+13)
    }
  }
}
function draw() {
  paint($('before'), grid, true); paint($('after'), candidate?.grid ?? null)
  paint($('sourceBoard'), grid, false, true)
  $('candidateTitle').textContent = candidate ? '完整填充候选 · 待人工接受' : '填充候选 · 尚无合格候选'
}
function setGrid(value, request = null) {
  grid = importProductGrid(value); original = value.schema === 'bead-pattern-document-v1' ? clone(value) : null
  paintedMask = [...(request?.editMask ?? Array(grid.cells.length).fill(false))]
  eyeBoxes = []; eyeDrag = null; editMask = [...paintedMask]
  lockedMask = request?.lockedMask ?? Array(grid.cells.length).fill(false)
  $('colors').value = Math.max(24, new Set(grid.cells.filter(v => v >= 0)).size)
  $('skin').replaceChildren(new Option('自动建议周边主要色（请核对）', ''), ...grid.colors.map(c => new Option(`${c.id} · RGB ${c.rgb.join(',')}`, c.id)))
  history = []; accepted = []; events = []; showPreview('before')
  invalidate(); status(`已载入 ${grid.width}×${grid.height} 格。涂选后先确认周边，再填充蒙版区。`)
}
async function api(path, body) {
  const response = await fetch('/api/ai/region/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  const result = await response.json()
  if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : JSON.stringify(result.detail ?? result))
  return result
}
function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
$('example').onclick = async () => { try { const r = await api('example'); setGrid(r.currentGrid, r); $('prompt').value = r.prompt; status('自有程序绘制样例：缺少左眼。它不是人工真值或真实照片评测。') } catch (e) { status(e.message, true) } }
$('import').onchange = async (e) => { try { if (e.target.files[0]) setGrid(JSON.parse(await e.target.files[0].text())) } catch (err) { status(err.message, true) } }
let drawing = false
function pointerCell(event, clamp = false) {
  const rect=$('before').getBoundingClientRect(),{x,y,scale}=geometry(grid)
  let gx=Math.floor(((event.clientX-rect.left)*640/rect.width-x)/scale)
  let gy=Math.floor(((event.clientY-rect.top)*640/rect.height-y)/scale)
  if(clamp){gx=Math.max(0,Math.min(grid.width-1,gx));gy=Math.max(0,Math.min(grid.height-1,gy))}
  return gx<0||gy<0||gx>=grid.width||gy>=grid.height?null:{x:gx,y:gy}
}
function rebuildGuidance(){editMask=mergeEyeGuidance(grid,paintedMask,eyeBoxes);invalidate()}
function brush(event) {
  if(!drawing||busy||!grid)return
  const p=pointerCell(event);if(!p)return
  const i=p.y*grid.width+p.x,tool=$('brush').value
  if(tool==='eye-box'||tool==='skin-pick')return
  if(tool==='edit'||tool==='erase'){
    if(tool==='erase'){
      // Erasing a cell detaches rectangle geometry while preserving the remaining mask.
      paintedMask=[...editMask];eyeBoxes=[]
    }
    paintedMask[i]=tool==='edit'
  }else lockedMask[i]=tool==='lock'
  rebuildGuidance()
}
$('before').onpointerdown=e=>{
  if(!grid||busy)return
  const p=pointerCell(e);if(!p)return
  const tool=$('brush').value
  if(tool==='skin-pick'){
    const color=grid.colors[grid.cells[p.y*grid.width+p.x]]
    if(!color){status('请选择有颜色的肤色格。',true);return}
    $('skin').value=color.id;$('brush').value='eye-box';invalidate();status('已从当前拼豆图选取肤色 '+color.id);return
  }
  drawing=true;$('before').setPointerCapture(e.pointerId)
  if(tool==='eye-box'){eyeDrag={start:p,end:p};draw()}else brush(e)
}
$('before').onpointermove=e=>{
  if(eyeDrag){eyeDrag.end=pointerCell(e,true);draw()}else brush(e)
}
$('before').onpointerup=e=>{
  if(eyeDrag){
    const box=eyeRectangle(eyeDrag.start,pointerCell(e,true),grid);eyeDrag=null
    if(!eyeBoxes.some(b=>JSON.stringify(b)===JSON.stringify(box)))eyeBoxes.push(box)
    rebuildGuidance()
  }
  drawing=false
}
$('before').onpointercancel=()=>{drawing=false;eyeDrag=null;draw()}
$('removeEyeBox').onclick=()=>{if(grid&&!busy){eyeBoxes.pop();rebuildGuidance()}}
$('clear').onclick=()=>{paintedMask.fill(false);eyeBoxes=[];rebuildGuidance()}
function showPreview(view){
  for(const [name,id] of [['before','showBefore'],['input','showInput'],['candidate','showCandidate']]){
    $(name+'View').hidden=name!==view;$(id).setAttribute('aria-selected',String(name===view))
  }
}
$('showBefore').onclick=()=>showPreview('before')
$('showInput').onclick=()=>showPreview('input')
$('showCandidate').onclick=()=>showPreview('candidate')
for (const id of ['skin', 'task', 'prompt', 'negative', 'size', 'steps', 'strength', 'guidance', 'seed', 'colors', 'adapter', 'harmony', 'attempts']) $(id).addEventListener('change', invalidate)
function makeRequest() {
  return { schemaVersion: 'region-generation-v3', currentGrid: clone(grid), editMask: [...editMask], lockedMask: [...lockedMask], inputMode: 'grid-context', fillPolicy: 'all-editable',
    task: $('task').value, skinColorId: $('skin').value || null, harmonyStrength: Number($('harmony').value), maxAttempts: Number($('attempts').value),
    prompt: $('prompt').value, negativePrompt: $('negative').value, workingSize: Number($('size').value), steps: Number($('steps').value), strength: Number($('strength').value), guidanceScale: Number($('guidance').value), seed: Number($('seed').value), maximumColors: Number($('colors').value), adapter: $('adapter').value }
}
$('prepare').onclick = async () => {
  if (!grid || busy) return
  invalidate()
  const version = revision, request = makeRequest()
  busy = true; updateButtons()
  try {
    const context = await api('prepare', request)
    if (revision !== version) throw new Error('输入已变化，请重新确认周边')
    prepared = { ...request, contextSha256: context.contextSha256 }
    events.push({ event: 'surroundings-confirmed', time: new Date().toISOString(), context, request })
    $('inputPreview').src = context.preview.input; $('maskPreview').src = context.preview.mask
    $('phase').textContent = `第 1 步完成：周边已冻结，底色 ${context.skinColorId}，待填 ${context.fillableCells} 格`
    status('周边与配色已确认，现在可以进行第 2 步。')
  } catch (err) { status(err.message, true) }
  finally { busy = false; updateButtons() }
}
$('generate').onclick = async () => {
  if (!grid || busy || !prepared) return
  candidate = null; pendingRequest = null; draw()
  const request = clone(prepared)
  const requestRevision = revision
  busy = true; const controls = [...document.querySelectorAll('input,select,textarea,button')]; const disabled = controls.map(c => c.disabled); controls.forEach(c => { c.disabled = true })
  status('第 2 步：根据周边填充蒙版区；未通过检查会自动重试，原格图保持到手动接受。')
  const started = new Date().toISOString()
  try {
    const result = await api('generate', request)
    if (revision !== requestRevision) throw new Error('输入在生成期间发生变化，已丢弃旧候选，请重新生成。')
    if (result.decision === 'candidate') {
      result.grid = verifyCandidate(request, result, grid)
      candidate = result; pendingRequest = request
    }
    events.push({ event: 'generated', started, request, result })
    for (const [id, key] of [['inputPreview', 'input'], ['maskPreview', 'mask'], ['rawPreview', 'generated']]) $(id).src = result.preview[key]
    $('metrics').textContent = JSON.stringify({ decision: result.decision, changedCells: result.changedCells.length, validation: result.validation, diagnostics: result.diagnostics, harmony: result.harmony, attempts: result.attempts.map(a => ({ seed: a.seed, decision: a.decision, validation: a.validation })), metrics: result.metrics, provenance: result.provenance }, null, 2)
    status(candidate ? `已完整填充 ${result.diagnostics.filledCells} 格，未填充 0 格；修改 ${result.changedCells.length} 格。请确认结构与色调后接受。` : `已尝试 ${result.attempts.length} 次，未产生合格候选：${result.validation.reasons.join('；')}。请调整区域或指令后重新确认周边。`, !candidate)
    $('details').open = true; if(candidate)showPreview('candidate'); draw()
  } catch (err) { events.push({ event: 'failed', started, request, error: err.message }); status(err.message, true) }
  finally { busy = false; controls.forEach((c, i) => { c.disabled = disabled[i] }); updateButtons() }
}
$('accept').onclick = () => {
  if (!candidate || !pendingRequest) return
  const reason = $('reason').value.trim(); if (!reason) { status('请填写接受原因。', true); return }
  try {
    const next = verifyCandidate(pendingRequest, candidate, grid)
    history.push({ grid: clone(grid), accepted: clone(accepted) })
    const record = { event: 'accepted', time: new Date().toISOString(), requestSha256: candidate.requestSha256, beforeSha256: candidate.beforeSha256, reason, provenance: candidate.provenance, changedCells: candidate.changedCells }
    accepted.push(record); events.push(record); grid = next; invalidate(); showPreview('before'); status('已接受；可撤销，也可导出当前格图与完整回放记录。')
  } catch (err) { status(err.message, true) }
}
$('reject').onclick = () => {
  const reason = $('reason').value.trim(); if (!reason) { status('请填写拒绝原因。', true); return }
  events.push({ event: 'rejected', time: new Date().toISOString(), requestSha256: candidate.requestSha256, reason }); invalidate(); status('已拒绝，当前格图不变。')
}
$('undo').onclick = () => {
  const previous = history.pop(); if (!previous) return
  events.push({ event: 'undo', time: new Date().toISOString(), reverted: accepted.at(-1)?.requestSha256 })
  grid = previous.grid; accepted = previous.accepted; invalidate(); status('已撤销上次接受。')
}
$('export').onclick = () => download('region-pattern.json', exportDocument(grid, original, accepted))
$('audit').onclick = () => download('region-replay.json', { schemaVersion: 'region-generation-review-v3', maskPurpose: PRODUCT_MASK_PURPOSE, eyeBoxes: clone(eyeBoxes), currentGrid: grid, editMask, lockedMask, accepted, events, humanGold: false, trainingEligible: false })
try {
  const key = new URLSearchParams(location.search).get('input')
  if (key?.startsWith('sdxl-region-')) {
    const raw = localStorage.getItem(key)
    if (raw) { setGrid(JSON.parse(raw)); localStorage.removeItem(key) }
  }
} catch (error) { status(error.message, true) }
try {
  const health = await api('health')
  $('health').textContent = `SDXL · ${health.status} · ${health.adapterConfigured ? 'LoRA 已配置' : '基础模型'}`
  $('adapter').options[1].disabled = !health.adapterConfigured
} catch (error) { $('health').textContent = 'SDXL 服务未启动'; status(error.message, true) }
draw(); updateButtons()

$('annotatePair').hidden = new URLSearchParams(location.search).get('internal') !== '1'
$('annotatePair').onclick = () => {
  try {
    if (!grid) { window.open('/apps/training-annotation/', '_blank', 'noopener'); return }
    const record = { currentGrid: structuredClone(grid), source: { kind: 'region' } }
    const key = 'annotation-input-' + crypto.randomUUID()
    localStorage.setItem(key, JSON.stringify(record))
    window.open('/apps/training-annotation/?input=' + encodeURIComponent(key), '_blank', 'noopener')
  } catch (error) { status(error.message, true) }
}
