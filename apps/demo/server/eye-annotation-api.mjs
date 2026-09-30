import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile, rename, unlink, link } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createAnnotationDataset } from './annotation-dataset.mjs'
import { UUID, eyeAnnotationFromDataset, validateEyeAnnotation, sealEyeAnnotation } from '../eye-annotation-state.mjs'

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const contentHash = a => sha({ ...a, status:'draft', confirmation:null })
const sourceHash = a => sha({ currentGrid:a.currentGrid, source:a.source, sourceOccupancy:a.sourceOccupancy })
const LIMIT=3*1024*1024
export function createEyeAnnotationApiHandler({
  directory=resolve(process.env.EYE_ANNOTATION_DIR ?? join(process.env.REGION_ANNOTATION_DIR ?? 'output/region-annotations','eyes')),
  packetPath,
}={}) {
  const dataset=createAnnotationDataset({packetPath}), locks=new Set()
  async function readFileOrNull(path) {
    try { return JSON.parse(await readFile(path,'utf8')) } catch(error) { if(error.code==='ENOENT')return null;throw error }
  }
  // The atomic sealed snapshot is authoritative, including after a lost HTTP acknowledgement.
  const read = async id => await readFileOrNull(join(directory,'sealed',id+'.json')) ?? await readFileOrNull(join(directory,id+'.json'))
  async function names(path) {
    try{return (await readdir(path)).filter(n=>n.endsWith('.json')&&UUID.test(n.slice(0,-5))).map(n=>n.slice(0,-5))}
    catch(error){if(error.code==='ENOENT')return [];throw error}
  }
  return async (request,response) => {
    const url=new URL(request.url,'http://localhost'),path=url.pathname
    if(path!=='/api/eye-annotation-dataset'&&path!=='/api/eye-annotations'&&!path.startsWith('/api/eye-annotations/'))return false
    const send=(code,value)=>{response.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});response.end(JSON.stringify(value))}
    if(request.headers.origin&&request.headers.origin!=='http://'+request.headers.host){send(403,{detail:'禁止跨站访问标注记录'});return true}
    try {
      if(path==='/api/eye-annotation-dataset') {
        if(request.method!=='GET'){send(405,{detail:'图库仅支持读取'});return true}
        const offset=url.searchParams.get('offset')??'0'
        if(!/^(0|[1-9][0-9]{0,8})$/.test(offset)){send(400,{detail:'批次偏移无效'});return true}
        let batch
        try{batch=await dataset(Number(offset),url.searchParams.get('snapshot')??'')}
        catch(error){send(error.status??400,{detail:error.message});return true}
        for(const item of batch.items)if(item.annotation){
          item.annotation=eyeAnnotationFromDataset(item.annotation)
          const record=await read(item.id);if(record)item.record=record
        }
        send(200,batch);return true
      }
      const id=path==='/api/eye-annotations'?null:path.slice('/api/eye-annotations/'.length)
      if(id!==null&&!UUID.test(id)){send(400,{detail:'标注 ID 无效'});return true}
      if(request.method==='GET'){
        if(id){const record=await read(id);send(record?200:404,record??{detail:'没有这条标注'})}
        else{
          const ids=new Set([...await names(directory),...await names(join(directory,'sealed'))]),records=[]
          for(const key of ids){const r=await read(key);records.push({id:key,title:r.annotation.title,status:r.annotation.status,version:r.version,updatedAt:r.updatedAt})}
          send(200,{records:records.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))})
        }
        return true
      }
      if(request.method!=='POST'||id!==null){send(405,{detail:'不支持该操作'});return true}
      if(!request.headers['content-type']?.startsWith('application/json')){send(415,{detail:'需要 JSON'});return true}
      if(Number(request.headers['content-length'])>LIMIT){send(413,{detail:'标注超过 3 MiB'});return true}
      let bytes=0;const parts=[]
      for await(const part of request){bytes+=part.length;if(bytes>LIMIT){send(413,{detail:'标注超过 3 MiB'});return true}parts.push(part)}
      let body,a
      try{
        body=JSON.parse(Buffer.concat(parts).toString('utf8'));a=validateEyeAnnotation(body.annotation)
        if(!['save','seal'].includes(body.action)||!Number.isInteger(body.expectedVersion)||body.expectedVersion<0)throw new Error('保存动作或版本无效')
        if(a.status!=='draft')throw new Error('封存状态由服务端生成，不能自行声明')
      }catch(error){send(422,{detail:error.message});return true}
      if(locks.has(a.id)){send(409,{detail:'正在保存，请稍后重试'});return true}
      locks.add(a.id)
      try {
        const prior=await read(a.id)
        if(prior?.annotation.status==='sealed'){
          if(body.action==='seal'&&contentHash(prior.annotation)===contentHash(a)&&[prior.version,prior.version-1].includes(body.expectedVersion)){send(200,prior);return true}
          send(409,{detail:'这张图已封存，原图、蒙版、肤色和 prompt 均已固定'});return true
        }
        if((prior?.version??0)!==body.expectedVersion){send(409,{detail:'远端已有更新；请导出草稿后重新载入远端版本'});return true}
        if(prior&&prior.sourceSha256!==sourceHash(a)){send(422,{detail:'不能替换原始格图或来源'});return true}
        if(body.action==='seal'){
          try{a=sealEyeAnnotation(a)}catch(error){send(422,{detail:error.message});return true}
        }
        const record={version:body.expectedVersion+1,updatedAt:new Date().toISOString(),sourceSha256:sourceHash(a),annotationSha256:sha(a),annotation:a}
        await mkdir(directory,{recursive:true,mode:0o700})
        const temporary=join(directory,'.'+a.id+'-'+randomUUID()+'.tmp')
        try {
          await writeFile(temporary,JSON.stringify(record,null,2),{flag:'wx',mode:0o600})
          if(a.status==='sealed'){
            await mkdir(join(directory,'sealed'),{recursive:true,mode:0o700})
            await link(temporary,join(directory,'sealed',a.id+'.json'))
          }else await rename(temporary,join(directory,a.id+'.json'))
        }finally{await unlink(temporary).catch(()=>{})}
        send(200,record)
      }finally{locks.delete(a.id)}
    }catch(error){send(500,{detail:['EDQUOT','ENOSPC'].includes(error.code)?'存储空间不足，请导出草稿备份':'远端保存失败，草稿仍保留；请重试或导出备份'})}
    return true
  }
}
