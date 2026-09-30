import { importGrid } from './region-state.mjs'
import { createAnnotation, validateAnnotation, effectiveMask, invalidate, setMaskCell, paintTargetCell, contextIssues, completionIssues, confirmContext, confirmTarget, modelInput, exportPair } from './annotation-state.mjs'
const $ = id => document.getElementById(id)
const KEY = 'region-annotation-workspace-v1'
let annotation = null, version = 0, dirty = false, undo = [], redo = [], brushColor = 0, drawing = false, strokeStarted = false, lastCell = -1
const copy = value => structuredClone(value)
function message(text, error = false) { $('message').textContent = text; $('message').dataset.error = String(error) }
function stash() {
  if (!annotation) return
  try { localStorage.setItem(KEY, JSON.stringify({ annotation, version, dirty })) }
  catch { message('浏览器暂存失败，请保存到远端或导出文件。', true) }
}
function changed(context = true) {
  invalidate(annotation, context); dirty = true; stash(); renderBoards(); update()
}
function checkpoint() { undo.push(copy(annotation)); if (undo.length > 60) undo.shift(); redo = [] }
function canReplace() { return !annotation || !dirty || window.confirm('当前有未保存到远端的修改。先导出或保存可保留进度；确定切换吗？') }
function update() {
  const a = annotation
  for (const id of ['saveRemote','exportDraft','confirmContext','importTarget']) $(id).disabled = !a
  $('undo').disabled = !undo.length; $('redo').disabled = !redo.length
  $('fillSkin').disabled = !a?.review.contextConfirmed
  $('confirmTarget').disabled = !a?.review.contextConfirmed
  $('exportPair').disabled = !a?.review.targetConfirmed
  $('saveState').textContent = !a ? '尚未载入图纸' : dirty ? '浏览器已暂存 · 远端待保存' : version ? '远端已保存 · v' + version : '尚未保存到远端'
  if (!a) return
  const mask = effectiveMask(a)
  const missing = a.targetGrid.cells.filter((c,i) => mask[i] && c < 0).length
  const changes = a.targetGrid.cells.filter((c,i) => c !== a.currentGrid.cells[i]).length
  $('gridInfo').textContent = a.currentGrid.width + ' × ' + a.currentGrid.height + ' 格 · 可改 ' + mask.filter(Boolean).length + ' 格 · 已改 ' + changes + ' 格'
  $('validation').textContent = '未填充 ' + missing + ' 格 · 周边与锁定格受保护。' + (a.review.targetConfirmed ? '' : completionIssues(a).join('；'))
  $('contextStatus').textContent = a.review.contextConfirmed ? '周边已确认，可以在右侧修改目标图。' : '周边待确认：' + (contextIssues(a).join('；') || '核对格图后点击确认')
  $('reviewStatus').textContent = a.review.targetConfirmed ? '目标图已由 ' + a.reviewer + ' 确认；请保存或导出。训练资格仍待数据集审定。' : '当前是草稿，尚未确认目标图。'
  $('selectedColor').textContent = a.currentGrid.colors[brushColor]?.id ?? ''
}
function geometry(g) {
  const scale = Math.floor(640 / Math.max(g.width,g.height))
  return { scale, x: Math.floor((640-g.width*scale)/2), y: Math.floor((640-g.height*scale)/2) }
}
function draw(canvas, grid, overlays = false) {
  const ctx = canvas.getContext('2d'); ctx.clearRect(0,0,640,640)
  ctx.fillStyle = '#eef2ee'; ctx.fillRect(0,0,640,640)
  if (!grid) return
  const {scale,x,y} = geometry(grid)
  grid.cells.forEach((c,i) => {
    const xx=x+i%grid.width*scale, yy=y+Math.floor(i/grid.width)*scale
    ctx.fillStyle = c < 0 ? '#e0e6e1' : 'rgb(' + grid.colors[c].rgb.join(',') + ')'
    ctx.fillRect(xx,yy,scale,scale)
    if (c < 0) { ctx.strokeStyle='#aab8ad'; ctx.beginPath();ctx.moveTo(xx,yy);ctx.lineTo(xx+scale,yy+scale);ctx.stroke() }
    if (overlays && $('overlay').checked && (annotation.lockedMask[i] || annotation.editMask[i])) {
      ctx.fillStyle=annotation.lockedMask[i]?'#e48a3070':'#27b9b34a';ctx.fillRect(xx,yy,scale,scale)
    }
    ctx.strokeStyle='#354f3526';ctx.strokeRect(xx,yy,scale,scale)
  })
}
function renderBoards() {
  draw($('before'),annotation?.currentGrid,true);draw($('target'),annotation?.targetGrid,true)
  draw($('conditioning'),annotation ? modelInput(annotation) : null)
}
function renderPalette() {
  $('palette').replaceChildren()
  if (!annotation) return
  annotation.currentGrid.colors.forEach((color,index) => {
    const button=document.createElement('button'), swatch=document.createElement('i'), label=document.createElement('span')
    button.className='swatch'; button.dataset.index=String(index);button.setAttribute('aria-label',color.id)
    button.setAttribute('aria-pressed',String(index===brushColor))
    swatch.style.background='rgb('+color.rgb.join(',')+')';label.textContent=color.id
    button.append(swatch,label)
    button.onclick=()=>{brushColor=index;$('tool').value='paint';renderPalette();update()}
    $('palette').append(button)
  })
}
function render() {
  const a=annotation
  if (a) {
    for (const [id,value] of [['title',a.title],['reviewer',a.reviewer],['prompt',a.prompt],['notes',a.review.notes],['groupId',a.grouping.groupId],['rightsDecision',a.rights.decision],['rightsBasis',a.rights.basis],['rightsEvidence',a.rights.evidence]]) $(id).value=value
    $('groupConfirmed').checked=a.grouping.confirmed
    $('skin').replaceChildren(new Option('自动建议周边主要色（请核对）',''),...a.currentGrid.colors.map(c=>new Option(c.id+' · RGB '+c.rgb.join(','),c.id)))
    $('skin').value=a.skinColorId
    $('sourceInfo').textContent='来源：'+(a.source.name||a.source.kind)+' · 输入创建后保持不变'
  }
  renderPalette();renderBoards();update()
}
function adopt(a, v=0, isDirty=true) { annotation=validateAnnotation(a,{allowIncompleteMetadata:true});version=v;dirty=isDirty;undo=[];redo=[];brushColor=0;stash();render() }
async function api(path='', body) {
  const response=await fetch('/api/annotations'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})
  let value
  try{value=await response.json()}catch{throw new Error('远端标注服务暂不可用；可先导出文件保存')}
  if(!response.ok)throw new Error(value.detail||'请求失败')
  return value
}
async function refreshRecords() {
  try {
    const {records}=await api()
    const previous=$('records').value
    $('records').replaceChildren(new Option('选择一条标注',''),...records.map(r=>new Option((r.confirmed?'已确认 · ':'草稿 · ')+r.title+' · v'+r.version,r.id)))
    if(records.some(r=>r.id===previous))$('records').value=previous
  }catch(error){message(error.message,true)}
}
function download(name,value) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}))
  const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
