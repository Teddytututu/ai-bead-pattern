"""One genuine SDXL LoRA optimizer step on original synthetic artwork only.

This tests training mechanics; it is deliberately not a dataset trainer.
"""
import argparse
import gc
import hashlib
import json
from pathlib import Path
import time
from .fixtures import example_request
from .grid import prepare, render_grid
from .model import MODEL_ID, MODEL_REVISION, MODEL_PATH, configure_environment, sha256_file


def frozen_digest(module):
    digest = hashlib.sha256()
    for name, parameter in module.named_parameters():
        if "lora_" not in name:
            digest.update(name.encode())
            digest.update(parameter.detach().contiguous().view(__import__("torch").uint8).cpu().numpy().tobytes())
    return digest.hexdigest()


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--size", type=int, choices=[256,512], default=512)
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=False)
    configure_environment()
    import torch
    import torch.nn.functional as F
    import numpy as np
    from diffusers import StableDiffusionXLInpaintPipeline, DDPMScheduler
    from diffusers.utils import convert_state_dict_to_diffusers
    from peft import LoraConfig
    from peft.utils import get_peft_model_state_dict
    started=time.perf_counter()
    try:
        torch.manual_seed(123)
        pipe=StableDiffusionXLInpaintPipeline.from_pretrained(str(MODEL_PATH),variant="fp16",torch_dtype=torch.bfloat16,
                                                            local_files_only=True,use_safetensors=True,add_watermarker=False)
        for part in (pipe.unet,pipe.vae,pipe.text_encoder,pipe.text_encoder_2):
            part.requires_grad_(False)
        pipe.enable_model_cpu_offload()
        request,clean=example_request()
        clean_cells=[request.currentGrid.colors.index(next(c for c in request.currentGrid.colors if tuple(c.rgb)==rgb)) for rgb in clean.getdata()]
        clean_request=request.model_copy(deep=True)
        clean_request.currentGrid.cells=clean_cells
        _,mask,_=prepare(clean_request)
        canvas,_=render_grid(clean_request.currentGrid,clean_request.workingSize)
        if args.size==256:
            from PIL import Image
            canvas=canvas.resize((256,256),Image.Resampling.NEAREST)
            mask=mask.resize((256,256),Image.Resampling.NEAREST)
        with torch.no_grad():
            embeds,_,pooled,_=pipe.encode_prompt(request.prompt,device=torch.device("cuda"),num_images_per_prompt=1,do_classifier_free_guidance=False)
            embeds,pooled=embeds.cpu(),pooled.cpu()
            pixels=torch.tensor(np.array(canvas).copy()).permute(2,0,1).unsqueeze(0).to("cuda",dtype=torch.bfloat16)/127.5-1
            mask_tensor=torch.tensor(np.array(mask).copy()).unsqueeze(0).unsqueeze(0).to("cuda",dtype=torch.bfloat16)/255
            latent=pipe.vae.encode(pixels).latent_dist.mode()*pipe.vae.config.scaling_factor
            masked=pipe.vae.encode(pixels*(1-mask_tensor)).latent_dist.mode()*pipe.vae.config.scaling_factor
            latent,masked,mask_tensor=latent.cpu(),masked.cpu(),mask_tensor.cpu()
        pipe.maybe_free_model_hooks()
        pipe.remove_all_hooks()
        pipe.text_encoder.to("cpu")
        pipe.text_encoder_2.to("cpu")
        pipe.vae.to("cpu")
        del pixels
        gc.collect()
        torch.cuda.empty_cache()
        unet=pipe.unet.to("cuda",dtype=torch.bfloat16)
        unet.add_adapter(LoraConfig(r=4,lora_alpha=4,init_lora_weights="gaussian",target_modules=["to_q","to_k","to_v","to_out.0"]))
        unet.enable_gradient_checkpointing()
        trainable=[(n,p) for n,p in unet.named_parameters() if p.requires_grad]
        assert trainable and all("lora_" in n for n,p in trainable)
        before=frozen_digest(unet)
        scheduler=DDPMScheduler.from_pretrained(str(MODEL_PATH),subfolder="scheduler",local_files_only=True)
        latent,masked=latent.cuda(),masked.cuda()
        mask_latent=F.interpolate(mask_tensor.cuda(),size=latent.shape[-2:],mode="nearest")
        noise=torch.randn_like(latent)
        timestep=torch.tensor([500],device="cuda",dtype=torch.long)
        noisy=scheduler.add_noise(latent,noise,timestep)
        inputs=torch.cat([noisy,mask_latent,masked],dim=1)
        conditions={"text_embeds":pooled.cuda(),"time_ids":torch.tensor([[args.size,args.size,0,0,args.size,args.size]],device="cuda",dtype=torch.bfloat16)}
        embeds=embeds.cuda()
        optimizer=torch.optim.AdamW([p for n,p in trainable],lr=1e-4)
        torch.cuda.reset_peak_memory_stats()
        unet.train()
        step_start=time.perf_counter()
        prediction=unet(inputs,timestep,encoder_hidden_states=embeds,added_cond_kwargs=conditions).sample
        target=noise if scheduler.config.prediction_type=="epsilon" else scheduler.get_velocity(latent,noise,timestep)
        # Give the region useful weight while retaining a small surrounding-context loss.
        weights=0.1+0.9*mask_latent.float()
        loss=((prediction.float()-target.float()).square()*weights).mean()
        assert torch.isfinite(loss)
        loss.backward()
        grads=[p.grad for _,p in trainable if p.grad is not None]
        assert grads and all(torch.isfinite(g).all() for g in grads)
        grad_norm=float(torch.nn.utils.clip_grad_norm_([p for _,p in trainable],1.0))
        assert grad_norm>0
        optimizer.step()
        optimizer.zero_grad(set_to_none=True)
        step_ms=round((time.perf_counter()-step_start)*1000)
        after=frozen_digest(unet)
        assert before==after, "frozen base weights changed"
        peak=round(torch.cuda.max_memory_allocated()/2**20)
        del prediction,loss,optimizer,grads
        state=convert_state_dict_to_diffusers(get_peft_model_state_dict(unet))
        name="diagnostic-lora.safetensors"
        StableDiffusionXLInpaintPipeline.save_lora_weights(str(args.output),unet_lora_layers=state,weight_name=name,safe_serialization=True)
        unet.eval()
        with torch.no_grad():
            expected=unet(inputs,timestep,encoder_hidden_states=embeds,added_cond_kwargs=conditions).sample.cpu()
        pipe.delete_adapters("default")
        pipe.load_lora_weights(str(args.output),weight_name=name,adapter_name="reloaded",local_files_only=True)
        with torch.no_grad():
            actual=unet(inputs,timestep,encoder_hidden_states=embeds,added_cond_kwargs=conditions).sample.cpu()
        reload_error=float((expected.float()-actual.float()).abs().max())
        assert reload_error<0.02, f"LoRA reload mismatch: {reload_error}"
        metadata={"baseModel":MODEL_ID,"baseRevision":MODEL_REVISION,"sha256":sha256_file(args.output/name),
                  "purpose":"synthetic-diagnostic-only-not-quality-trained","rank":4,"steps":1}
        (args.output/"diagnostic-lora.json").write_text(json.dumps(metadata,indent=2),encoding="utf-8")
        report={"status":"passed-training-mechanics-not-quality","size":args.size,"rank":4,"optimizerSteps":1,
                "trainableParameters":sum(p.numel() for n,p in trainable),"trainableNames":[n for n,p in trainable],
                "frozenSha256Before":before,"frozenSha256After":after,"gradientNorm":grad_norm,
                "reloadMaxError":reload_error,"stepMs":step_ms,"peakAllocatedMiB":peak,"totalSeconds":round(time.perf_counter()-started)}
        (args.output/"report.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
        print(json.dumps({k:v for k,v in report.items() if k!="trainableNames"}),flush=True)
    except Exception as error:
        (args.output/"failure.json").write_text(json.dumps({"type":type(error).__name__,"message":str(error)},indent=2),encoding="utf-8")
        raise


if __name__=="__main__":
    main()
