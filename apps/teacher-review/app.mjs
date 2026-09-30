import {parseRange,shiftRange} from './ranges.mjs';
const $=id=>document.getElementById(id);
let state={round:null,items:[],visible:[],index:0,current:null,choice:null,dirty:false,busy:false,status:null,version:0,sequence:0,readyCount:0,filters:{category:'',split:'',filter:'pending'},range:{start:0,end:24}};
try{const raw=new URLSearchParams(location.search).get('range')||localStorage.getItem('teacher-range')||'0-24';state.range=parseRange(raw);$('range').value=state.range.start+'-'+state.range.end;}catch{}
async function api(path,body){const r=await fetch('/api'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.detail||'请求失败');return data;}
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
function options(id,rows,label){const el=$(id),old=el.value;el.replaceChildren(...rows.map(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=label(r);return o;}));if(rows.some(r=>r.id===old))el.value=old;}
function changed(){state.dirty=true;}
function canNavigate(){if(state.dirty){message('当前标注尚未保存，请先保存。',true);return false;}return true;}
function rejectedReasons(){return [...document.querySelectorAll('[name="rejection-reason"]:checked')].map(x=>x.value);}
function updateButtons(){const active=state.status?.jobs.some(j=>['starting','running'].includes(j.status));$('generate').disabled=!!active||!state.round;$('train').disabled=!!active||!$('snapshot').value;$('new-round').disabled=!state.status?.dataset_count;$('save').disabled=state.busy||!state.current?.result||!state.choice||(state.choice==='neither'&&!rejectedReasons().length);}
async function refresh(){
 const data=await api('/status');state.status=data;
 options('round',data.rounds,r=>r.id.replace('round-',''));if(state.round)$('round').value=state.round;
 options('snapshot',data.snapshots,r=>r.id.replace('snapshot-','')+' · '+r.count+' 张');
 options('adapter',[{id:'',count:0},...data.adapters],r=>r.id?r.id+' · '+r.count+' 张 · 未评测':'原始 SDXL 基座');
 const round=data.rounds.find(r=>r.id===state.round),reviews=data.reviews.find(r=>r.round_id===state.round);
 $('dataset').textContent=data.dataset_count+' 张输入 · 动物 / 动漫';
 $('progress').textContent=round?(reviews?.count||0)+' 已标注 / '+round.ready+' 已生成':'等待生成轮次';
 $('exports').replaceChildren(...(data.exports||[]).slice(0,5).map(x=>{const a=document.createElement('a');a.href=x.url;a.download=x.name;a.textContent=x.count+' 张 · '+x.name.split('-').slice(-3).join('-');return a;}));
 $('jobs').replaceChildren(...data.jobs.slice(0,5).map(j=>{const d=document.createElement('div');d.className='job';
 const t=document.createElement('span');t.textContent=(j.kind==='generate'?'生成':'训练')+' · '+({starting:'启动中',running:'运行中',completed:'完成',failed:'失败'}[j.status]||j.status)+' · '+j.progress+'/'+j.total+' · '+j.message;
 const p=document.createElement('progress');p.max=j.total||1;p.value=j.progress;
 const b=document.createElement('button');b.textContent='日志';b.onclick=()=>run(async()=>{$('log').hidden=false;$('log').textContent=(await api('/jobs/'+j.id+'/log')).text;});
 d.append(t,p,b);return d;}));
 updateButtons();
 if(state.round&&round&&round.ready!==state.readyCount&&!state.dirty){
  const currentId=state.current?.item.id;const fresh=await api('/rounds/'+state.round);
  state.items=fresh.items;state.readyCount=round.ready;filter();
  const kept=state.visible.findIndex(x=>x.id===currentId);if(kept>=0)state.index=kept;
  if(!state.current||!state.current.result)await show();
 }
 if(!state.round&&data.rounds.length){const requested=new URLSearchParams(location.search).get('round');await loadRound(data.rounds.some(r=>r.id===requested)?requested:data.rounds[0].id);await refresh();}
}
async function loadRound(rid){state.round=rid;const r=await api('/rounds/'+rid);state.items=r.items;state.readyCount=r.items.filter(x=>x.ready).length;state.style=r.config.style;$('strength-a').textContent='较多保留原图 · '+r.config.variants.a.strength;$('strength-b').textContent='较强风格变化 · '+r.config.variants.b.strength;state.index=0;filter();await show();$('round').value=rid;}
function filter(){const group=state.items.filter(x=>x.image_number>=state.range.start&&x.image_number<=state.range.end);$('batch-progress').textContent=state.range.start+'–'+state.range.end+' · 已标注 '+group.filter(x=>x.review).length+'/'+group.length+' · 已生成 '+group.filter(x=>x.ready).length+'/'+group.length;
 state.visible=group.filter(x=>(!$('category').value||x.category===$('category').value)&&(!$('split').value||x.split===$('split').value)&&($('filter').value==='all'||($('filter').value==='pending'?(!x.review&&x.ready):!!x.review)));state.index=Math.min(state.index,Math.max(0,state.visible.length-1));}
