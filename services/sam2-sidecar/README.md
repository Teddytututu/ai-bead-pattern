# SAM 2.1 prompted segmentation sidecar

This local Provider turns a coarse subject lasso, box, or positive/negative clicks into a selected-instance mask for Pattern Core.

The same service exposes `grounded-sam2-local` for automatic multi-pet discovery. It follows the official Grounded-SAM-2 image pipeline: GroundingDINO detects text-grounded boxes, class-agnostic NMS removes overlapping generic/specific labels, and SAM 2.1 segments every retained box in one `multimask_output=False` call. Each instance keeps its category, detection score, SAM predicted IoU, stability score, source-sized RLE mask, and `${instanceId}:subject` semantic region. The analysis subject mask and crop cover the union of all instances.

The runtime is pinned to:

- Meta SAM 2 source commit `2b90b9f5ceec907a1c18123530e92e794ad901a4`
- `facebook/sam2.1-hiera-small` weights at Hugging Face commit `ee5bba1d82bb8749febdf90f45e84b687142ba03`
- Transformers `5.16.1`, peeled source commit `93c8b7b485963a10800c91f55304db6be211c2bd`
- Apache-2.0 code and checkpoint license
- GroundingDINO source commit `856dde20aee659246248e20734ef9ba5214f5e44`
- Grounded-SAM-2 pipeline commit `dd4c5141b75e4838dd486c64f773c43b4db3a07b`
- `IDEA-Research/grounding-dino-tiny` weights at commit `a2bb814dd30d776dcf7e30523b00659f4f141c71`

The lasso planner derives a bounding box, three high-clearance interior positive points, and four exterior negative points. Explicit clicks remain in the prompt. SAM 2 returns multiple masks; selection combines predicted IoU, mask stability, prompt agreement, and lasso containment. The response carries compact COCO uncompressed RLE, `subjectMaskEvidence`, an automatic crop, and structured instance diagnostics.

Automatic batches discard individual masks whose thresholded area is empty and
continue with the remaining detections. A fully empty batch returns the service
error before subject-mask aggregation.

```powershell
pnpm sam2:setup
pnpm sam2:test
pnpm sam2:start
pnpm sam2:grounded-smoke
```

The service listens on `127.0.0.1:7103`. Connect it to the demo API with:

```powershell
$env:SAM2_ENDPOINT = 'http://127.0.0.1:7103'
pnpm demo:ai
```

`SAM2_DEVICE=cpu` selects CPU inference. CUDA is selected automatically when available and remains the recommended route. Model tensors load lazily on the first inference. `pnpm sam2:smoke` performs one real synthetic-image inference and reports IoU, stability, crop, device, and latency.

Automatic detection defaults to `a cat. a dog. a rabbit. a pet.`. A `grounded-sam2-local` request can provide labels only through `instancePrompt.labels`; Transformers 5.16.1 lowercases the candidates, joins them with periods, and extracts `text_labels` after detection. `GROUNDING_DINO_BOX_THRESHOLD` and `GROUNDING_DINO_TEXT_THRESHOLD` tune the default `0.35` and `0.25` thresholds. NMS uses IoU `0.7` and retains at most 16 instances.

`GET /health/grounded` reports the combined model identity. `pnpm sam2:grounded-smoke` runs the pinned models on GroundingDINO's official five-cat `cats.png` at the reviewed source revision and verifies five source-sized instance masks.

`pnpm sam2:setup` installs the environment and prefetches the four pinned model files. This keeps checkpoint download outside the Gateway request timeout. `pnpm sam2:prefetch` repeats the cache check without rebuilding the environment.

Runtime inference reads the pinned cache by default. Set `SAM2_ALLOW_RUNTIME_DOWNLOAD=1` only for a deployment that intentionally permits an absent cache to download during a request. The backend serializes model calls inside one process to keep CUDA memory bounded.

The Gateway owns request timeout and caller cancellation. A client disconnect stops response delivery; an already-running tensor operation completes inside the sidecar worker thread before its memory is reused.
