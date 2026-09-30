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
  return store.save_review(self.rid,f'i{i}',dict(accepted=accepted,preferred=accepted,caption='a cartoon cat'),version)
 def test_every_25_unique_and_edit_version(self):
  for i in range(24):self.review(i)
  self.assertEqual(exports.export_batches(self.rid),[])
  self.review(24,accepted='neither');made=exports.export_batches(self.rid)
  self.assertEqual(len(made),1);self.assertEqual(made[0]['count'],25)
  rows=[json.loads(line) for line in exports.get_path(made[0]['name']).read_text().splitlines()]
  self.assertEqual(len(rows),25);self.assertEqual(rows[-1]['accepted'],'neither')
  self.assertEqual(exports.export_batches(self.rid),[])
  self.review(25);self.assertEqual(exports.export_batches(self.rid),[])
  self.review(0,version=1,accepted='b');updated=exports.export_batches(self.rid)
  self.assertEqual(len(updated),1);self.assertNotEqual(updated[0]['name'],made[0]['name'])
  self.assertTrue(exports.get_path(made[0]['name']).exists())
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
 def test_export_filename_traversal(self):
  with self.assertRaises(ValueError):exports.get_path('../reviews.sqlite3')
 def test_256_preserves_ratio_and_letterboxes(self):
  image=Image.new('RGB',(200,100),'red');out=square_output(image)
  self.assertEqual(out.size,(256,256))
  self.assertEqual(out.getpixel((128,20)),(255,255,255))
  self.assertEqual(out.getpixel((128,80)),(255,0,0))
  self.assertEqual(out.getpixel((128,220)),(255,255,255))
if __name__=='__main__':unittest.main()
