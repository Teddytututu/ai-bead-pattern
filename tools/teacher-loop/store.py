"""Persistent review store. SQLite transactions protect human labels and frozen exports."""
import contextlib, datetime, hashlib, json, os, pathlib, re, sqlite3, uuid
ROOT=pathlib.Path(__file__).resolve().parents[2]
DATA=pathlib.Path(os.environ.get('TEACHER_LOOP_DATA',ROOT/'output/teacher-loop')).resolve()
STYLE="a simple cute 2D cartoon drawing, clean bold outlines, flat solid natural colors, simplified shapes, minimal detail, plain white background, cartoon sticker"
NEGATIVE='psychedelic, abstract, intricate patterns, multicolored fur, excessive stripes, rainbow colors, photo, photography, photorealistic, realistic fur, fur strands, 3d render, detailed shading, complex background, noisy texture, text, watermark, logo, deformed, extra eyes, duplicate face, extra limbs, blur'
def caption_for(item):
    text=item['caption'].split('. ')[0]
    return ' '.join(text.split()[:28])
def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def uid(prefix): return prefix+'-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')+'-'+uuid.uuid4().hex[:6]
def dump(obj): return json.dumps(obj,ensure_ascii=False,sort_keys=True)
def digest(path): return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
def atomic(path,obj):
    path=pathlib.Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    with temp.open('w') as f: f.write(dump(obj)+'\n'); f.flush(); os.fsync(f.fileno())
    temp.replace(path)
def safe_id(value):
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}',value): raise ValueError('Invalid identifier')
    return value
