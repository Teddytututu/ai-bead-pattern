"""Isolate VAE grid round-trip loss on an original 64x48 synthetic fixture."""
import argparse
import json
from pathlib import Path
import time
from .contracts import RegionRequest
from .grid import prepare, render_grid, compose, grid_image
from .model import MODEL_PATH, MODEL_ID, MODEL_REVISION, configure_environment


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    configure_environment()
    import torch
    import numpy as np
    from diffusers import AutoencoderKL
    from PIL import Image
    # SDXL's original VAE is evaluated in float32, matching its force_upcast intent.
    vae = AutoencoderKL.from_pretrained(str(MODEL_PATH), subfolder="vae", variant="fp16", torch_dtype=torch.float32,
                                      use_safetensors=True, local_files_only=True).to("cuda")
    vae.requires_grad_(False); vae.enable_tiling(); vae.enable_slicing()
    cells = [0 if 7 < i % 64 < 56 and 5 < i // 64 < 43 else -1 for i in range(64 * 48)]
    for y in range(20, 24):
        for x in [*range(20, 25), *range(39, 44)]: cells[y * 64 + x] = 1
    highlight = 21 * 64 + 21
    cells[highlight] = 2
    rows = []
    for size in [512, 1024]:
        request = RegionRequest.model_validate({"schemaVersion": "region-generation-v3", "task": "harmonize", "currentGrid": {"width": 64, "height": 48,
            "paletteId": "original-vae-diagnostic", "paletteVersion": "1", "colors": [{"id": "skin", "rgb": [237, 190, 151]},
            {"id": "dark", "rgb": [38, 48, 64]}, {"id": "white-bead", "rgb": [255, 255, 245]}], "cells": cells},
            "editMask": [c >= 0 and i != 6 * 64 + 8 for i,c in enumerate(cells)], "lockedMask": [False] * len(cells), "prompt": "VAE diagnostic", "workingSize": size, "maximumColors": 3})
        canvas, transform = render_grid(request.currentGrid, size)
        image = torch.from_numpy(np.array(canvas).copy()).permute(2, 0, 1).unsqueeze(0).to("cuda", dtype=torch.float32) / 127.5 - 1
        torch.cuda.reset_peak_memory_stats(); started = time.perf_counter()
        with torch.inference_mode():
            latent = vae.encode(image).latent_dist.mode()
            decoded = vae.decode(latent).sample
        pixels = ((decoded[0].permute(1, 2, 0).clamp(-1, 1) + 1) * 127.5).round().to(torch.uint8).cpu().numpy()
        restored = Image.fromarray(pixels)
        result = compose(request, restored, transform)
        if result["grid"] is None:
            assert result["validation"]["reasons"] == ["没有产生格级修改，不能作为修复候选"]
            result["grid"] = request.currentGrid.model_dump()  # Only a VAE round-trip diagnostic.
        canvas.save(args.output / f"{size}-input.png")
        restored.save(args.output / f"{size}-decoded.png")
        grid_image(request.currentGrid).save(args.output / f"{size}-before-grid.png")
        grid_image(type(request.currentGrid).model_validate(result["grid"])).save(args.output / f"{size}-after-grid.png")
        rows.append({"workingSize": size, "gridSize": [64, 48], "changedOccupiedCells": len(result["changedCells"]),
            "singleWhiteHighlightPreserved": result["grid"]["cells"][highlight] == 2,
            "emptyCellsPreservedByComposer": all(result["grid"]["cells"][i] == -1 for i, c in enumerate(cells) if c == -1),
            "rgbMeanAbsoluteError": round(float(np.abs(pixels.astype(float) - np.array(canvas).astype(float)).mean()), 3),
            "elapsedMs": round((time.perf_counter() - started) * 1000), "peakAllocatedMiB": round(torch.cuda.max_memory_allocated() / 2**20)})
        del image, latent, decoded
        torch.cuda.empty_cache()
    report = {"status": "completed-synthetic-vae-diagnostic-not-quality", "model": MODEL_ID, "revision": MODEL_REVISION, "results": rows}
    (args.output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report), flush=True)


if __name__ == "__main__": main()