$('example').onclick=async()=>{
  try{
    if(!canReplace())return
    const response=await fetch('/api/ai/region/example')
    if(!response.ok)throw new Error('教学样例服务不可用；仍可导入工作台格图')
    const request=await response.json()
    adopt(createAnnotation(request,{title:'缺眼教学样例',sourceKind:'synthetic',sourceName:'原创程序样例，不是真实标注'}))
    message('教学样例已载入。填写标注者与指令，核对肤色，再确认周边。')
  }catch(error){message(error.message,true)}
}
$('import').onchange=async event=>{
  try{
    const file=event.target.files[0];if(!file||!canReplace())return
    if(file.size>3*1024*1024)throw new Error('JSON 文件超过 3 MiB')
    const value=JSON.parse(await file.text())
    if(value.schemaVersion==='region-annotation-v1')adopt(value)
    else adopt(createAnnotation(value,{title:file.name.replace(/\.json$/i,''),sourceName:file.name}))
    message('已载入；导入的标注文件保存前会检查远端版本，避免覆盖原记录。')
  }catch(error){message(error.message,true)}
  finally{event.target.value=''}
}
$('saveRemote').onclick=async()=>{
  if(!annotation)return
  try{
    const sent=validateAnnotation(annotation), sentVersion=version
    $('saveRemote').disabled=true
    const record=await api('',{annotation:sent,expectedVersion:sentVersion})
    if(annotation.id===sent.id){
      version=record.version
      if(JSON.stringify(annotation)===JSON.stringify(sent))dirty=false
      stash();update()
    }
    await refreshRecords();message('已保存到 SSH 远端 · v'+record.version)
  }catch(error){message(error.message,true)}
  finally{update()}
}
$('refresh').onclick=refreshRecords
$('loadRemote').onclick=async()=>{
  try{
    if(!$('records').value||!canReplace())return
    const record=await api('/'+$('records').value)
    adopt(record.annotation,record.version,false);message('已载入远端标注 v'+record.version)
  }catch(error){message(error.message,true)}
}
$('exportDraft').onclick=()=>{try{download('annotation-'+annotation.id+'.json',validateAnnotation(annotation));message('已导出标注文件，可在本页重新导入。')}catch(error){message(error.message,true)}}
$('exportPair').onclick=()=>{try{download('region-pair-'+annotation.id+'.json',exportPair(annotation));message('已导出配对目标；独立切分与训练资格另行审定。')}catch(error){message(error.message,true)}}
for(const id of ['title','reviewer','prompt','skin','notes','groupId','rightsDecision','rightsBasis','rightsEvidence']){
  $(id).addEventListener(id==='skin'||id.startsWith('rights')&&id!=='rightsEvidence'?'change':'input',()=>{
    if(!annotation)return
    if(['title','reviewer','prompt'].includes(id))annotation[id]=$(id).value
    if(id==='skin')annotation.skinColorId=$(id).value
    if(id==='notes')annotation.review.notes=$(id).value
    if(id==='groupId'){annotation.grouping.groupId=$(id).value;annotation.grouping.confirmed=false;$('groupConfirmed').checked=false}
    if(id.startsWith('rights'))annotation.rights[{rightsDecision:'decision',rightsBasis:'basis',rightsEvidence:'evidence'}[id]]=$(id).value
    changed(['reviewer','prompt','skin'].includes(id))
  })
}
$('groupConfirmed').onchange=()=>{if(!annotation)return;if($('groupConfirmed').checked&&(!annotation.grouping.groupId.trim()||!annotation.reviewer.trim())){$('groupConfirmed').checked=false;message('先填写组名和标注者',true);return}annotation.grouping.confirmed=$('groupConfirmed').checked;changed(false)}
$('confirmContext').onclick=()=>{try{confirmContext(annotation);dirty=true;stash();update();message('周边已确认。选择画笔颜色，在右侧目标图逐格修改。')}catch(error){message(error.message,true)}}
$('confirmTarget').onclick=()=>{try{confirmTarget(annotation);dirty=true;stash();update();message('已记录你的目标确认。请保存到远端或导出配对目标。')}catch(error){message(error.message,true)}}
$('fillSkin').onclick=()=>{try{checkpoint();const filled=modelInput(annotation),mask=effectiveMask(annotation);mask.forEach((yes,i)=>{if(yes)paintTargetCell(annotation,i,filled.cells[i])});dirty=true;stash();renderBoards();update()}catch(error){message(error.message,true)}}
$('importTarget').onchange=async event=>{
  try{
    const file=event.target.files[0];if(!file||!annotation)return
    if(file.size>1024*1024)throw new Error('目标格图文件过大')
    if(!annotation.review.contextConfirmed)throw new Error('请先确认周边再导入目标')
    const next=copy(annotation);next.targetGrid=importGrid(JSON.parse(await file.text()));invalidate(next,false)
    validateAnnotation(next);checkpoint();annotation=next;dirty=true;stash();render();message('目标已导入，请人工复核并填写修改依据。')
  }catch(error){message(error.message,true)}finally{event.target.value=''}
}
function locate(event) {
  if(!annotation)return -1
  const rect=event.currentTarget.getBoundingClientRect(),g=annotation.currentGrid,{x,y,scale}=geometry(g)
  const gx=Math.floor(((event.clientX-rect.left)*640/rect.width-x)/scale)
  const gy=Math.floor(((event.clientY-rect.top)*640/rect.height-y)/scale)
  $('cursor').textContent='格坐标 x='+gx+'，y='+gy
  return gx<0||gy<0||gx>=g.width||gy>=g.height?-1:gy*g.width+gx
}
function stroke(event) {
  const i=locate(event);if(!drawing||i<0||i===lastCell)return
  lastCell=i
  const tool=$('tool').value
  try{
    if(tool==='pick'){
      const color=(event.currentTarget.id==='before'?annotation.currentGrid:annotation.targetGrid).cells[i]
      if(color>=0){brushColor=color;renderPalette();update()}return
    }
    if(['paint','empty'].includes(tool)&&event.currentTarget.id!=='target')throw new Error('左侧输入保持原样，请在右侧目标图绘制')
    if(!strokeStarted){checkpoint();strokeStarted=true}
    if(['paint','empty'].includes(tool))paintTargetCell(annotation,i,tool==='empty'?-1:brushColor)
    else setMaskCell(annotation,i,tool)
    dirty=true;renderBoards();update()
  }catch(error){message(error.message,true)}
}
for(const id of ['before','target']){
  $(id).onpointerdown=event=>{drawing=true;strokeStarted=false;lastCell=-1;event.currentTarget.setPointerCapture(event.pointerId);stroke(event)}
  $(id).onpointermove=event=>{if(drawing)stroke(event);else locate(event)}
  $(id).onpointerup=()=>{drawing=false;stash()}
  $(id).onpointercancel=()=>{drawing=false;stash()}
}
$('addBox').onclick=()=>{
  try{
    if(!annotation)return
    const g=annotation.currentGrid,x=Number($('boxX').value),y=Number($('boxY').value),w=Number($('boxW').value),h=Number($('boxH').value)
    if(![x,y,w,h].every(Number.isInteger)||x<0||y<0||w<1||h<1||x+w>g.width||y+h>g.height)throw new Error('矩形必须在完整格图内')
    checkpoint()
    for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)setMaskCell(annotation,yy*g.width+xx,'edit')
    dirty=true;stash();renderBoards();update()
  }catch(error){message(error.message,true)}
}
$('clearMask').onclick=()=>{if(!annotation)return;checkpoint();annotation.editMask.forEach((_,i)=>setMaskCell(annotation,i,'unedit'));dirty=true;stash();renderBoards();update()}
for(const id of ['undo','redo'])$(id).onclick=()=>{
  const from=id==='undo'?undo:redo,to=id==='undo'?redo:undo
  if(!from.length)return
  to.push(copy(annotation));annotation=from.pop()
  invalidate(annotation);dirty=true;stash();render()
}
$('zoom').onchange=()=>{for(const id of ['before','target'])$(id).style.width=Number($('zoom').value)*100+'%'}
$('overlay').onchange=renderBoards
window.addEventListener('beforeunload',()=>stash())
try{
  const key=new URL(location.href).searchParams.get('input')
  if(key?.startsWith('annotation-input-')){
    const raw=localStorage.getItem(key)
    if(raw){
      // Preserve any previous unsaved workspace until the user explicitly chooses to replace it.
      const saved=JSON.parse(localStorage.getItem(KEY)||'null')
      if(saved){annotation=saved.annotation;dirty=saved.dirty;version=saved.version}
      if(canReplace()){
        const input=JSON.parse(raw)
        adopt(input.schemaVersion === 'region-annotation-v1' ? input : createAnnotation(input,{title:'工作台图纸标注',sourceKind:'workbench',sourceName:'工作台完整候选图纸'}))
        localStorage.removeItem(key)
      }else render()
    }
  }else{
    const saved=JSON.parse(localStorage.getItem(KEY)||'null')
    if(saved){adopt(saved.annotation,saved.version,saved.dirty);message('已恢复浏览器中的标注进度。')}
  }
}catch(error){message('草稿恢复失败：'+error.message+'。原始暂存保留，可导入备份。',true)}
render();await refreshRecords()
