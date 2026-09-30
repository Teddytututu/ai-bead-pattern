"""Create a consistent portable backup and print one JSON receipt."""
import argparse,json,sqlite3,tarfile
from store import DATA,ROOT,db,digest,uid
p=argparse.ArgumentParser();p.add_argument('--scope',choices=['dataset','review','all'],default='all');args=p.parse_args()
ident=uid('backup');directory=ROOT/'.tools/cache/teacher-loop-backups'/ident;directory.mkdir(parents=True)
archive=directory/(ident+'.tar')
with tarfile.open(archive,'w',dereference=True) as tar:
 if args.scope in ('dataset','all'):tar.add(DATA/'dataset-v1',arcname='dataset-v1')
 if args.scope in ('review','all'):
  sqlite_path=directory/'reviews.sqlite3'
  with db() as conn:
   dest=sqlite3.connect(sqlite_path);conn.backup(dest);dest.close()
  tar.add(sqlite_path,arcname='reviews.sqlite3')
  for name in ('snapshots','exports','model.json','control-model.json','controls.json'):
   path=DATA/name
   if path.exists():tar.add(path,arcname=name)
  for cfg in (DATA/'rounds').glob('*/config.json'):tar.add(cfg,arcname=str(cfg.relative_to(DATA)))
  for result in (DATA/'rounds').glob('*/*/result.json'):
   tar.add(result.parent,arcname=str(result.parent.relative_to(DATA)),filter=lambda x:None if '.part' in x.name else x)
  for result in (DATA/'adapters').glob('*/result.json'):
   tar.add(result.parent,arcname=str(result.parent.relative_to(DATA)))
record=dict(id=ident,path=str(archive),sha256=digest(archive),bytes=archive.stat().st_size,scope=args.scope)
(directory/'receipt.json').write_text(json.dumps(record,indent=2));print(json.dumps(record))
