"""A real GPU optimizer-step and LoRA reload test using only a procedural fixture."""
import json,os,pathlib,sys,tempfile,types,unittest.mock
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
import store,train
import numpy as np
from PIL import Image
from diffusers import StableDiffusionXLImg2ImgPipeline
import torch
root=store.ROOT; actual=store.DATA
os.environ.setdefault('CUDA_VISIBLE_DEVICES','2')
with tempfile.TemporaryDirectory(prefix='teacher-training-smoke-',dir=root/'.tools/cache') as d:
    directory=pathlib.Path(d); store.DATA=directory; train.DATA=directory
    (directory/'snapshots').mkdir()
    fixture=np.full((1024,1024,3),240,dtype=np.uint8);fixture[250:750,250:750]=[80,140,110]
    Image.fromarray(fixture).save(directory/'fixture.png')
    (directory/'model.json').write_bytes((actual/'model.json').read_bytes())
    snap=dict(id='fixture',objective='Procedural GPU test only; no user images or human annotations',items=[
        dict(target_path='fixture.png',caption='a green square on white background') for _ in range(4)])
    store.atomic(directory/'snapshots/fixture.json',snap)
    args=types.SimpleNamespace(reference='fixture',job='fixture-job',epochs=1)
    with unittest.mock.patch.object(train,'validate_snapshot',return_value=snap):
        train.train(args)
    weights=directory/'adapters/fixture-job/pytorch_lora_weights.safetensors'
    assert weights.exists() and weights.stat().st_size>0
    state=StableDiffusionXLImg2ImgPipeline.lora_state_dict(str(weights.parent),weight_name=weights.name)
    assert state
    print(json.dumps({'optimizer_step':'passed','save_and_read_lora':'passed','weight_bytes':weights.stat().st_size,
                      'peak_gpu_mb':torch.cuda.max_memory_allocated()/1024**2,'uses_real_training_data':False}),flush=True)
