"""Localhost review API; run behind SSH forwarding, never on a public interface."""
import argparse,json,os,pathlib,sqlite3,subprocess,sys,threading
from typing import Literal
from fastapi import FastAPI,HTTPException,Request,Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel,Field
import store
import exports
from store import DATA,ROOT,db,now,uid
app=FastAPI(title='SDXL teacher review',docs_url=None,redoc_url=None)
lock=threading.Lock()
@app.middleware('http')
async def origin_guard(request,call_next):
    host=request.headers.get('host','').split(':')[0]
    if host not in ('localhost','127.0.0.1','testserver'): return __import__('fastapi').responses.JSONResponse({'detail':'Localhost only'},403)
    if request.method not in ('GET','HEAD'):
        origin=request.headers.get('origin')
        if origin and origin!=str(request.base_url).rstrip('/'):
            return __import__('fastapi').responses.JSONResponse({'detail':'Cross-origin writes denied'},403)
    response=await call_next(request)
    response.headers['X-Content-Type-Options']='nosniff'
    return response
@app.exception_handler(ValueError)
async def invalid(request,exc):
    return __import__('fastapi').responses.JSONResponse({'detail':str(exc)},409)
class RoundInput(BaseModel):
    parent: str|None=None
class ReviewInput(BaseModel):
    version:int=Field(ge=0)
    accepted:Literal['a','b','both','neither']
    preferred:Literal['a','b','tie','neither']
    caption:str=Field(max_length=2000)
    notes:str=Field(default='',max_length=2000)
    rejection_reasons:list[Literal['color','pose']]=Field(default_factory=list,max_length=2)
class JobInput(BaseModel):
    kind:Literal['generate','train']
    reference:str
    limit:int=Field(default=0,ge=0,le=500)
def refresh_jobs():
    for j in store.job_rows():
        if j['status'] in ('starting','running') and j['pid']:
            try: os.kill(j['pid'],0)
            except ProcessLookupError: store.set_job(j['id'],status='failed',message='Worker exited; generation can be resumed.')
    return store.job_rows()
def launch(body):
    with lock:
        if any(j['status'] in ('starting','running') for j in refresh_jobs()): raise ValueError('A GPU job is already active')
        store.safe_id(body.reference)
        if body.kind=='generate': store.round_config(body.reference)
        else:
            path=DATA/'snapshots'/f'{body.reference}.json'
            if not path.exists(): raise ValueError('Snapshot not found')
            snap=json.loads(path.read_text())
            if len(snap['items'])<20: raise ValueError('Approve at least 20 distinct training inputs before a LoRA pilot')
        jid=uid('job')
        with db() as c: c.execute('INSERT INTO jobs(id,kind,reference,status,created,updated) VALUES(?,?,?,?,?,?)',
                                 (jid,body.kind,body.reference,'starting',now(),now()))
        log=DATA/'jobs'/f'{jid}.log'; log.parent.mkdir(parents=True,exist_ok=True)
        env=dict(os.environ,TEACHER_LOOP_DATA=str(DATA))
        try:
            with log.open('ab') as out:
                proc=subprocess.Popen([sys.executable,'-u',str(ROOT/'tools/teacher-loop/worker.py'),body.kind,
                     '--reference',body.reference,'--job',jid,'--gpu',os.environ['TEACHER_LOOP_GPU'],
                     '--limit',str(body.limit)],cwd=ROOT,stdout=out,stderr=subprocess.STDOUT,
                     stdin=subprocess.DEVNULL,start_new_session=True,env=env)
            store.set_job(jid,pid=proc.pid)
        except Exception as exc:
            store.set_job(jid,status='failed',message=str(exc)); raise
        return {'id':jid}
@app.get('/api/status')
def status():
    with db() as c: reviewed_rounds=[r[0] for r in c.execute('SELECT DISTINCT round_id FROM reviews')]
    export_warnings=[]
    for rid in reviewed_rounds:
        try: exports.export_batches(rid)
        except Exception as exc: export_warnings.append(str(exc))
    dataset=store.manifest() if (DATA/'dataset-v1/manifest.json').exists() else None
    with db() as c:
        rounds=[dict(id=r[0],created=r[1]) for r in c.execute('SELECT id,created FROM rounds ORDER BY created DESC')]
        reviews=[dict(round_id=r[0],count=r[1]) for r in c.execute('SELECT round_id,count(*) FROM reviews GROUP BY round_id')]
    for r in rounds: r['ready']=len(list((DATA/'rounds'/r['id']).glob('*/result.json')))
    return dict(dataset_count=len(dataset['items']) if dataset else 0,rounds=rounds,reviews=reviews,jobs=refresh_jobs(),exports=exports.listing(),export_warnings=export_warnings,
       snapshots=[dict(id=p.stem,count=len(json.loads(p.read_text())['items'])) for p in sorted((DATA/'snapshots').glob('*.json'))],
       adapters=[dict(id=p.parent.name,**json.loads(p.read_text())) for p in sorted((DATA/'adapters').glob('*/result.json'))])
