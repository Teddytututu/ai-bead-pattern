"""Build the reproducible starter pool. Originals and source records stay outside Git."""
import argparse, concurrent.futures, hashlib, io, json, pathlib, random, re, tarfile, time, urllib.request
from PIL import Image, ImageOps
ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = ROOT / 'output/teacher-loop/dataset-v1'
CACHE = ROOT / '.tools/cache/teacher-loop'
REPO = 'alfredplpl/anime-with-caption-cc0'
REV = '13c9c9a1df5cf927962b575e51b110c4fa113d5c'
PET_URL = 'https://www.robots.ox.ac.uk/~vgg/data/pets/data/images.tar.gz'
def fetch(url, path=None):
    if path and path.exists(): return path.read_bytes()
    for attempt in range(5):
        try:
            req=urllib.request.Request(url, headers={'User-Agent':'image-pindou-dataset/1.0'})
            with urllib.request.urlopen(req, timeout=120) as response: raw=response.read()
            if path:
                path.parent.mkdir(parents=True,exist_ok=True)
                temp=path.with_suffix('.part'); temp.write_bytes(raw); temp.replace(path)
            return raw
        except Exception:
            if attempt==4: raise
            time.sleep(2**attempt)
def sha(raw): return hashlib.sha256(raw).hexdigest()
def emit(name, raw, category, info):
    im=ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert('RGB')
    phash=''.join('1' if x>y else '0' for row in range(8) for x,y in zip(
        list(im.resize((9,8)).convert('L').getdata())[row*9:row*9+8],
        list(im.resize((9,8)).convert('L').getdata())[row*9+1:row*9+9]))
    rel=f'images/{name}.jpg'; (DATA/rel).parent.mkdir(parents=True,exist_ok=True)
    # Preserve downloaded bytes; all chosen sources are JPEG.
    (DATA/rel).write_bytes(raw)
    return dict(id=name,category=category,path=rel,sha256=sha(raw),width=im.width,height=im.height,
                dhash=hex(int(phash,2)),**info)
def animals():
    archive=CACHE/'pets-images.tar.gz'
    print('Downloading Oxford-IIIT Pet archive',flush=True); fetch(PET_URL,archive)
    by_breed={}
    with tarfile.open(archive) as tar:
        for member in tar:
            if not member.isfile() or not member.name.endswith('.jpg') or '/._' in member.name: continue
            raw=tar.extractfile(member).read()
            try:
                im=Image.open(io.BytesIO(raw))
                if min(im.size)<400 or max(im.size)<500: continue
                name=pathlib.Path(member.name).stem
                breed=re.sub(r'_\d+$','',name)
                by_breed.setdefault(breed,[]).append((name,raw,im.size))
            except Exception: continue
    for breed,items in by_breed.items():
        items.sort(key=lambda x:(-min(x[2]),sha(x[0].encode())))
    chosen=[]
    while len(chosen)<250:
        before=len(chosen)
        for breed in sorted(by_breed):
            if by_breed[breed] and len(chosen)<250:
                name,raw,size=by_breed[breed].pop(0)
                animal='cat' if breed[0].isupper() else 'dog'
                chosen.append(emit('animal-'+name.lower(),raw,'animal',dict(
                    source_group='oxford:'+name,source_id=name,source_url=PET_URL,
                    source_page='https://www.robots.ox.ac.uk/~vgg/data/pets/',
                    source_archive_sha256=sha(archive.read_bytes()) if len(chosen)==0 else None,
                    license='CC-BY-SA-4.0',attribution='Oxford-IIIT Pet: Parkhi, Vedaldi, Zisserman, Jawahar; image copyright remains with original owners.',
                    caption=f'a {breed.replace("_"," ")} {animal}',synthetic=False)))
        if before==len(chosen): raise RuntimeError('Not enough pet photographs')
    return chosen
def page(offset):
    p=CACHE/f'anime-rows-{REV}-{offset}.json'
    url=f'https://datasets-server.huggingface.co/rows?dataset={REPO}&config=default&split=train&offset={offset}&length=100'
    return json.loads(fetch(url,p))['rows']
