from __future__ import annotations

import gc
import json
import os
from pathlib import Path
import threading
import time
from .contracts import RegionRequest, Grid
from .grid import prepare, prepare_context, compose, digest, png_data, grid_image
from .model import MODEL_ID, MODEL_REVISION, MODEL_PATH, SCHEMA, configure_environment, sha256_file


class RegionEngine:
    def __init__(self):
        self.pipeline = None
        self.lock = threading.Lock()
        self.last_metrics = None
        self.adapter_manifest = None

    def health(self):
        ready = (MODEL_PATH / "local-manifest.json").is_file()
        return {"status": "loaded" if self.pipeline else "cached" if ready else "missing-model",
                "schemaVersion": SCHEMA, "model": MODEL_ID, "revision": MODEL_REVISION,
                "inputModes": ["grid-context"], "stages": ["surroundings", "masked-fill"], "combinedReferenceSupported": False,
                "adapterConfigured": bool(os.environ.get("SDXL_REGION_LORA")), "metrics": self.last_metrics}

    def load(self):
        if self.pipeline is not None:
            return self.pipeline
        configure_environment()
        if not (MODEL_PATH / "local-manifest.json").is_file():
            raise RuntimeError("SDXL checkpoint missing; run pnpm sdxl:setup")
        import torch
        from diffusers import StableDiffusionXLInpaintPipeline
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is required for this local experimental service")
        pipe = StableDiffusionXLInpaintPipeline.from_pretrained(
            str(MODEL_PATH), torch_dtype=torch.float16, variant="fp16",
            use_safetensors=True, local_files_only=True, add_watermarker=False,
        )
        if pipe.unet.config.in_channels != 9:
            raise RuntimeError("expected a pretrained 9-channel SDXL inpainting UNet")
        pipe.unet.requires_grad_(False)
        pipe.vae.requires_grad_(False)
        pipe.text_encoder.requires_grad_(False)
        pipe.text_encoder_2.requires_grad_(False)
        lora = os.environ.get("SDXL_REGION_LORA")
        if lora:
            path = Path(lora).resolve()
            meta = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))
            if meta.get("baseModel") != MODEL_ID or meta.get("baseRevision") != MODEL_REVISION:
                raise RuntimeError("adapter base model/revision mismatch")
            if meta.get("sha256") != sha256_file(path):
                raise RuntimeError("adapter checksum mismatch")
            pipe.load_lora_weights(str(path.parent), weight_name=path.name, adapter_name="region", local_files_only=True)
            pipe.disable_lora()
            self.adapter_manifest = meta
        offload = os.environ.get("SDXL_REGION_OFFLOAD", "model")
        if offload == "sequential":
            pipe.enable_sequential_cpu_offload()
        elif offload == "model":
            pipe.enable_model_cpu_offload()
        else:
            raise RuntimeError("SDXL_REGION_OFFLOAD must be model or sequential")
        pipe.enable_vae_tiling()
        pipe.enable_vae_slicing()
        pipe.set_progress_bar_config(disable=False)
        self.pipeline = pipe
        return pipe

    def generate(self, request: RegionRequest):
        if not self.lock.acquire(blocking=False):
            raise BlockingIOError("SDXL is busy; retry after the active request finishes")
        try:
            started = time.perf_counter()
            context = prepare_context(request)
            if request.contextSha256 != context["contextSha256"]:
                raise ValueError("先确认周边；上下文未确认或已经变化，请重新完成第一步")
            canvas, mask, transform = prepare(request)
            before_hash = digest(request.currentGrid.model_dump())
            load_started = time.perf_counter()
            pipe = self.load()
            load_ms = (time.perf_counter() - load_started) * 1000
            if request.adapter == "configured":
                if self.adapter_manifest is None:
                    raise ValueError("no LoRA is configured on the server")
                pipe.enable_lora()
            elif self.adapter_manifest:
                pipe.disable_lora()
            import torch
            torch.cuda.reset_peak_memory_stats()
            inference_started = time.perf_counter()
            effective_prompt = request.prompt + ", coherent pixel art, complete the masked area, match the surrounding palette and lighting, solid flat colors, continuous local shapes"
            attempts = []
            for attempt in range(request.maxAttempts):
                seed = (request.seed + attempt) % 2**32
                with torch.inference_mode():
                    generated = pipe(
                        prompt=effective_prompt, negative_prompt=request.negativePrompt,
                        image=canvas, mask_image=mask, width=request.workingSize, height=request.workingSize,
                        num_inference_steps=request.steps, strength=request.strength,
                        guidance_scale=request.guidanceScale,
                        generator=torch.Generator(device="cpu").manual_seed(seed),
                    ).images[0]
                result = compose(request, generated, transform)
                attempts.append({"seed": seed, "decision": result["decision"], "validation": result["validation"],
                                 "diagnostics": result["diagnostics"], "generatedPreview": png_data(generated)})
                if result["decision"] == "candidate": break
            inference_ms = (time.perf_counter() - inference_started) * 1000
            self.last_metrics = {"loadMs": round(load_ms), "inferenceMs": round(inference_ms),
                                 "totalMs": round((time.perf_counter() - started) * 1000),
                                 "peakAllocatedMiB": round(torch.cuda.max_memory_allocated() / 2**20),
                                 "peakReservedMiB": round(torch.cuda.max_memory_reserved() / 2**20)}
            # Model offload frees tensors; release idle allocator blocks as well
            # so other local vision services can use the GPU between requests.
            torch.cuda.empty_cache()
            return {"schemaVersion": SCHEMA, "beforeSha256": before_hash, "requestSha256": digest(request.model_dump()),
                    **result, "contextSha256": context["contextSha256"], "stages": ["surroundings", "masked-fill"],
                    "attempts": attempts, "transform": transform, "metrics": self.last_metrics,
                    "preview": {"input": png_data(canvas), "mask": png_data(mask), "generated": png_data(generated),
                                "grid": png_data(grid_image(Grid.model_validate(result["grid"]))) if result["grid"] else None},
                    "provenance": {"model": MODEL_ID, "revision": MODEL_REVISION, "inputMode": request.inputMode,
                                   "workingSize": request.workingSize, "steps": request.steps,
                                   "strength": request.strength, "guidanceScale": request.guidanceScale,
                                   "seed": seed, "initialSeed": request.seed, "prompt": request.prompt, "effectivePrompt": effective_prompt, "negativePrompt": request.negativePrompt,
                                   "conditioning": "full-grid-with-skin-prefill", "skinColorId": context["skinColorId"], "task": request.task,
                                   "fillPolicy": request.fillPolicy, "maxAttempts": request.maxAttempts,
                                   "adapter": self.adapter_manifest if request.adapter == "configured" else None,
                                   "offload": os.environ.get("SDXL_REGION_OFFLOAD", "model")},
                    "warnings": ["Experimental candidate; human acceptance required.",
                                 "Every editable cell is filled; outside and locked cells are copied exactly.",
                                 "Structural checks do not prove a correct eye or expression; human review is required."]}
        except Exception as error:
            if self.pipeline is not None and not isinstance(error, ValueError):
                # A failed offload hook must not leave a half-loaded pipeline for the next call.
                self.pipeline = None
                self.adapter_manifest = None
                gc.collect()
                import torch
                torch.cuda.empty_cache()
            raise
        finally:
            self.lock.release()