@app.post('/api/rounds')
def new_round(body:RoundInput): return store.create_round(body.parent)
@app.get('/api/rounds/{rid}')
def get_round(rid:str):
    config=store.round_config(rid)
    with db() as c: reviews={r[0]:dict(version=r[1],**json.loads(r[2])) for r in c.execute('SELECT item_id,version,payload FROM reviews WHERE round_id=?',(rid,))}
    return dict(config=config,items=[dict(**item,ready=store.result_path(rid,item['id']).exists(),review=reviews.get(item['id'])) for item in store.items().values()])
@app.get('/api/rounds/{rid}/items/{iid}')
def get_item(rid:str,iid:str):
    store.round_config(rid); item=store.items().get(iid)
    if not item: raise HTTPException(404)
    return dict(item=item,result=store.candidate_result(rid,iid),review=store.get_review(rid,iid))
@app.post('/api/rounds/{rid}/items/{iid}/review')
def review(rid:str,iid:str,body:ReviewInput,start:int|None=Query(default=None,ge=0,le=499),end:int|None=Query(default=None,ge=0,le=499)):
    if (start is None)!=(end is None):raise ValueError('Provide both range bounds')
    if start is not None:exports.validate_range(start,end)
    result=store.save_review(rid,iid,body.model_dump(exclude={'version'}),body.version)
    try: result['exports']=exports.export_batches(rid,start,end)
    except Exception as exc: result['export_warning']='标注已保存，JSONL 导出待重试：'+str(exc)
    return result
@app.get('/api/exports')
def export_list(): return exports.listing()
@app.post('/api/rounds/{rid}/export')
def export_current(rid:str,start:int|None=Query(default=None,ge=0,le=499),end:int|None=Query(default=None,ge=0,le=499)):
    if (start is None)!=(end is None):raise ValueError('Provide both range bounds')
    return exports.export_all(rid,start,end)
@app.get('/api/exports/{key:path}')
def export_file(key:str):
    path=exports.get_path(key)
    return FileResponse(path,media_type='application/x-ndjson',filename=path.name)
@app.post('/api/freeze')
def freeze(): return store.freeze()
@app.post('/api/jobs')
def job(body:JobInput): return launch(body)
@app.get('/api/jobs/{jid}/log')
def log(jid:str):
    p=DATA/'jobs'/f'{store.safe_id(jid)}.log'
    return {'text':p.read_text(errors='replace')[-12000:] if p.exists() else ''}
@app.get('/api/backup')
def backup():
    directory=DATA/'backups'; directory.mkdir(exist_ok=True)
    path=directory/(uid('reviews')+'.sqlite3')
    with db() as c:
        dest=sqlite3.connect(path); c.backup(dest); dest.close()
    return FileResponse(path,filename=path.name)
@app.get('/images/{rid}/{iid}/{variant}')
def image(rid:str,iid:str,variant:str):
    item=store.items().get(iid)
    if not item: raise HTTPException(404)
    if variant=='source': path=DATA/item['photo_path']
    else:
        if variant not in ('a','b','a-master','b-master'): raise HTTPException(404)
        store.round_config(rid); result=store.candidate_result(rid,iid)
        if not result: raise HTTPException(404)
        v=variant[0];path=DATA/result[v]['master_path' if variant.endswith('-master') else 'path']
    return FileResponse(path,headers={'Cache-Control':'private, max-age=3600'})
app.mount('/assets',StaticFiles(directory=ROOT/'apps/teacher-review'),name='assets')
@app.get('/guide')
def guide():return FileResponse(ROOT/'apps/teacher-review/README.md',media_type='text/plain; charset=utf-8')
@app.get('/')
def index(): return FileResponse(ROOT/'apps/teacher-review/index.html',headers={'Cache-Control':'no-store'})
if __name__=='__main__':
    p=argparse.ArgumentParser(); p.add_argument('--port',type=int,default=7119); p.add_argument('--gpu',required=True)
    args=p.parse_args()
    if not args.gpu.isdigit(): raise SystemExit('Explicit single GPU index required')
    os.environ['TEACHER_LOOP_GPU']=args.gpu
    import uvicorn
    uvicorn.run(app,host='127.0.0.1',port=args.port)
