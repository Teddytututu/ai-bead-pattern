from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps, UnidentifiedImageError

from .contracts import ProposalRequest, ProposalSourceFrame, deterministic_seeds

BASE_MODEL = "Onodofthenorth/SD_PixelArt_SpriteSheet_Generator"
BASE_REVISION = "8229c9b6e928103f0e657cfe6b14d902cb2101d6"
LCM_LORA = "latent-consistency/lcm-lora-sdv1-5"
LCM_REVISION = "cf2fced511dbe7e26c8d1d397e728fbab875db4b"


@dataclass(frozen=True)
class GeneratedProposal:
    proposal_id: str
    image: Image.Image
    confidence: float
    seed: int
    source_frame: ProposalSourceFrame


class InProcessPixelPipeline:
    """One-shot CUDA pipeline used inside an isolated worker process."""

    def __init__(self) -> None:
        requested_size = int(os.environ.get("PIXEL_PROPOSAL_RENDER_SIZE", "512"))
        self.render_size = max(512, min(768, requested_size // 64 * 64))
        self._pipeline: Any | None = None

    def _load_pipeline(self) -> Any:
        if self._pipeline is not None:
            return self._pipeline
        import torch
        from diffusers import LCMScheduler, StableDiffusionImg2ImgPipeline

        pipeline = StableDiffusionImg2ImgPipeline.from_pretrained(
            BASE_MODEL,
            revision=BASE_REVISION,
            torch_dtype=torch.float16,
            low_cpu_mem_usage=True,
            safety_checker=None,
            feature_extractor=None,
            requires_safety_checker=False,
        )
        pipeline.scheduler = LCMScheduler.from_config(pipeline.scheduler.config)
        pipeline.load_lora_weights(
            LCM_LORA,
            revision=LCM_REVISION,
            weight_name="pytorch_lora_weights.safetensors",
        )
        pipeline.fuse_lora()
        pipeline.enable_model_cpu_offload()
        pipeline.enable_vae_tiling()
        pipeline.enable_vae_slicing()
        pipeline.set_progress_bar_config(disable=True)
        self._pipeline = pipeline
        return pipeline

    @staticmethod
    def _decode_source(source: bytes) -> Image.Image:
        try:
            with Image.open(io.BytesIO(source)) as opened:
                image = ImageOps.exif_transpose(opened).convert("RGB")
        except (UnidentifiedImageError, OSError) as error:
            raise ValueError("uploaded image must be a readable PNG, JPEG, or WebP") from error
        if image.width < 32 or image.height < 32 or image.width > 2048 or image.height > 2048:
            raise ValueError("uploaded image dimensions must stay within 32..2048")
        return image

    def _prepare_canvas(self, image: Image.Image) -> tuple[Image.Image, ProposalSourceFrame]:
        fitted = ImageOps.contain(
            image,
            (self.render_size, self.render_size),
            Image.Resampling.LANCZOS,
        )
        corners = [
            image.getpixel((0, 0)),
            image.getpixel((image.width - 1, 0)),
            image.getpixel((0, image.height - 1)),
            image.getpixel((image.width - 1, image.height - 1)),
        ]
        background = tuple(sorted(pixel[channel] for pixel in corners)[len(corners) // 2]
                           for channel in range(3))
        canvas = Image.new("RGB", (self.render_size, self.render_size), background)
        offset = (
            (self.render_size - fitted.width) // 2,
            (self.render_size - fitted.height) // 2,
        )
        canvas.paste(fitted, offset)
        return canvas, ProposalSourceFrame(
            fit="contain",
            source_width=image.width,
            source_height=image.height,
            x=float(offset[0]),
            y=float(offset[1]),
            width=float(fitted.width),
            height=float(fitted.height),
        )

    @staticmethod
    def _prompt(request: ProposalRequest) -> tuple[str, str]:
        protected = request.prompt or "preserve subject identity, silhouette, pose, and focal details"
        style = request.style_id or "faithful"
        if request.kind == "learned-pixelization":
            prompt = (
                "PixelartFSS, pixel art, same subject as the reference image, centered full subject, "
                f"{protected}, {style} style, clean readable silhouette, clustered pixels, "
                "limited flat colors, simple background"
            )
        else:
            prompt = (
                "PixelartFSS, pixel art character sprite based on the reference image, recognizable subject, "
                f"{protected}, {style} style, expressive silhouette, deliberate clusters, "
                "limited color palette, crafted game art"
            )
        negative = (
            "photorealistic, 3d render, blurry, smooth vector, text, watermark, extra eyes, "
            "duplicate face, deformed anatomy, cropped ears, noisy background"
        )
        return prompt, negative

    def generate_one(
        self,
        source: bytes,
        request: ProposalRequest,
        seed: int,
    ) -> tuple[GeneratedProposal, float]:
        source_image = self._decode_source(source)
        canvas, canvas_source_frame = self._prepare_canvas(source_image)
        prompt, negative_prompt = self._prompt(request)
        strength = 0.38 if request.kind == "learned-pixelization" else 0.65
        confidence = 0.88 if request.kind == "learned-pixelization" else 0.80
        started = time.perf_counter()
        pipeline = self._load_pipeline()
        import torch

        generator = torch.Generator(device="cpu").manual_seed(seed)
        generated = pipeline(
            prompt=prompt,
            negative_prompt=negative_prompt,
            image=canvas,
            strength=strength,
            num_inference_steps=6,
            guidance_scale=1.0,
            generator=generator,
        ).images[0].convert("RGBA")
        pixel_size = max(request.target_grid) * 2
        pixel_size = max(64, min(self.render_size // 4, pixel_size))
        generated = generated.resize((pixel_size, pixel_size), Image.Resampling.NEAREST)
        source_frame = canvas_source_frame.scaled(
            (self.render_size, self.render_size),
            generated.size,
        )
        source_frame = ProposalSourceFrame.from_wire(
            source_frame.to_wire(),
            proposal_size=generated.size,
            source_size=source_image.size,
        )
        elapsed_ms = (time.perf_counter() - started) * 1000
        return GeneratedProposal(
            proposal_id=f"{request.kind}-{seed}",
            image=generated,
            confidence=confidence,
            seed=seed,
            source_frame=source_frame,
        ), elapsed_ms


class PixelProposalEngine:
    """Stable API engine that isolates each CUDA seed in a disposable worker."""

    def __init__(self) -> None:
        self.last_inference_ms: float | None = None

    def health(self) -> tuple[str, str]:
        try:
            import diffusers
            import peft
            import torch
        except Exception as error:
            return "unavailable", f"runtime import failed: {error}"
        if not torch.cuda.is_available():
            return "unavailable", "CUDA runtime is unavailable"
        if self.last_inference_ms is None:
            return "degraded", (
                f"isolated worker loads on first request; diffusers {diffusers.__version__}; "
                f"peft {peft.__version__}"
            )
        return "ready", f"ready; last inference {self.last_inference_ms:.0f} ms"

    @staticmethod
    def _run_worker(source: bytes, request: ProposalRequest, seed: int) -> tuple[GeneratedProposal, float]:
        with tempfile.TemporaryDirectory(prefix="ai-bead-proposal-") as directory:
            root = Path(directory)
            source_path = root / "source.bin"
            request_path = root / "request.json"
            output_path = root / "result.json"
            source_path.write_bytes(source)
            request_path.write_text(json.dumps({
                "kind": request.kind,
                "targetGrid": list(request.target_grid),
                "paletteId": request.palette_id,
                "styleId": request.style_id,
                "prompt": request.prompt,
                "sourceId": request.source_id,
                "seed": seed,
            }), encoding="utf-8")
            environment = {
                **os.environ,
                "HF_HUB_DISABLE_SYMLINKS_WARNING": "1",
                "TOKENIZERS_PARALLELISM": "false",
            }
            completed = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "pixel_proposal_sidecar.worker",
                    str(source_path),
                    str(request_path),
                    str(output_path),
                ],
                capture_output=True,
                timeout=20 * 60,
                check=False,
                env=environment,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if not output_path.exists():
                detail = completed.stderr.decode("utf-8", errors="replace").strip()[-1000:]
                raise RuntimeError(
                    f"proposal worker exited with {completed.returncode}"
                    + ("" if not detail else f": {detail}")
                )
            result = json.loads(output_path.read_text(encoding="utf-8"))
            if "error" in result:
                raise RuntimeError(str(result["error"]))
            image_data = base64.b64decode(result["rgbaBase64"])
            width = int(result["width"])
            height = int(result["height"])
            image = Image.frombytes("RGBA", (width, height), image_data)
            source_frame = ProposalSourceFrame.from_wire(
                result.get("sourceFrame"),
                proposal_size=(width, height),
            )
            return GeneratedProposal(
                proposal_id=str(result["id"]),
                image=image,
                confidence=float(result["confidence"]),
                seed=int(result["seed"]),
                source_frame=source_frame,
            ), float(result["elapsedMs"])

    def generate(self, source: bytes, request: ProposalRequest) -> tuple[list[GeneratedProposal], float]:
        count = 1 if request.kind == "learned-pixelization" else 2
        source_key = source if request.source_id is None else request.source_id.encode("utf-8")
        seeds = deterministic_seeds(source_key, request.kind, count)
        proposals: list[GeneratedProposal] = []
        elapsed_ms = 0.0
        for index, seed in enumerate(seeds):
            proposal, worker_ms = self._run_worker(source, request, seed)
            if request.kind == "generative-proposal":
                proposal = GeneratedProposal(
                    proposal_id=proposal.proposal_id,
                    image=proposal.image,
                    confidence=round(max(0.5, proposal.confidence - index * 0.08), 4),
                    seed=proposal.seed,
                    source_frame=proposal.source_frame,
                )
            proposals.append(proposal)
            elapsed_ms += worker_ms
        self.last_inference_ms = elapsed_ms
        return proposals, elapsed_ms


def encode_raw_rgba(image: Image.Image) -> str:
    rgba = image.convert("RGBA")
    return base64.b64encode(rgba.tobytes()).decode("ascii")
