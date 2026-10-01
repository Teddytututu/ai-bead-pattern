import pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
from worker import generation_pool

class ShardTests(unittest.TestCase):
    def test_shards_partition_every_input_exactly_once(self):
        rows=[dict(id=f'a{i}',category='animal') for i in range(250)]+[dict(id=f'b{i}',category='anime') for i in range(250)]
        original=generation_pool(rows)
        shards=[generation_pool(rows,shard_index=i,shard_count=6) for i in range(6)]
        flattened=[row['id'] for shard in shards for row in shard]
        self.assertEqual(len(flattened),500)
        self.assertEqual(len(set(flattened)),500)
        self.assertEqual(set(flattened),{row['id'] for row in rows})
        self.assertEqual([row['id'] for row in original[:4]],['a0','b0','a1','b1'])
        self.assertEqual([row['id'] for row in shards[3]],[row['id'] for row in original[3::6]])
    def test_limit_is_applied_before_partition(self):
        rows=[dict(id=str(i),category='animal') for i in range(7)]
        self.assertEqual([row['id'] for row in generation_pool(rows,limit=5,shard_index=1,shard_count=2)],['1','3'])
    def test_bad_shards_fail_before_model_loading(self):
        for index,count in [(-1,6),(6,6),(0,0),(0,-1)]:
            with self.assertRaises(ValueError):generation_pool([],shard_index=index,shard_count=count)

if __name__=='__main__':unittest.main()
