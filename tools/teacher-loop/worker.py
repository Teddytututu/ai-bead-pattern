"""One explicitly selected GPU, resumable generation, no automatic training."""
import argparse, fcntl, hashlib, json, os, pathlib, random, traceback
from store import DATA,ROOT,atomic,caption_for,checked_result,digest,dump,items,round_config,result_path,set_job
def generation_pool(all_items,limit=0,shard_index=0,shard_count=1):
    if shard_count<1 or not 0<=shard_index<shard_count: raise ValueError('Invalid generation shard')
    animals=[i for i in all_items if i['category']=='animal']; anime=[i for i in all_items if i['category']=='anime']
    pool=[i for pair in __import__('itertools').zip_longest(animals,anime) for i in pair if i]
    if limit: pool=pool[:limit]
    return pool[shard_index::shard_count]
def generate(args):
    import torch
    from PIL import Image,ImageOps
    from render import square_output
    from diffusers import StableDiffusionXLImg2ImgPipeline,StableDiffusionXLControlNetImg2ImgPipeline,ControlNetModel
    cfg=round_config(args.reference)
    pool=generation_pool(list(items().values()),args.limit,args.shard_index,args.shard_count)
    set_job(args.job,total=len(pool)*2)
    controls=None; extra={}; pipeline_class=StableDiffusionXLImg2ImgPipeline
    if cfg.get('controlnet'):
        if digest(DATA/'controls.json')!=cfg['controls_sha256']: raise ValueError('Controls manifest changed')
        controls=json.loads((DATA/'controls.json').read_text())['items']
        extra['controlnet']=ControlNetModel.from_pretrained(cfg['controlnet']['path'],variant='fp16',torch_dtype=torch.float16,local_files_only=True,use_safetensors=True)
        pipeline_class=StableDiffusionXLControlNetImg2ImgPipeline
    pipe=pipeline_class.from_pretrained(cfg['model']['path'],variant='fp16',**extra,
          torch_dtype=torch.float16,use_safetensors=True,local_files_only=True,add_watermarker=False)
    if cfg['adapter']:
        if digest(cfg['adapter']['path'])!=cfg['adapter']['sha256']: raise ValueError('Adapter changed')
        pipe.load_lora_weights(str(pathlib.Path(cfg['adapter']['path']).parent),weight_name='pytorch_lora_weights.safetensors')
    pipe.to('cuda'); pipe.enable_vae_tiling(); pipe.set_progress_bar_config(disable=True)
    progress=0; failures=[]
    for item in pool:
        iid=item['id']
        directory=result_path(cfg['id'],iid).parent; directory.mkdir(parents=True,exist_ok=True)
        with (directory/'.generate.lock').open('a') as item_lock:
            fcntl.flock(item_lock,fcntl.LOCK_EX)
            if result_path(cfg['id'],iid).exists():
                checked_result(cfg['id'],iid); progress+=2; set_job(args.job,progress=progress); continue
            directory=result_path(cfg['id'],iid).parent; directory.mkdir(parents=True,exist_ok=True)
            try:
                source=DATA/'dataset-v1'/item['path']
                if digest(source)!=item['sha256']: raise ValueError('Source hash mismatch')
                original=ImageOps.exif_transpose(Image.open(source)).convert('RGB')
                # Letterbox preserves ears, hair and full subject without stretching/cropping.
                image=ImageOps.pad(original,(cfg['size'],cfg['size']),color='white',method=Image.Resampling.LANCZOS)
                caption=caption_for(item)
                control_kwargs={}
                if controls:
                    control=controls[iid]
                    if control['source_sha256']!=item['sha256'] or digest(control['path'])!=control['sha256']: raise ValueError('Control image changed')
                    control_kwargs=dict(control_image=Image.open(control['path']).convert('RGB'),controlnet_conditioning_scale=cfg['control_scale'],control_guidance_end=cfg['control_end'])
                prompt=cfg['style']+', '+caption
                base_seed=cfg['seed']+int(hashlib.sha256(iid.encode()).hexdigest()[:7],16)
                result=dict(source_sha256=item['sha256'],config_sha256=hashlib.sha256(dump(cfg).encode()).hexdigest(),
                            original_size=list(original.size),input_transform='white letterbox to 1024 square',prompt=prompt)
                directory=result_path(cfg['id'],iid).parent; directory.mkdir(parents=True,exist_ok=True)
                for v,params in cfg['variants'].items():
                    seed=base_seed+params['seed_offset']
                    out=pipe(prompt=prompt,negative_prompt=cfg['negative'],image=image,
                             **control_kwargs,strength=params['strength'],guidance_scale=cfg['guidance'],num_inference_steps=cfg['steps'],
                             generator=torch.Generator(device='cuda').manual_seed(seed)).images[0]
                    master=directory/f'{v}-master.png'; temp_master=directory/f'{v}-master.part.png'; out.save(temp_master);temp_master.replace(master)
                    path=directory/f'{v}.png'; tmp=directory/f'{v}.part.png'
                    square_output(out,cfg.get('output_size',256)).save(tmp); tmp.replace(path)
                    result[v]=dict(path=str(path.relative_to(DATA)),sha256=digest(path),seed=seed,strength=params['strength'],
                        width=cfg.get('output_size',256),height=cfg.get('output_size',256),master_path=str(master.relative_to(DATA)),master_sha256=digest(master))
                    progress+=1; set_job(args.job,progress=progress,message=iid+' '+v)
                atomic(directory/'result.json',result)
            except torch.cuda.OutOfMemoryError: raise
            except Exception as exc:
                failures.append(dict(item_id=iid,error=str(exc))); atomic(directory/'error.json',failures[-1])
                set_job(args.job,message=f'{iid}: {exc}')
    if failures:
        atomic(DATA/'jobs'/f'{args.job}-failures.json',failures)
        raise RuntimeError(f'{len(failures)} inputs failed; rerun this round to resume')
def main():
    p=argparse.ArgumentParser(); p.add_argument('kind',choices=['generate','train'])
    p.add_argument('--reference',required=True); p.add_argument('--job',required=True)
    p.add_argument('--gpu',required=True); p.add_argument('--limit',type=int,default=0)
    p.add_argument('--shard-index',type=int,default=0); p.add_argument('--shard-count',type=int,default=1)
    args=p.parse_args()
    generation_pool([],shard_index=args.shard_index,shard_count=args.shard_count)
    if args.kind=='train' and args.shard_count!=1: raise ValueError('Sharding only applies to generation')
    if not args.gpu.isdigit(): raise ValueError('Select one GPU index explicitly')
    os.environ['CUDA_VISIBLE_DEVICES']=args.gpu
    try:
        with (DATA/f'gpu-{args.gpu}.lock').open('w') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            set_job(args.job,status='running',pid=os.getpid())
            if args.kind=='generate': generate(args)
            else:
                from train import train
                train(args)
            set_job(args.job,status='completed',message='Completed')
    except Exception as exc:
        traceback.print_exc(); set_job(args.job,status='failed',message=str(exc)[:1000]); raise
if __name__=='__main__': main()
