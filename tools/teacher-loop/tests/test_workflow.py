import hashlib,json,pathlib,sys,tempfile,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
import store
class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.old=store.DATA; store.DATA=pathlib.Path(self.tmp.name)
        self.data=store.DATA; (self.data/'dataset-v1/images').mkdir(parents=True)
        entries=[]
        for i,split in enumerate(('train','validation','test')):
            p=self.data/f'dataset-v1/images/input{i}.jpg'; p.write_bytes(b'source'+str(i).encode())
            entries.append(dict(id=f'input{i}',path=f'images/input{i}.jpg',category='animal',caption='a cat',
                split=split,group_id=f'g{i}',sha256=store.digest(p)))
        store.atomic(self.data/'dataset-v1/manifest.json',dict(items=entries))
        (self.data/'dataset-v1/manifest.sha256').write_text(store.digest(self.data/'dataset-v1/manifest.json'))
        store.atomic(self.data/'model.json',dict(path='/unloaded-fixture',revision='fixture'))
        self.cfg=store.create_round(); self.rid=self.cfg['id']
        for item in entries:
            directory=store.result_path(self.rid,item['id']).parent; directory.mkdir(parents=True)
            result=dict(source_sha256=item['sha256'],config_sha256=hashlib.sha256(store.dump(self.cfg).encode()).hexdigest())
            for v in ('a','b'):
                p=directory/(v+'.png'); p.write_bytes(v.encode())
                result[v]=dict(path=str(p.relative_to(self.data)),sha256=store.digest(p))
            store.atomic(directory/'result.json',result)
    def tearDown(self): store.DATA=self.old; self.tmp.cleanup()
    def review(self,i=0,choice='a',version=0):
        return store.save_review(self.rid,f'input{i}',dict(accepted=choice,preferred=choice if choice!='both' else 'b',caption='a flat cartoon cat',notes='test fixture'),version)
    def test_no_labels_no_training_export(self):
        with self.assertRaisesRegex(ValueError,'No approved'): store.freeze()
    def test_holdouts_excluded(self):
        for i in range(3): self.review(i)
        export=store.freeze(); snapshot=json.loads((self.data/'snapshots'/f"{export['id']}.json").read_text())
        self.assertEqual([r['item_id'] for r in snapshot['items']],['input0'])
        self.assertTrue((self.data/'snapshots'/f"{export['id']}.sqlite3").exists())
    def test_conflicting_writes_do_not_overwrite(self):
        self.review()
        with self.assertRaisesRegex(ValueError,'another tab'): self.review(choice='b')
        self.assertEqual(store.get_review(self.rid,'input0')['accepted'],'a')
    def test_latest_rejection_removes_old_target(self):
        self.review(); self.review(choice='neither',version=1)
        with self.assertRaisesRegex(ValueError,'No approved'): store.freeze()
        with store.db() as c: self.assertEqual(c.execute('SELECT count(*) FROM review_history').fetchone()[0],2)
    def test_both_accepts_export_one_preferred_target(self):
        self.review(choice='both'); s=store.freeze()
        item=json.loads((self.data/'snapshots'/f"{s['id']}.json").read_text())['items'][0]
        self.assertTrue(item['target_path'].endswith('/b.png'))
    def test_candidate_tampering_rejected(self):
        p=store.result_path(self.rid,'input0').parent/'a.png'; p.write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError,'Candidate image changed'): self.review()
    def test_source_tampering_rejected(self):
        (self.data/'dataset-v1/images/input0.jpg').write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError,'Source image changed'): self.review()
    def test_dataset_tampering_rejected(self):
        with (self.data/'dataset-v1/manifest.json').open('a') as f: f.write(' ')
        with self.assertRaisesRegex(ValueError,'hash mismatch'): store.manifest()
    def test_missing_candidates_not_reviewable(self):
        store.result_path(self.rid,'input0').unlink()
        with self.assertRaisesRegex(ValueError,'not ready'): self.review()
    def test_preference_is_not_acceptance(self):
        with self.assertRaisesRegex(ValueError,'agree'):
            store.save_review(self.rid,'input0',dict(accepted='neither',preferred='a',caption='cat'),0)
    def test_path_traversal_rejected(self):
        with self.assertRaisesRegex(ValueError,'identifier'): store.round_config('../outside')
    def test_api_cross_origin_and_backup(self):
        from fastapi.testclient import TestClient
        import server
        server.DATA=self.data
        with TestClient(server.app) as client:
            self.assertEqual(client.get('/api/status').json()['dataset_count'],3)
            self.assertEqual(client.post('/api/freeze',headers={'Origin':'https://other.example'},json={}).status_code,403)
            self.assertEqual(client.post('/api/freeze',json={}).status_code,409)
            self.assertEqual(client.get('/api/backup').status_code,200)
            self.assertEqual(client.get('/api/status',headers={'Host':'evil.example'}).status_code,403)
        server.DATA=self.old
if __name__=='__main__': unittest.main()