@contextlib.contextmanager
def db():
    DATA.mkdir(parents=True,exist_ok=True)
    conn=sqlite3.connect(DATA/'reviews.sqlite3',timeout=30); conn.row_factory=sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL'); conn.execute('PRAGMA foreign_keys=ON')
    try:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS rounds(id TEXT PRIMARY KEY, config TEXT NOT NULL, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reviews(round_id TEXT, item_id TEXT, version INTEGER, payload TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY(round_id,item_id));
        CREATE TABLE IF NOT EXISTS review_history(round_id TEXT,item_id TEXT,version INTEGER,payload TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(round_id,item_id,version));
        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,kind TEXT,reference TEXT,status TEXT,pid INTEGER,progress INTEGER DEFAULT 0,total INTEGER DEFAULT 0,message TEXT DEFAULT '',created TEXT,updated TEXT);
        """)
        yield conn
        conn.commit()
    finally: conn.close()
def manifest():
    path=DATA/'dataset-v1/manifest.json'
    value=json.loads(path.read_text())
    expected=(path.parent/'manifest.sha256').read_text().split()[0]
    if digest(path)!=expected: raise ValueError('Dataset manifest hash mismatch')
    return value
def items(): return {item['id']:item for item in manifest()['items']}
def round_config(rid):
    with db() as c: row=c.execute('SELECT config FROM rounds WHERE id=?',(safe_id(rid),)).fetchone()
    if row is None: raise ValueError('Round not found')
    config=json.loads(row[0])
    if config['dataset_sha256']!=digest(DATA/'dataset-v1/manifest.json'): raise ValueError('Round dataset changed')
    return config
def create_round(parent=None):
    model=json.loads((DATA/'model.json').read_text())
    adapter=None
    if parent:
        parent=safe_id(parent); meta=DATA/'adapters'/parent/'result.json'
        if not meta.exists(): raise ValueError('Adapter training has not completed')
        result=json.loads(meta.read_text()); p=DATA/'adapters'/parent/'pytorch_lora_weights.safetensors'
        if digest(p)!=result['adapter_sha256']: raise ValueError('Adapter hash mismatch')
        adapter=dict(id=parent,path=str(p),sha256=result['adapter_sha256'])
    rid=uid('round')
    control=json.loads((DATA/'control-model.json').read_text()) if (DATA/'control-model.json').exists() else None
    cfg=dict(id=rid,created=now(),dataset_sha256=digest(DATA/'dataset-v1/manifest.json'),model=model,
             adapter=adapter,size=1024,output_size=256,output_transform='isotropic resize with white letterbox; no crop',steps=30,guidance=8.0,style=STYLE,negative=NEGATIVE,
             variants={'a':{'strength':0.42,'seed_offset':0},'b':{'strength':0.58,'seed_offset':1}},
             seed=20261001)
    if control:
        cfg.update(controlnet=control,controls_sha256=digest(DATA/'controls.json'),control_scale=0.3,control_end=0.65)
        cfg['variants']={'a':{'strength':0.95,'seed_offset':0},'b':{'strength':1.0,'seed_offset':1}}
    # Same source/variant seeds across rounds permit matched comparisons.
    with db() as c: c.execute('INSERT INTO rounds VALUES(?,?,?)',(rid,dump(cfg),cfg['created']))
    atomic(DATA/'rounds'/rid/'config.json',cfg)
    return cfg
def result_path(rid,iid): return DATA/'rounds'/safe_id(rid)/safe_id(iid)/'result.json'
def candidate_result(rid,iid):
    p=result_path(rid,iid)
    return json.loads(p.read_text()) if p.exists() else None
def checked_result(rid,iid):
    item=items().get(iid)
    if item is None: raise ValueError('Input not found')
    result=candidate_result(rid,iid)
    if not result: raise ValueError('Candidates are not ready')
    if digest(DATA/'dataset-v1'/item['path'])!=item['sha256']: raise ValueError('Source image changed')
    if result['source_sha256']!=item['sha256']: raise ValueError('Candidate source mismatch')
    if result['config_sha256']!=hashlib.sha256(dump(round_config(rid)).encode()).hexdigest(): raise ValueError('Candidate settings mismatch')
    for v in ('a','b'):
        if digest(DATA/result[v]['path'])!=result[v]['sha256']: raise ValueError('Candidate image changed')
        if result[v].get('master_path') and digest(DATA/result[v]['master_path'])!=result[v]['master_sha256']: raise ValueError('Training master changed')
    return result
def get_review(rid,iid):
    with db() as c: r=c.execute('SELECT version,payload,updated FROM reviews WHERE round_id=? AND item_id=?',(rid,iid)).fetchone()
    return dict(version=r[0],**json.loads(r[1]),updated=r[2]) if r else None
def save_review(rid,iid,payload,version):
    round_config(rid); result=checked_result(rid,iid)
    accepted=payload.get('accepted')
    preferred=payload.get('preferred')
    if accepted not in ('a','b','both','neither'): raise ValueError('Choose which candidates meet the standard')
    if preferred not in ('a','b','tie','neither'): raise ValueError('Invalid preference')
    if (accepted in ('a','b') and preferred!=accepted) or (accepted=='neither' and preferred!='neither') or (accepted=='both' and preferred=='neither'):
        raise ValueError('Preference must agree with accepted candidates')
    caption=payload.get('caption','').strip()
    if accepted!='neither' and len(caption)<5: raise ValueError('Describe the accepted target')
    if len(caption)>2000 or len(payload.get('notes',''))>2000: raise ValueError('Text too long')
    body=dict(accepted=accepted,preferred=preferred,caption=caption,notes=payload.get('notes',''),
              candidate_hashes={v:result[v]['sha256'] for v in ('a','b')},master_hashes={v:result[v].get('master_sha256') for v in ('a','b')},source_sha256=result['source_sha256'])
    updated=now()
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        current=c.execute('SELECT version FROM reviews WHERE round_id=? AND item_id=?',(rid,iid)).fetchone()
        if version!=(current[0] if current else 0): raise ValueError('Annotation changed in another tab; reload before saving')
        new=version+1
        c.execute('INSERT OR REPLACE INTO reviews VALUES(?,?,?,?,?)',(rid,iid,new,dump(body),updated))
        c.execute('INSERT INTO review_history VALUES(?,?,?,?,?)',(rid,iid,new,dump(body),updated))
    return get_review(rid,iid)
def freeze():
    pool=items()
    # Latest human review per source wins, including rejection (which removes old accepted targets).
    with db() as c:
        rows=c.execute('SELECT * FROM reviews ORDER BY updated').fetchall()
    latest={r['item_id']:r for r in rows}
    selected=[]
    for iid,row in latest.items():
        if pool[iid]['split']!='train': continue
        r=json.loads(row['payload'])
        if r['accepted']=='neither': continue
        result=checked_result(row['round_id'],iid)
        variant=r['preferred'] if r['preferred'] in ('a','b') else 'a'
        if result[variant]['sha256']!=r['candidate_hashes'][variant]: raise ValueError('Reviewed candidate changed')
        if result[variant].get('master_sha256')!=r.get('master_hashes',{}).get(variant): raise ValueError('Reviewed training master changed')
        selected.append(dict(item_id=iid,group_id=pool[iid]['group_id'],source_path='dataset-v1/'+pool[iid]['path'],
             source_sha256=pool[iid]['sha256'],target_path=result[variant].get('master_path',result[variant]['path']),target_sha256=result[variant].get('master_sha256',result[variant]['sha256']),
             output_path=result[variant]['path'],output_sha256=result[variant]['sha256'],
             caption=r['caption'],review_round=row['round_id'],review_version=row['version'],
             review_sha256=hashlib.sha256(row['payload'].encode()).hexdigest(),split='train',category=pool[iid]['category']))
    if not selected: raise ValueError('No approved training targets yet; validation/test reviews cannot be trained')
    sid=uid('snapshot')
    snap=dict(id=sid,created=now(),dataset_sha256=digest(DATA/'dataset-v1/manifest.json'),
              objective='SDXL text-conditioned style LoRA; source images are retained for evaluation/student training, not UNet conditioning',
              items=sorted(selected,key=lambda x:x['item_id']))
    path=DATA/'snapshots'/f'{sid}.json'; atomic(path,snap)
    path.with_suffix('.sha256').write_text(digest(path)+'\n')
    # A consistent SQLite backup preserves history alongside the frozen snapshot.
    with db() as c:
        backup=sqlite3.connect(DATA/'snapshots'/f'{sid}.sqlite3'); c.backup(backup); backup.close()
    return dict(id=sid,count=len(selected),sha256=digest(path))
def set_job(jid,**values):
    allowed={'status','pid','progress','total','message'}
    if not set(values)<=allowed: raise ValueError('Invalid job update')
    values['updated']=now()
    with db() as c: c.execute('UPDATE jobs SET '+','.join(k+'=?' for k in values)+' WHERE id=?',(*values.values(),jid))
def job_rows():
    with db() as c: return [dict(r) for r in c.execute('SELECT * FROM jobs ORDER BY created DESC LIMIT 30')]
