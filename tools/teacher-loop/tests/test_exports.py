import hashlib,json,pathlib,sys,tempfile,unittest
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
import store,exports
from render import square_output
from PIL import Image
class ExportTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.old=store.DATA;store.DATA=pathlib.Path(self.tmp.name)
  root=store.DATA;entries=[];(root/'dataset-v1/images').mkdir(parents=True)
  for i in range(30):
   p=root/f'dataset-v1/images/i{i}.jpg';p.write_bytes(str(i).encode())
   entries.append(dict(id=f'i{i}',path=f'images/i{i}.jpg',sha256=store.digest(p),category='animal',split='train',group_id=f'i{i}'))
  store.atomic(root/'dataset-v1/manifest.json',dict(items=entries))
  (root/'dataset-v1/manifest.sha256').write_text(store.digest(root/'dataset-v1/manifest.json'))
  store.atomic(root/'model.json',dict(path='/fixture',revision='fixture'))
  cfg=store.create_round();self.rid=cfg['id']
  for i in entries:
   p=store.result_path(self.rid,i['id']);p.parent.mkdir(parents=True)
   result=dict(source_sha256=i['sha256'],config_sha256=hashlib.sha256(store.dump(cfg).encode()).hexdigest())
   for v in ('a','b'):
    q=p.parent/(v+'.png');q.write_bytes(v.encode());result[v]=dict(path=str(q.relative_to(root)),sha256=store.digest(q))
   store.atomic(p,result)
 def tearDown(self):store.DATA=self.old;self.tmp.cleanup()
 def review(self,i,version=0,accepted='a'):
  return store.save_review(self.rid,f'i{i}',dict(accepted=accepted,preferred=accepted,caption='a cartoon cat',rejection_reasons=['color'] if accepted=='neither' else []),version)
 def test_every_25_unique_and_edit_version(self):
  for i in range(24):self.review(i)
  self.assertEqual(exports.export_batches(self.rid),[])
  self.review(24,accepted='neither');made=exports.export_batches(self.rid)
  self.assertEqual(len(made),1);self.assertEqual(made[0]['count'],25)
  rows=[json.loads(line) for line in exports.get_path(made[0]['key']).read_text().splitlines()]
  self.assertEqual(len(rows),25);self.assertEqual(rows[-1]['accepted'],'neither')
  self.assertEqual(exports.export_batches(self.rid),[])
  self.review(25);self.assertEqual(exports.export_batches(self.rid),[])
  self.review(0,version=1,accepted='b');updated=exports.export_batches(self.rid)
  self.assertEqual(len(updated),1);self.assertEqual(updated[0]['name'],'000_024.jsonl');self.assertNotEqual(updated[0]['key'],made[0]['key'])
  self.assertTrue(exports.get_path(made[0]['key']).exists())
  self.assertEqual(exports.export_all(self.rid)['count'],26)
 def test_failed_export_does_not_lose_annotation(self):
  import server
  from fastapi.testclient import TestClient
  server.DATA=store.DATA
  with TestClient(server.app) as c,patch.object(exports,'export_batches',side_effect=OSError('disk full')):
   r=c.post(f'/api/rounds/{self.rid}/items/i0/review',json=dict(version=0,accepted='a',preferred='a',caption='a cartoon cat'))
   self.assertEqual(r.status_code,200);self.assertIn('export_warning',r.json())
   self.assertEqual(store.get_review(self.rid,'i0')['version'],1)
  server.DATA=self.old
 def test_numbered_ids_and_range_export(self):
  self.review(0);self.review(24);self.review(25)
  result=exports.export_all(self.rid,0,24)
  records=[json.loads(x) for x in exports.get_path(result['key']).read_text().splitlines()]
  self.assertEqual([x['photo_id'] for x in records],['000','024'])
  self.assertEqual([x['image_number'] for x in records],[0,24])
  self.assertEqual([x['item_id'] for x in records],['i0','i24'])
  with self.assertRaises(ValueError):exports.export_all(self.rid,490,514)
 def test_custom_group_recovers_and_download_filename(self):
  for i in range(1,26):self.review(i)
  self.assertEqual(exports.export_batches(self.rid),[])
  made=exports.export_batches(self.rid,1,25)
  self.assertEqual(made[0]['name'],'001_025.jsonl')
  self.review(1,version=1,accepted='b')
  recovered=exports.export_batches(self.rid)
  self.assertEqual(recovered[0]['name'],'001_025.jsonl')
  from fastapi.testclient import TestClient
  import server
  server.DATA=store.DATA
  with TestClient(server.app) as c:
   response=c.get(recovered[0]['url'])
   self.assertEqual(response.status_code,200)
   self.assertIn('001_025.jsonl',response.headers['content-disposition'])
   self.assertEqual(len(response.text.splitlines()),25)
  server.DATA=self.old
 def test_export_filename_traversal(self):
  with self.assertRaises(ValueError):exports.get_path('../reviews.sqlite3')
 def test_256_preserves_ratio_and_letterboxes(self):
  image=Image.new('RGB',(200,100),'red');out=square_output(image)
  self.assertEqual(out.size,(256,256))
  self.assertEqual(out.getpixel((128,20)),(255,255,255))
  self.assertEqual(out.getpixel((128,80)),(255,0,0))
  self.assertEqual(out.getpixel((128,220)),(255,255,255))
if __name__=='__main__':unittest.main()
