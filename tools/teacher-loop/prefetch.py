import json,pathlib
from huggingface_hub import HfApi,snapshot_download
root=pathlib.Path(__file__).resolve().parents[2]
out=root/'.tools/huggingface/pinned/sdxl-base'
repo='stabilityai/stable-diffusion-xl-base-1.0'
rev='462165984030d82259a11f4367a4eed129e94a7b'
snapshot_download(repo,revision=rev,local_dir=out,allow_patterns=[
 'model_index.json','scheduler/*','tokenizer/*','tokenizer_2/*',
 'text_encoder/config.json','text_encoder/model.fp16.safetensors',
 'text_encoder_2/config.json','text_encoder_2/model.fp16.safetensors',
 'unet/config.json','unet/diffusion_pytorch_model.fp16.safetensors',
 'vae/config.json','vae/diffusion_pytorch_model.fp16.safetensors','LICENSE.md','README.md'
],max_workers=4)
(root/'output/teacher-loop/model.json').write_text(json.dumps(dict(repo=repo,revision=rev,path=str(out)),indent=2))
print('Model ready',rev,flush=True)
