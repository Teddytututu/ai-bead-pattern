"""Range-named immutable JSONL exports; each version retains the same download name."""
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
        payload=json.loads(r['payload']);payload.setdefault('rejection_reasons',[])
        output.append(dict(schema_version=1,round_id=rid,item_id=item['id'],photo_id=item['photo_id'],image_number=item['image_number'],split=item['split'],
            category=item['category'],group_id=item['group_id'],review_version=r['version'],
            reviewed_at=r['updated'],**payload,
            source=dict(path=item['photo_path'],sha256=item['sha256'],license=item.get('license','fixture'),source_url=item.get('source_url')),
            candidates={v:result[v] for v in ('a','b')},dataset_sha256=store.digest(store.DATA/'dataset-v1/manifest.json')))
    return sorted(output,key=lambda r:r['image_number'])
def validate_range(start,end):
    if start<0 or end>=500 or end-start!=24:raise ValueError('每组需要连续 25 张，序号范围为 0–499')
def write(rid,start,end,records):
    content=''.join(store.dump(r)+'\n' for r in records)
    sha=hashlib.sha256(content.encode()).hexdigest();name=f'{start:03d}_{end:03d}.jsonl'
    directory=store.DATA/'exports'/store.safe_id(rid)/sha;directory.mkdir(parents=True,exist_ok=True)
    path=directory/name;created=not path.exists()
    if created:
        temp=directory/(name+'.'+uuid.uuid4().hex+'.tmp');temp.write_text(content);temp.replace(path)
    key=path.relative_to(store.DATA/'exports').as_posix()
    return dict(name=name,key=key,count=len(records),sha256=sha,created=created,url='/api/exports/'+key)
def export_batches(rid,start=None,end=None):
    directory=store.DATA/'exports';directory.mkdir(exist_ok=True)
    with (directory/'.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        records=rows(rid);made=[]
        ranges_path=directory/store.safe_id(rid)/'ranges.json'
        ranges={tuple(x) for x in json.loads(ranges_path.read_text())} if ranges_path.exists() else set()
        if start is not None and end is not None:
            validate_range(start,end)
            if (start,end) not in ranges:
                ranges.add((start,end));store.atomic(ranges_path,sorted(ranges))
        ranges.update((i,i+24) for i in range(0,500,25))
        for start,end in sorted(ranges):
            batch=[r for r in records if start<=r['image_number']<=end]
            if {r['image_number'] for r in batch}!=set(range(start,end+1)):continue
            result=write(rid,start,end,batch)
            if result['created']:made.append(result)
        return made
def export_all(rid,start=None,end=None):
    records=rows(rid)
    if (start is None)!=(end is None):raise ValueError('Provide both range bounds')
    if start is not None:
        validate_range(start,end);records=[r for r in records if start<=r['image_number']<=end]
    if not records:raise ValueError('当前范围还没有标注')
    if start is None:start,end=min(r['image_number'] for r in records),max(r['image_number'] for r in records)
    return write(rid,start,end,records)
def listing():
    directory=store.DATA/'exports';directory.mkdir(exist_ok=True);result=[]
    for path in sorted(directory.rglob('*.jsonl'),key=lambda p:p.stat().st_mtime,reverse=True):
        key=path.relative_to(directory).as_posix()
        result.append(dict(name=path.name,key=key,count=sum(1 for _ in path.open()),sha256=store.digest(path),url='/api/exports/'+key))
    return result
def get_path(key):
    current=r'round-[a-zA-Z0-9-]+/[0-9a-f]{64}/\d{3}_\d{3}\.jsonl'
    legacy=r'labels-[a-zA-Z0-9_-]+\.jsonl'
    if not re.fullmatch(current,key) and not re.fullmatch(legacy,key):raise ValueError('Invalid export path')
    path=store.DATA/'exports'/key
    if not path.is_file():raise ValueError('Export not found')
    return path