function image(id,url){if(url)$(id).src=url;else $(id).removeAttribute('src');}
async function show(){
 const sequence=++state.sequence;
 state.choice=null;state.dirty=false;state.current=null;state.version=0;
 document.querySelectorAll('[name="rejection-reason"]').forEach(x=>x.checked=false);
 const item=state.visible[state.index];
 selectChoice(null,false);
 for(const id of ['source','a','b'])image(id,null);
 if(!item){$('item-title').textContent='当前暂无已生成的待标注图像；生成完成后自动更新';$('position').textContent='';$('caption').value='';$('notes').value='';selectChoice(null,false);return;}
 const result=await api('/rounds/'+state.round+'/items/'+item.id);if(sequence!==state.sequence)return;state.current=result;state.version=result.review?.version||0;
 $('item-title').textContent='图片 '+item.photo_id;$('position').textContent='本组 '+(state.index+1)+' / '+state.visible.length;
 $('badge').textContent=({animal:'动物',anime:'动漫'}[item.category])+' · '+({train:'训练',validation:'验证',test:'最终测试'}[item.split]);
 $('dimensions').textContent=item.width+' × '+item.height;
 image('source','/images/'+state.round+'/'+item.id+'/source');
 if(result.result)for(const v of ['a','b'])image(v,'/images/'+state.round+'/'+item.id+'/'+v);
 $('caption').value=result.review?.caption||(result.result?.prompt||(state.style+', '+item.caption.split('. ')[0]));$('notes').value=result.review?.notes||'';
 $('preferred').value=result.review?.preferred==='b'?'b':result.review?.preferred==='tie'?'tie':'a';
 $('provenance').textContent=item.license+' · '+item.attribution+(item.synthetic?' · AI 合成肖像':' · 真实照片')+(item.crop_box?' · 原图 '+item.original_size.join('×')+'，脸部裁切':'');
 $('source-link').href=item.source_page;
 for(const v of ['a','b']){const link=$('master-'+v);if(result.result?.[v]?.master_path){link.href='/images/'+state.round+'/'+item.id+'/'+v+'-master';link.hidden=false;}else{link.removeAttribute('href');link.hidden=true;}}
 $('save-state').textContent=result.review?'已保存标注，版本 '+state.version:result.result?'尚未标注':'候选尚在生成，可稍后回来';
 document.querySelectorAll('[name="rejection-reason"]').forEach(x=>x.checked=(result.review?.rejection_reasons||[]).includes(x.value));
 selectChoice(result.review?.accepted||null,false);
}
function selectChoice(choice,dirty=true){state.choice=choice;if(dirty)changed();document.querySelectorAll('[data-choice]').forEach(b=>{b.classList.toggle('active',b.dataset.choice===choice);b.disabled=!state.current?.result;});for(const v of ['a','b'])$('card-'+v).classList.toggle('selected',choice===v||choice==='both');$('prefer-label').hidden=choice!=='both';$('rejection-reasons').hidden=choice!=='neither';updateButtons();}
async function save(){if(!state.choice||!state.current?.result||state.busy)return;if(state.choice==='neither'&&!rejectedReasons().length){message('请选择不合格原因：颜色或姿态。',true);return;}state.busy=true;updateButtons();try{
 const item=state.current.item;const preferred=state.choice==='both'?$('preferred').value:state.choice;
 const review=await api('/rounds/'+state.round+'/items/'+item.id+'/review?start='+state.range.start+'&end='+state.range.end,{version:state.version,accepted:state.choice,preferred,caption:$('caption').value,notes:$('notes').value,rejection_reasons:state.choice==='neither'?rejectedReasons():[]});
 state.items.find(x=>x.id===item.id).review=review;state.dirty=false;
 if($('filter').value==='pending')filter();else state.index=Math.min(state.index+1,state.visible.length-1);
 await show();await refresh();for(const x of review.exports||[])download(x);message(review.export_warning||(review.exports?.length?'标注已保存，已自动导出 '+review.exports.map(x=>x.count).join('、')+' 张 JSONL。':'标注已保存。'));
 }finally{state.busy=false;updateButtons();}}
