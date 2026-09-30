"""Reviewed-target style LoRA. The original photograph is NOT a training condition."""
import gc,hashlib,json,math,pathlib,random
from store import DATA,atomic,db,digest,items,now,set_job
def validate_snapshot(reference):
    path=DATA/'snapshots'/f'{reference}.json'
    snapshot=json.loads(path.read_text())
    if digest(path)!=path.with_suffix('.sha256').read_text().strip(): raise ValueError('Frozen snapshot changed')
    if snapshot['dataset_sha256']!=digest(DATA/'dataset-v1/manifest.json'): raise ValueError('Dataset changed')
    pool=items(); seen=set()
    for row in snapshot['items']:
        source=pool.get(row['item_id'])
        if not source or source['split']!='train' or row['split']!='train': raise ValueError('Holdout leakage')
        if row['item_id'] in seen: raise ValueError('Duplicate training source')
        seen.add(row['item_id'])
        with db() as c:
            historical=c.execute('SELECT payload FROM review_history WHERE round_id=? AND item_id=? AND version=?',(row['review_round'],row['item_id'],row['review_version'])).fetchone()
        if not historical or hashlib.sha256(historical[0].encode()).hexdigest()!=row['review_sha256']: raise ValueError('Frozen target has no matching human review')
        review=json.loads(historical[0])
        if review['accepted']=='neither': raise ValueError('Rejected target in snapshot')
        variant=review['preferred'] if review['preferred'] in ('a','b') else 'a'
        expected=review.get('master_hashes',{}).get(variant) or review['candidate_hashes'][variant]
        if row['target_sha256']!=expected: raise ValueError('Target differs from reviewed image')
        if source['sha256']!=row['source_sha256']: raise ValueError('Source identity mismatch')
        for key in ('source','target'):
            if digest(DATA/row[key+'_path'])!=row[key+'_sha256']: raise ValueError(f'{key} bytes changed')
    if len(seen)<20: raise ValueError('At least 20 approved distinct training inputs are required')
    return snapshot