def anime():
    import cv2
    import numpy as np
    card=fetch(f'https://huggingface.co/datasets/{REPO}/raw/{REV}/README.md')
    (DATA/'anime-source-card.md').write_bytes(card)
    cascade_path=CACHE/'lbpcascade_animeface.xml'
    fetch('https://raw.githubusercontent.com/nagadomi/lbpcascade_animeface/master/lbpcascade_animeface.xml',cascade_path)
    cascade=cv2.CascadeClassifier(str(cascade_path))
    candidates=[]
    # Reuse metadata already downloaded; no per-image viewer queries.
    for path in sorted(CACHE.glob(f'anime-rows-{REV}-*.json')):
        for r in json.loads(path.read_text())['rows']:
            v=r['row']; prompt=v['prompt'].lower(); cap=v['phi3_caption'].lower()
            tags={t.strip() for t in prompt.split(',')}
            if not tags.intersection({'1girl','1boy','1woman','1man'}): continue
            if tags.intersection({'2girls','2boys','multiple girls','multiple boys','comic','chibi'}): continue
            if re.search(r'\b(nude|naked|nipples|topless|lingerie|underwear|bikini|swimsuit|panties|cleavage|bondage|blood|gore)\b',prompt+' '+cap): continue
            if any(t in cap for t in ('collage','panels','two girls','two women','two characters','multiple characters')): continue
            candidates.append(r)
    if not candidates:
        # Metadata discovery is intentionally rate limited; cache is resumable.
        for offset in range(0,3500,100):
            page(offset); time.sleep(3)
        return anime()
    candidates.sort(key=lambda r:sha(str(r['row_idx']).encode()))
    chosen=[]; seen=set()
    def download(r):
        try:
            raw=fetch(r['row']['image']['src'],CACHE/f"anime-{r['row_idx']}.jpg")
            return r,raw
        except Exception as e:
            return r,None
    for start in range(0,len(candidates),80):
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            downloaded=list(pool.map(download,candidates[start:start+80]))
        for r,raw in downloaded:
            if raw is None or sha(raw) in seen: continue
            seen.add(sha(raw))
            pixels=cv2.imdecode(np.frombuffer(raw,dtype=np.uint8),cv2.IMREAD_COLOR)
            gray=cv2.equalizeHist(cv2.cvtColor(pixels,cv2.COLOR_BGR2GRAY))
            faces=cascade.detectMultiScale(gray,scaleFactor=1.1,minNeighbors=5,minSize=(180,180))
            if len(faces)!=1: continue
            x,y,w,h=map(int,faces[0]); im=Image.open(io.BytesIO(raw)).convert('RGB')
            side=min(max(512,round(max(w,h)*2.35)),min(im.size))
            left=max(0,min(im.width-side,round(x+w/2-side/2)))
            top=max(0,min(im.height-side,round(y+h/2-side*0.43)))
            crop=(left,top,left+side,top+side)
            cropped=im.crop(crop); buf=io.BytesIO(); cropped.save(buf,format='JPEG',quality=97)
            idx=r['row_idx']; v=r['row']; name=f'anime-{idx:05d}'
            original=DATA/'originals'/f'{name}.jpg'; original.parent.mkdir(exist_ok=True); original.write_bytes(raw)
            chosen.append(emit(name,buf.getvalue(),'anime',dict(
                source_group=f'anime-cc0:{idx}',source_id=idx,source_revision=REV,
                source_url=f'https://huggingface.co/datasets/{REPO}/viewer/default/train?row={idx}',
                source_page=f'https://huggingface.co/datasets/{REPO}',license='CC0-1.0',
                attribution='alfredplpl / anime-with-caption-cc0 (Emi 2 generated)',
                caption='anime face portrait, '+v['phi3_caption'],
                original_prompt=v['prompt'],synthetic=True,original_path=f'originals/{name}.jpg',
                original_sha256=sha(raw),original_size=list(im.size),face_box=[x,y,w,h],crop_box=list(crop),
                detector_sha256=sha(cascade_path.read_bytes()))))
            if len(chosen)>=280: break
        print('Detected single anime faces',len(chosen),'scanned',min(start+80,len(candidates)),flush=True)
        if len(chosen)>=280: break
    if len(chosen)<250: raise RuntimeError(f'Only {len(chosen)} eligible single anime faces')
    (DATA/'anime-pool.json').write_text(json.dumps(chosen,ensure_ascii=False,indent=2))
    return [r for r in chosen if r['id'] not in {'anime-02307','anime-02973','anime-01051','anime-00672','anime-02556'}][:250]
def page_fresh(idx):
    url=f'https://datasets-server.huggingface.co/rows?dataset={REPO}&config=default&split=train&offset={idx}&length=1'
    return json.loads(fetch(url))['rows'][0]
def finalize(items):
    assert len(items)==500 and len({x['sha256'] for x in items})==500
    # Connected components of near-identical perceptual hashes never cross splits.
    parents=list(range(len(items)))
    def find(i):
        while parents[i]!=i:
            parents[i]=parents[parents[i]]; i=parents[i]
        return i
    for i,a in enumerate(items):
        for j in range(i):
            b=items[j]
            if a['category']==b['category'] and (int(a['dhash'],16)^int(b['dhash'],16)).bit_count()<=5:
                parents[find(i)]=find(j)
    rng=random.Random(20261001)
    for category in ('animal','anime'):
        groups={}
        for i,item in enumerate(items):
            if item['category']==category: groups.setdefault(find(i),[]).append(item)
        groups=list(groups.values()); rng.shuffle(groups); counts={'train':0,'validation':0,'test':0}
        for group in groups:
            split='test' if counts['test']<25 else 'validation' if counts['validation']<25 else 'train'
            for item in group:
                item['split']=split; item['group_id']=group[0]['id']
            counts[split]+=len(group)
    manifest=dict(version=1,seed=20261001,items=items,notes=[
      'Starter animal pool is cats and dogs across 37 breeds, not broad wildlife.',
      'Anime sources are AI-generated portraits, not screenshots. Review inputs as well as outputs.',
      'Perceptual duplicate grouping is a heuristic, not proof of different identities.',
      'Original dimensions are recorded. No upscaling is represented as source HD.'])
    text=json.dumps(manifest,ensure_ascii=False,indent=2)+'\n'
    (DATA/'manifest.json').write_text(text)
    (DATA/'manifest.sha256').write_text(sha(text.encode())+'  manifest.json\n')
    print('READY',len(items),sha(text.encode()),flush=True)
def main():
    DATA.mkdir(parents=True,exist_ok=True); CACHE.mkdir(parents=True,exist_ok=True)
    if (DATA/'manifest.json').exists(): raise SystemExit('Frozen manifest already exists; use a new dataset version.')
    (DATA/'pets-source-page.html').write_bytes(fetch('https://www.robots.ox.ac.uk/~vgg/data/pets/'))
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        a=pool.submit(animals); b=pool.submit(anime); items=a.result()+b.result()
    finalize(items)
if __name__=='__main__': main()