function download(x){const a=document.createElement('a');a.href=x.url;a.download=x.name;document.body.append(a);a.click();a.remove();}
$('export-now').onclick=()=>run(async()=>{if(!canNavigate())return;const x=await api('/rounds/'+state.round+'/export?start='+state.range.start+'&end='+state.range.end,{});download(x);await refresh();message('已导出本组 '+x.count+' 张标注。');});
async function applyRange(range){if(!canNavigate()){$('range').value=state.range.start+'-'+state.range.end;return;}state.range=range;state.index=0;$('range').value=range.start+'-'+range.end;try{localStorage.setItem('teacher-range',$('range').value);}catch{}const url=new URL(location.href);url.searchParams.set('range',$('range').value);history.replaceState(null,'',url);filter();await show();}
$('apply-range').onclick=()=>run(()=>applyRange(parseRange($('range').value)));
$('range').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();$('apply-range').click();}};
$('prev-group').onclick=()=>run(()=>applyRange(shiftRange(state.range,-1)));
$('next-group').onclick=()=>run(()=>applyRange(shiftRange(state.range,1)));
async function run(fn){try{await fn();}catch(e){message(e.message,true);}}
document.querySelectorAll('[data-choice]').forEach(b=>b.onclick=()=>selectChoice(b.dataset.choice));
$('save').onclick=()=>run(save);
document.querySelectorAll('[name="rejection-reason"]').forEach(x=>x.onchange=()=>{changed();updateButtons();});
$('prev').onclick=()=>run(async()=>{if(canNavigate()){state.index=Math.max(0,state.index-1);await show();}});
$('next').onclick=()=>run(async()=>{if(canNavigate()){state.index=Math.min(state.visible.length-1,state.index+1);await show();}});
$('round').onchange=()=>run(async()=>{if(canNavigate())await loadRound($('round').value);else $('round').value=state.round;});
for(const id of ['category','split','filter'])$(id).onchange=()=>run(async()=>{if(canNavigate()){state.filters[id]=$(id).value;state.index=0;filter();await show();}else $(id).value=state.filters[id];});
for(const id of ['caption','notes','preferred'])$(id).oninput=changed;
$('snapshot').onchange=updateButtons;
$('generate').onclick=()=>run(async()=>{await api('/jobs',{kind:'generate',reference:state.round});message('批量生成已启动，已完成的图像会自动跳过。');await refresh();});
$('freeze').onclick=()=>run(async()=>{if(!canNavigate())return;const s=await api('/freeze',{});await refresh();$('snapshot').value=s.id;message('已冻结 '+s.count+' 张合格训练目标，并备份标注。');updateButtons();});
$('train').onclick=()=>run(async()=>{if(!canNavigate())return;await api('/jobs',{kind:'train',reference:$('snapshot').value});message('已启动 LoRA 训练。完成后请创建下一轮，并比较固定验证集。');await refresh();});
$('new-round').onclick=()=>run(async()=>{if(!canNavigate())return;const r=await api('/rounds',{parent:$('adapter').value||null});await loadRound(r.id);await refresh();message('新轮次已创建，点击“继续本轮批量生成”开始。');});
document.addEventListener('keydown',e=>{if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;const choice={'1':'a','2':'b','3':'both','4':'neither'}[e.key];if(choice&&state.current?.result)selectChoice(choice);if(e.key==='Enter'){e.preventDefault();run(save);}if(e.key==='ArrowRight')$('next').click();if(e.key==='ArrowLeft')$('prev').click();});
window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue='';}});
await run(refresh);
setInterval(()=>run(async()=>{await refresh();if(state.current&&!state.current.result&&!state.dirty)await show();}),6000);
