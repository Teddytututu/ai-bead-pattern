import { EYE_SCHEMA, createEyeAnnotation, validateEyeAnnotation, boxBetween, setEyeBoxes, sampleSkin, sealIssues } from './state.mjs'
const $=id=>document.getElementById(id), KEY='eye-annotation-workspace-v1', CURSOR='eye-annotation-cursor-v1', DRAFT='eye-annotation-draft-v1:'
let a=null,version=0,dirty=false,batch=null,busy=false,mode='box',drag=null
const clone=value=>structuredClone(value)
function message(value,error=false){$('message').textContent=value;$('message').dataset.error=String(error)}
function stored(key){try{return JSON.parse(localStorage.getItem(key)||'null')}catch{return null}}
function stash(){
  if(!a)return
  try{const value=JSON.stringify({annotation:a,version,dirty});localStorage.setItem(KEY,value);localStorage.setItem(DRAFT+a.id,value)}
  catch{message('浏览器暂存空间不足，请保存草稿或导出本张。',true)}
}
function index(){return batch?.items.findIndex(i=>i.id===a?.id)??-1}
function editable(){return a&&a.status==='draft'&&!busy}
function update(){
  const locked=!editable(),i=index(),sealed=a?.status==='sealed'
  $('title').textContent=a?.title??'完整拼豆图'
  $('gridInfo').textContent=a?a.currentGrid.width+' × '+a.currentGrid.height+' 格 · 原图不修改':'未载入'
  $('saveState').textContent=!a?'尚未载入':sealed?'已封存 · 全部内容已固定':dirty?'草稿已暂存 · 待封存':version?'草稿已保存 · v'+version:'尚未封存'
  $('saveState').dataset.sealed=String(Boolean(sealed))
  $('recordStatus').textContent=sealed?'已封存':'草稿'
  $('prompt').disabled=locked
  for(const id of ['boxMode','skinMode','pickSkin'])$(id).disabled=locked
  $('undo').disabled=locked||!a?.eyeBoxes.length
  $('saveDraft').disabled=locked
  $('export').disabled=!a||busy
  $('import').disabled=busy
  $('loadRecord').disabled=busy
  $('reloadRemote').disabled=!a||busy
  $('gridCanvas').dataset.locked=String(locked)
  $('gridCanvas').dataset.mode=mode
  $('boxMode').setAttribute('aria-pressed',String(mode==='box'))
  $('skinMode').setAttribute('aria-pressed',String(mode==='skin'))
  $('modeHint').textContent=sealed?'本张已封存，只读查看。':mode==='skin'?'在原拼豆图上点击一个肤色格，取色后继续框选。':'拖动鼠标框住一只眼睛，可继续画多个框。'
  $('boxCount').textContent=(a?.eyeBoxes.length??0)+' 个框'
  $('boxes').replaceChildren()
  for(const [j,b] of (a?.eyeBoxes??[]).entries()){
    const row=document.createElement('div');row.className='eye-box'
    const name=document.createElement('strong');name.textContent='眼睛 '+(j+1)
    const size=document.createElement('span');size.textContent=b.width+' × '+b.height+' 格'
    const remove=document.createElement('button');remove.textContent='×';remove.setAttribute('aria-label','删除眼睛 '+(j+1));remove.disabled=locked
    remove.onclick=()=>{if(!editable())return;setEyeBoxes(a,a.eyeBoxes.filter((_,k)=>k!==j));changed()}
    row.append(name,size,remove);$('boxes').append(row)
  }
  if(!a?.eyeBoxes.length){const p=document.createElement('p');p.className='muted';p.textContent='在图中拖动框选，每只眼一个框。';$('boxes').append(p)}
  const sample=a?.skinSample,color=sample?a.currentGrid.colors.find(c=>c.id===sample.colorId):null
  $('skinValue').textContent=color?'#'+color.rgb.map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase():'尚未选取'
  $('skinSwatch').style.background=color?'rgb('+color.rgb.join(',')+')':''
  $('skinLocation').textContent=sample?'取自格坐标 ('+sample.x+', '+sample.y+')':'点击“点选肤色”，再点图中肤色格。'
  const issues=a?sealIssues(a):['请先载入格图']
  $('readiness').textContent=sealed?'原图、眼睛蒙版、肤色与 prompt 已统一确认。':issues.length?issues.join(' · '):a.eyeBoxes.length+' 个眼睛框 · 肤色已选 · prompt 已填'
  $('seal').disabled=busy||!a||sealed||issues.length>0||Boolean(drag)
  $('seal').textContent=busy?'正在保存…':sealed?'已封存 ✓':'确认全部并封存 →'
  $('sealTime').hidden=!sealed;$('sealTime').textContent=sealed?'封存时间：'+new Date(a.confirmation.confirmedAt).toLocaleString():''
  $('previous').disabled=busy||i<0||batch.offset+i===0
  $('next').disabled=busy||i<0||batch.offset+i+1>=batch.total
  $('next').textContent=sealed?'下一张 →':'暂存并跳过 →'
  $('batchPrevious').disabled=busy||!batch||batch.offset===0
  $('batchNext').disabled=busy||!batch?.hasNext
  $('batchItems').disabled=busy||!batch?.items.length
  $('openBatch').disabled=busy||!batch?.items.some(item=>!item.error)
  $('batchInfo').textContent=batch?.total?'服务器图库 · 第 '+(batch.offset/20+1)+' / '+Math.ceil(batch.total/20)+' 批':'暂无格图队列，可导入 JSON'
  $('progress').textContent=batch?.total?'本批 '+batch.items.length+' 张 · 共 '+batch.total+' 张'+(i>=0?' · 当前 '+(batch.offset+i+1)+' / '+batch.total:' · 当前为独立图纸'):'每批自动读取 20 张'
  $('batchItems').value=i<0?'':String(i)
  for(const option of $('batchItems').options){
    if(!option.value)continue
    const item=batch.items[Number(option.value)]
    const state=item.id===a?.id?a:item.record?.annotation
    option.textContent=(batch.offset+Number(option.value)+1)+'. '+item.title+(item.error?' · 无法读取':state?.status==='sealed'?' · 已封存':'')
  }
}
function draw(){
  const canvas=$('gridCanvas'),ctx=canvas.getContext('2d')
  if(!a){ctx.clearRect(0,0,canvas.width,canvas.height);$('emptyState').hidden=false;return}
  $('emptyState').hidden=true
  const g=a.currentGrid,s=24
  canvas.width=g.width*s;canvas.height=g.height*s
  const frame=$('canvasFrame'),style=getComputedStyle(frame)
  const horizontal=parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)
  const vertical=parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)
  const availableWidth=frame.clientWidth-horizontal
  const availableHeight=parseFloat(style.maxHeight)-vertical-2
  const fit=Math.min(availableWidth,availableHeight*g.width/g.height)
  canvas.style.width=Math.max(1,fit*Number($('zoom').value))+'px'
  g.cells.forEach((c,i)=>{
    const x=i%g.width*s,y=Math.floor(i/g.width)*s
    ctx.fillStyle=c<0?'#eef1eb':'rgb('+g.colors[c].rgb.join(',')+')';ctx.fillRect(x,y,s,s)
    if(c<0){ctx.strokeStyle='#d6ddd3';ctx.beginPath();ctx.moveTo(x,y+s);ctx.lineTo(x+s,y);ctx.stroke()}
    ctx.strokeStyle='#425c3924';ctx.lineWidth=.6;ctx.strokeRect(x,y,s,s)
  })
  const boxes=[...a.eyeBoxes,...(drag?[boxBetween(drag.start,drag.end)]:[])]
  boxes.forEach((b,j)=>{
    const x=b.x*s,y=b.y*s,w=b.width*s,h=b.height*s
    ctx.fillStyle='#4da47b39';ctx.fillRect(x,y,w,h);ctx.strokeStyle='#277451';ctx.lineWidth=2;ctx.setLineDash(j===a.eyeBoxes.length?[5,3]:[]);ctx.strokeRect(x+1,y+1,w-2,h-2);ctx.setLineDash([])
    ctx.fillStyle='#286f4f';ctx.fillRect(x,y,18,17);ctx.fillStyle='#fff';ctx.font='11px sans-serif';ctx.fillText(String(j+1),x+5,y+12)
  })
  if(a.skinSample){
    const {x,y}=a.skinSample,cx=(x+.5)*s,cy=(y+.5)*s
    ctx.beginPath();ctx.arc(cx,cy,7,0,Math.PI*2);ctx.strokeStyle='#fff';ctx.lineWidth=4;ctx.stroke();ctx.strokeStyle='#705328';ctx.lineWidth=2;ctx.stroke()
  }
}
function render(){if(a)$('prompt').value=a.prompt;draw();update()}
function changed(){dirty=true;stash();draw();update()}
function adopt(record){
  a=validateEyeAnnotation(record.annotation);version=record.version??0;dirty=Boolean(record.dirty);drag=null;mode='box';stash();render()
}
async function request(path,body){
  const response=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})
  let value;try{value=await response.json()}catch{throw new Error('远端暂时不可用，当前草稿已保留')}
  if(!response.ok){const error=new Error(value.detail||'请求失败');error.status=response.status;throw error}
  return value
}
async function record(id){try{return await request('/api/eye-annotations/'+id)}catch(error){if(error.status===404)return null;throw error}}
async function refreshRecords(){
  const value=await request('/api/eye-annotations')
  $('records').replaceChildren(new Option('选择记录',''),...value.records.map(r=>new Option((r.status==='sealed'?'已封存 · ':'草稿 · ')+r.title,r.id)))
}
async function save(action='save'){
  if(!a||a.status==='sealed')return
  const sent=validateEyeAnnotation(a)
  const result=await request('/api/eye-annotations',{action,annotation:sent,expectedVersion:version})
  adopt({...result,dirty:false})
  if(batch){const item=batch.items.find(i=>i.id===a.id);if(item)item.record=result}
  // A saved record remains successful even if refreshing the optional history list fails.
  await refreshRecords().catch(()=>{})
  return result
}
async function pending(){if(dirty)await save()}
async function run(operation){
  if(busy)return
  busy=true;update()
  try{await operation()}catch(error){message(error.message,true)}
  finally{busy=false;update()}
}
async function loadBatch(offset,snapshot=''){
  batch=await request('/api/eye-annotation-dataset?offset='+offset+(snapshot?'&snapshot='+encodeURIComponent(snapshot):''))
  $('batchItems').replaceChildren(new Option('选择本批图纸',''),...batch.items.map((item,j)=>{
    const option=new Option(item.title,String(j));option.disabled=Boolean(item.error);return option
  }))
  update()
}
async function choose(position){
  const item=batch.items[position]
  if(!item||item.error)throw new Error(item?.error??'没有可读取的图纸')
  const remote=await record(item.id)??{annotation:item.annotation,version:0}
  item.record=remote.version?remote:undefined
  let local=stored(DRAFT+item.id)
  try{if(local)local.annotation=validateEyeAnnotation(local.annotation)}catch{local=null}
  const selected=remote.annotation.status==='sealed'?remote:local&&(local.dirty||local.version>=remote.version)?local:remote
  if(remote.annotation.status==='sealed'&&local?.dirty){
    localStorage.setItem(DRAFT+item.id+':before-seal',JSON.stringify(local))
  }
  adopt(selected)
  localStorage.setItem(CURSOR,JSON.stringify({datasetId:batch.datasetId,offset:batch.offset,sampleId:item.sampleId}))
  message(local?.dirty&&remote.annotation.status!=='sealed'&&local.version<remote.version?'本地草稿保留，但远端已有新版本。请导出草稿后重新载入远端版本。':'已载入 '+item.title)
}
async function move(delta){
  const current=index();if(current<0)return false
  let next=current+delta
  if(next>=batch.items.length&&batch.hasNext){await loadBatch(batch.offset+20,batch.datasetId);next=0}
  else if(next<0&&batch.offset>0){await loadBatch(batch.offset-20,batch.datasetId);next=batch.items.length-1}
  else if(next<0||next>=batch.items.length)return false
  await choose(next);return true
}
function locationAt(event,clamp=false){
  if(!a)return null
  const rect=$('gridCanvas').getBoundingClientRect(),g=a.currentGrid
  let x=Math.floor((event.clientX-rect.left)/rect.width*g.width),y=Math.floor((event.clientY-rect.top)/rect.height*g.height)
  if(clamp){x=Math.max(0,Math.min(g.width-1,x));y=Math.max(0,Math.min(g.height-1,y))}
  if(x<0||y<0||x>=g.width||y>=g.height)return null
  return{x,y}
}
$('gridCanvas').onpointerdown=event=>{
  if(!editable()||event.button!==0)return
  const p=locationAt(event);if(!p)return
  if(mode==='skin'){
    try{sampleSkin(a,p.x,p.y);mode='box';changed();message('已取肤色；框选完成后统一封存。')}catch(error){message(error.message,true)}
    return
  }
  drag={start:p,end:p,clientX:event.clientX,clientY:event.clientY}
  event.currentTarget.setPointerCapture(event.pointerId);draw();update()
}
$('gridCanvas').onpointermove=event=>{
  const p=locationAt(event,Boolean(drag));if(!p)return
  $('cursor').textContent='x '+p.x+' · y '+p.y
  if(drag){drag.end=p;draw()}
}
$('gridCanvas').onpointerup=event=>{
  if(!drag)return
  const active=drag;drag=null
  if(editable()&&Math.hypot(event.clientX-active.clientX,event.clientY-active.clientY)>3){
    try{
      const b=boxBetween(active.start,locationAt(event,true))
      if(!a.eyeBoxes.some(old=>JSON.stringify(old)===JSON.stringify(b)))setEyeBoxes(a,[...a.eyeBoxes,b])
      changed();message('已框选 '+a.eyeBoxes.length+' 只眼睛，可继续添加或删除框。')
    }catch(error){message(error.message,true);draw();update()}
  }else{draw();update()}
}
$('gridCanvas').onpointercancel=()=>{drag=null;draw();update()}
window.addEventListener('keydown',event=>{if(event.key==='Escape'){drag=null;mode='box';draw();update()}})
$('boxMode').onclick=()=>{mode='box';update()}
for(const id of ['skinMode','pickSkin'])$(id).onclick=()=>{mode='skin';update();message('在原拼豆图上点击脸部肤色格。')}
$('undo').onclick=()=>{if(editable()){setEyeBoxes(a,a.eyeBoxes.slice(0,-1));changed()}}
$('prompt').oninput=()=>{if(editable()){a.prompt=$('prompt').value;dirty=true;stash();update()}}
$('zoom').onchange=draw
window.addEventListener('resize',()=>requestAnimationFrame(draw))
$('seal').onclick=()=>run(async()=>{
  if(!a||a.status==='sealed')return
  const issues=sealIssues(a);if(issues.length)throw new Error(issues.join('；'))
  await save('seal')
  if(!await move(1))message('本张已封存，全部内容固定。'+(index()>=0?'已到图库末尾。':''))
  else message('上一张已封存，当前为下一张。')
})
$('next').onclick=()=>run(async()=>{await pending();await move(1)})
$('previous').onclick=()=>run(async()=>{await pending();await move(-1)})
$('batchItems').onchange=()=>{if($('batchItems').value==='')return;const i=Number($('batchItems').value);run(async()=>{await pending();await choose(i)})}
for(const [id,delta] of [['batchPrevious',-20],['batchNext',20]])$(id).onclick=()=>run(async()=>{await pending();await loadBatch(batch.offset+delta,batch.datasetId);await choose(batch.items.findIndex(i=>!i.error))})
$('openBatch').onclick=()=>run(async()=>{await pending();await choose(batch.items.findIndex(i=>!i.error))})
$('saveDraft').onclick=()=>run(async()=>{await save();message('草稿已保存到远端，尚未封存。')})
$('reloadRemote').onclick=()=>run(async()=>{
  const remote=await record(a.id);if(!remote)throw new Error('远端还没有这张记录')
  if(dirty&&!window.confirm('当前有未保存修改。请先导出备份；确定载入远端版本吗？'))return
  adopt(remote);message('已载入远端版本。')
})
$('loadRecord').onclick=()=>run(async()=>{const id=$('records').value;if(!id)return;await pending();adopt(await record(id));message('已载入远端记录。')})
$('import').onchange=event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return
  run(async()=>{
    if(file.size>3*1024*1024)throw new Error('JSON 超过 3 MiB')
    const input=JSON.parse(await file.text())
    const value=input.schemaVersion===EYE_SCHEMA?validateEyeAnnotation(input):createEyeAnnotation(input,{title:file.name.replace(/\.json$/i,''),sourceName:file.name})
    await pending();adopt({annotation:value,version:0,dirty:value.status!=='sealed'});message('已导入完整格图。请填写 prompt、点选肤色并框眼睛。')
  })
}
$('export').onclick=()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify(validateEyeAnnotation(a),null,2)],{type:'application/json'}))
  const link=document.createElement('a');link.href=url;link.download='eyes-'+a.id+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
