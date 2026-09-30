import json,pathlib
from huggingface_hub import snapshot_download
root=pathlib.Path(__file__).resolve().parents[2]
repo='diffusers/controlnet-canny-sdxl-1.0'; rev='eb115a19a10d14909256db740ed109532ab1483c'
out=root/'.tools/huggingface/pinned/sdxl-canny'
snapshot_download(repo,revision=rev,local_dir=out,allow_patterns=['config.json','diffusion_pytorch_model.fp16.safetensors','README.md'],max_workers=2)
(root/'output/teacher-loop/control-model.json').write_text(json.dumps(dict(repo=repo,revision=rev,path=str(out)),indent=2))
print('ControlNet ready',rev,flush=True)
