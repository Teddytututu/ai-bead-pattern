import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEyeAnnotation, boxBetween, setEyeBoxes, sampleSkin, sealEyeAnnotation, validateEyeAnnotation } from '../../eye-annotation-state.mjs'
import { createEyeAnnotationApiHandler } from '../../server/eye-annotation-api.mjs'
const grid={width:4,height:3,paletteId:'test',paletteVersion:'1',colors:[{id:'skin',rgb:[234,191,160]},{id:'black',rgb:[30,25,20]}],cells:[0,0,0,0,0,1,1,0,-1,0,0,0]}
function ready(){
  const a=createEyeAnnotation(grid)
  setEyeBoxes(a,[{x:1,y:1,width:1,height:1},{x:2,y:1,width:1,height:1}])
  sampleSkin(a,0,0);a.prompt='Brown eyes, matching the bead face.'
  return a
}
test('eye rectangles snap in either direction, merge into a full-grid mask, and never change the source',()=>{
  const a=createEyeAnnotation(grid),source=structuredClone(a.currentGrid)
  assert.deepEqual(boxBetween({x:3,y:2},{x:1,y:1}),{x:1,y:1,width:3,height:2})
  setEyeBoxes(a,[{x:1,y:1,width:2,height:1},{x:2,y:1,width:2,height:2}])
  assert.deepEqual(a.eyeMask.map((v,i)=>v?i:-1).filter(i=>i>=0),[5,6,7,10,11])
  sampleSkin(a,0,0)
  assert.deepEqual(a.skinSample,{x:0,y:0,colorId:'skin'})
  assert.deepEqual(a.currentGrid,source)
  assert.equal('targetGrid' in a,false)
  assert.throws(()=>setEyeBoxes(a,[{x:3,y:2,width:2,height:1}]),/格图内/)
  assert.throws(()=>sampleSkin(a,0,2),/肤色格/)
  assert.throws(()=>validateEyeAnnotation({...a,skinSample:{x:0,y:2}}),/肤色/)
  assert.throws(()=>validateEyeAnnotation({...a,eyeMask:grid.cells.map(()=>true)}),/矩形框/)
})
test('one explicit seal confirms grid, masks, sampled skin and prompt together, while leaving occupancy evidence untouched',()=>{
  const a=createEyeAnnotation(grid)
  a.sourceOccupancy=a.sourceOccupancy.map(v=>v===0?0:null)
  assert.throws(()=>sealEyeAnnotation(a),/画框.*肤色.*prompt/)
  setEyeBoxes(a,[{x:1,y:1,width:1,height:1}]);sampleSkin(a,0,0);a.prompt='Small eyes.'
  const sealed=sealEyeAnnotation(a,'2026-10-01T00:00:00.000Z')
  assert.deepEqual(sealed.confirmation,{method:'explicit-seal-click',confirmedAt:'2026-10-01T00:00:00.000Z',grid:true,eyeMask:true,skin:true,prompt:true})
  assert.deepEqual(sealed.sourceOccupancy,a.sourceOccupancy)
  assert.equal(sealed.targetMode,'unchanged-source-grid')
  assert.equal(sealed.trainingEligible,false)
  assert.throws(()=>sampleSkin(sealed,1,0),/已封存/)
  assert.throws(()=>setEyeBoxes(sealed,[]),/已封存/)
  assert.throws(()=>validateEyeAnnotation({...a,targetGrid:grid}),/字段无效/)
  assert.throws(()=>createEyeAnnotation({...grid,sourceImage:{}}),/原照片/)
})
test('remote seals are atomic, immutable and retryable, with stale drafts and source changes rejected',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'eye-annotation-'))
  const handler=createEyeAnnotationApiHandler({directory,packetPath:''})
  const server=createServer((req,res)=>handler(req,res))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});await rm(directory,{recursive:true,force:true})})
  const base='http://127.0.0.1:'+server.address().port+'/api/eye-annotations'
  const post=(annotation,expectedVersion,action='save',headers={})=>fetch(base,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({annotation,expectedVersion,action})})
  const a=ready()
  assert.equal((await post(a,0,'seal',{Origin:'https://other.example'})).status,403)
  assert.equal((await post({...a,prompt:''},0,'seal')).status,422)
  assert.equal((await post(a,0)).status,200)
  assert.equal((await post(a,0)).status,409)
  const changed=structuredClone(a);changed.currentGrid.cells[0]=1;changed.skinSample={x:1,y:0,colorId:'skin'}
  assert.equal((await post(changed,1)).status,422)
  const response=await post(a,1,'seal');assert.equal(response.status,200)
  const sealed=await response.json();assert.equal(sealed.annotation.status,'sealed');assert.equal(sealed.version,2)
  const snapshot=await readFile(join(directory,'sealed',a.id+'.json'),'utf8')
  assert.equal((await readdir(join(directory,'sealed'))).length,1)
  assert.deepEqual(await(await post(a,1,'seal')).json(),sealed)
  assert.equal((await post({...a,prompt:'Changed'},2,'seal')).status,409)
  assert.equal((await post(a,2)).status,409)
  assert.equal((await post({...a,status:'sealed',confirmation:sealed.annotation.confirmation},2,'seal')).status,422)
  assert.equal(await readFile(join(directory,'sealed',a.id+'.json'),'utf8'),snapshot)
  assert.equal((await(await fetch(base+'/'+a.id)).json()).annotation.status,'sealed')
  assert.equal((await(await fetch(base)).json()).records[0].status,'sealed')
})
