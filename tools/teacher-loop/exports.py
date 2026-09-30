"""Idempotent JSONL exports after each 25 distinct reviewed inputs, scoped per round."""
import fcntl,hashlib,json,pathlib,re,uuid
import store
def rows(rid):
    store.round_config(rid)
    with store.db() as c:
        reviews=c.execute("""SELECT r.* FROM reviews r JOIN review_history h
          ON h.round_id=r.round_id AND h.item_id=r.item_id AND h.version=1
          WHERE r.round_id=? ORDER BY h.updated,r.item_id""",(rid,)).fetchall()
    pool=store.items(); output=[]
    for r in reviews:
        item=pool[r['item_id']]; result=store.candidate_result(rid,item['id'])
        output.append(dict(schema_version=1,round_id=rid,item_id=item['id'],split=item['split'],
            category=item['category'],group_id=item['group_id'],review_version=r['version'],
            reviewed_at=r['updated'],**json.loads(r['payload']),
            source=dict(path='dataset-v1/'+item['path'],sha256=item['sha256'],license=item['license'] if 'license' in item else 'fixture',
                        source_url=item.get('source_url')),
            candidates={v:result[v] for v in ('a','b')},
            dataset_sha256=store.digest(store.DATA/'dataset-v1/manifest.json')))
    return output
def write(rid,label,records):
    content=''.join(store.dump(r)+'\n' for r in records)
    sha=hashlib.sha256(content.encode()).hexdigest()
    name=f'labels-{rid}-{label}-{sha[:12]}.jsonl'
    directory=store.DATA/'exports';directory.mkdir(exist_ok=True)
    path=directory/name; created=not path.exists()
    if created:
        temp=directory/(name+'.'+uuid.uuid4().hex+'.tmp');temp.write_text(content);temp.replace(path)
    return dict(name=name,count=len(records),sha256=sha,created=created,url='/api/exports/'+name)
def export_batches(rid):
    directory=store.DATA/'exports';directory.mkdir(exist_ok=True)
    with (directory/'.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        records=rows(rid); made=[]
        for start in range(0,len(records)-24,25):
            result=write(rid,f'{start+1:04d}-{start+25:04d}',records[start:start+25])
            if result['created']: made.append(result)
        return made
def export_all(rid):
    records=rows(rid)
    if not records: raise ValueError('当前轮次还没有标注')
    return write(rid,'all',records)
def listing():
    directory=store.DATA/'exports';directory.mkdir(exist_ok=True)
    return [dict(name=p.name,count=sum(1 for _ in p.open()),sha256=store.digest(p),url='/api/exports/'+p.name)
            for p in sorted(directory.glob('*.jsonl'),key=lambda p:p.stat().st_mtime,reverse=True)]
def get_path(name):
    if not re.fullmatch(r'labels-[a-zA-Z0-9_-]+\.jsonl',name): raise ValueError('Invalid export filename')
    path=store.DATA/'exports'/name
    if not path.is_file(): raise ValueError('Export not found')
    return path