window.addEventListener('beforeunload',stash)
render()
await run(async()=>{
  const saved=stored(KEY)
  if(saved){try{adopt(saved)}catch{message('旧草稿无法恢复，原始暂存保留。',true)}}
  const inputKey=new URL(location.href).searchParams.get('input')
  if(inputKey?.startsWith('annotation-input-')){
    const input=stored(inputKey)
    if(input){
      await pending()
      adopt({annotation:createEyeAnnotation(input,{title:'工作台眼睛标注',sourceKind:input.source?.kind==='region'?'region':'workbench',sourceName:'完整拼豆格图'}),version:0,dirty:true})
      localStorage.removeItem(inputKey)
      history.replaceState(null,'',location.pathname)
    }
  }
  const cursor=stored(CURSOR)
  try{await loadBatch(cursor?.offset??0,cursor?.datasetId??'')}
  catch(error){await loadBatch(0);message(error.message,true)}
  if(!a&&batch.items.length){
    const i=batch.items.findIndex(item=>item.sampleId===cursor?.sampleId)
    await choose(i>=0?i:batch.items.findIndex(item=>!item.error))
  }else if(a){
    const latest=await record(a.id)
    if(latest?.annotation.status==='sealed'||latest&&!dirty&&latest.version>version){
      if(dirty)localStorage.setItem(DRAFT+a.id+':before-seal',JSON.stringify({annotation:a,version,dirty}))
      adopt(latest)
    }
  }
  await refreshRecords()
})