def train(args):
    snapshot=validate_snapshot(args.reference)
    import torch
    import torch.nn.functional as F
    from PIL import Image,ImageOps
    import numpy as np
    from diffusers import StableDiffusionXLImg2ImgPipeline,DDPMScheduler
    from diffusers.utils import convert_state_dict_to_diffusers
    from peft import LoraConfig,get_peft_model_state_dict
    torch.manual_seed(20261001); rng=random.Random(20261001)
    model=json.loads((DATA/'model.json').read_text())
    adapter_dir=DATA/'adapters'/args.job
    adapter_dir.mkdir(parents=True,exist_ok=False)
    # Each iteration retrains a fresh adapter against the same pinned base using
    # the latest cumulative approved pool. This avoids accidentally stacking LoRAs.
    config=dict(snapshot=args.reference,snapshot_sha256=digest(DATA/'snapshots'/f'{args.reference}.json'),
        base=model,rank=8,learning_rate=5e-5,epochs=getattr(args,'epochs',4),gradient_accumulation=4,resolution=1024,
        objective=snapshot['objective'],created=now(),seed=20261001,initialized_from='pinned base; fresh LoRA')
    atomic(adapter_dir/'training.json',config)
    pipe=StableDiffusionXLImg2ImgPipeline.from_pretrained(model['path'],torch_dtype=torch.bfloat16,
        variant='fp16',use_safetensors=True,local_files_only=True,add_watermarker=False)
    unet=pipe.unet; unet.requires_grad_(False)
    pipe.vae.requires_grad_(False); pipe.vae.to('cuda',dtype=torch.float32); pipe.enable_vae_tiling()
    for encoder in (pipe.text_encoder,pipe.text_encoder_2): encoder.requires_grad_(False); encoder.to('cuda')
    rows=[]
    for index,row in enumerate(snapshot['items']):
        image=ImageOps.pad(Image.open(DATA/row['target_path']).convert('RGB'),(1024,1024),
                           color='white',method=Image.Resampling.LANCZOS)
        tensor=torch.from_numpy(np.asarray(image).copy()).permute(2,0,1).unsqueeze(0).float().to('cuda')/127.5-1
        with torch.no_grad():
            posterior=pipe.vae.encode(tensor).latent_dist
            # Cache posterior parameters, sample fresh target latents each step.
            mean=posterior.mean.cpu(); std=posterior.std.cpu()
            prompt,_,pooled,_=pipe.encode_prompt(row['caption'],device=torch.device('cuda'),do_classifier_free_guidance=False)
        rows.append((mean,std,prompt.detach().cpu(),pooled.detach().cpu()))
        set_job(args.job,message=f"Encoding approved targets {index+1}/{len(snapshot['items'])}")
    scaling=pipe.vae.config.scaling_factor
    scheduler=DDPMScheduler.from_pretrained(model['path'],subfolder='scheduler',local_files_only=True)
    pipe.vae.to('cpu'); pipe.text_encoder.to('cpu'); pipe.text_encoder_2.to('cpu')
    del pipe; gc.collect(); torch.cuda.empty_cache()
    unet.add_adapter(LoraConfig(r=8,lora_alpha=8,init_lora_weights='gaussian',target_modules=['to_q','to_k','to_v','to_out.0']))
    for param in unet.parameters():
        if param.requires_grad: param.data=param.data.float()
    unet.to('cuda'); unet.enable_gradient_checkpointing(); unet.train()
    params=[p for p in unet.parameters() if p.requires_grad]
    optimizer=torch.optim.AdamW(params,lr=config['learning_rate'],weight_decay=0.01)
    steps_per_epoch=math.ceil(len(rows)/config['gradient_accumulation'])
    total=config['epochs']*steps_per_epoch; completed=0
    set_job(args.job,total=total,progress=0,message='Training reviewed targets')
    history=[]
    for epoch in range(config['epochs']):
        order=list(range(len(rows))); rng.shuffle(order)
        for start in range(0,len(order),config['gradient_accumulation']):
            batch=order[start:start+config['gradient_accumulation']]
            optimizer.zero_grad(set_to_none=True); loss_sum=0
            for index in batch:
                mean,std,prompt,pooled=rows[index]
                latents=(mean+std*torch.randn_like(std)).to('cuda',dtype=torch.bfloat16)*scaling
                noise=torch.randn_like(latents)
                timestep=torch.randint(0,scheduler.config.num_train_timesteps,(1,),device='cuda').long()
                noisy=scheduler.add_noise(latents,noise,timestep)
                time_ids=torch.tensor([[1024,1024,0,0,1024,1024]],device='cuda',dtype=torch.bfloat16)
                with torch.autocast('cuda',dtype=torch.bfloat16):
                    predicted=unet(noisy,timestep,encoder_hidden_states=prompt.to('cuda'),added_cond_kwargs={
                        'text_embeds':pooled.to('cuda'),'time_ids':time_ids},return_dict=False)[0]
                    if scheduler.config.prediction_type=='epsilon': target=noise
                    elif scheduler.config.prediction_type=='v_prediction': target=scheduler.get_velocity(latents,noise,timestep)
                    else: raise ValueError('Unsupported prediction type')
                    loss=F.mse_loss(predicted.float(),target.float())
                if not torch.isfinite(loss): raise RuntimeError('Non-finite training loss')
                (loss/len(batch)).backward(); loss_sum+=loss.item()/len(batch)
            torch.nn.utils.clip_grad_norm_(params,1.0); optimizer.step(); completed+=1
            history.append(dict(step=completed,epoch=epoch+1,loss=loss_sum))
            atomic(adapter_dir/'metrics.json',history)
            set_job(args.job,progress=completed,message=f'epoch {epoch+1}/4 loss {loss_sum:.5f}')
    state=convert_state_dict_to_diffusers(get_peft_model_state_dict(unet))
    StableDiffusionXLImg2ImgPipeline.save_lora_weights(str(adapter_dir),unet_lora_layers=state,safe_serialization=True)
    weights=adapter_dir/'pytorch_lora_weights.safetensors'
    atomic(adapter_dir/'result.json',dict(adapter_sha256=digest(weights),snapshot=args.reference,
          count=len(rows),steps=completed,finished=now(),validation_status='not_evaluated',
          note='Training completed. Evaluate a new round on fixed validation sources before choosing this adapter.'))
