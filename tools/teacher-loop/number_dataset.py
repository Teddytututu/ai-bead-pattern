"""Create 000.jpg..499.jpg without invalidating existing rounds or human labels."""
import json,os,pathlib
from store import DATA,ROOT,atomic,digest,manifest
def main():
    source=manifest();base_hash=digest(DATA/'dataset-v1/manifest.json')
    target=ROOT/'.tools/migrated-datasets/teacher-loop-numbered'
    target.mkdir(parents=True,exist_ok=True);(target/'images').mkdir(exist_ok=True)
    records=[]
    for number,item in enumerate(source['items']):
        photo_id=f'{number:03d}';name=photo_id+'.jpg'
        original=DATA/'dataset-v1'/item['path'];path=target/'images'/name
        if digest(original)!=item['sha256']:raise ValueError('Original changed: '+item['id'])
        if not path.exists():os.link(original,path)
        if digest(path)!=item['sha256']:raise ValueError('Numbered file mismatch: '+name)
        records.append(dict(**{k:v for k,v in item.items() if k not in ('id','path')},
            id=photo_id,image_number=number,path='images/'+name,legacy_id=item['id'],legacy_path=item['path']))
    numbered=dict(version=1,source_manifest_sha256=base_hash,items=records)
    path=target/'manifest.json'
    if path.exists():
        if json.loads(path.read_text())!=numbered:raise ValueError('Refusing to change established numbering')
    else:
        atomic(path,numbered);(target/'manifest.sha256').write_text(digest(path)+'  manifest.json\n')
    link=DATA/'dataset-numbered'
    if not link.exists():link.symlink_to(target.resolve(),target_is_directory=True)
    if link.resolve()!=target.resolve():raise ValueError('Unexpected numbered dataset location')
    print(json.dumps(dict(count=len(records),first=records[0]['id'],last=records[-1]['id'],sha256=digest(path))))
if __name__=='__main__':main()
