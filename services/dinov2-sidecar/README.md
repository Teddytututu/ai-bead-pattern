# DINOv2 ViT-S/14 Pair Sidecar

This local FastAPI provider compares a source image with one candidate by using the
pinned `facebook/dinov2-small` encoder. It emits CLS identity similarity and patch-token
correspondence for four views: global, subject, head, and critical local detail.

Model source: `facebookresearch/dinov2` at
`7764ea0f912e53c92e82eb78a2a1631e92725fc8` (Apache-2.0). Weights:
`facebook/dinov2-small` at `ed25f3a31f01632728cabb09d1542f84ab7b0056`
(Apache-2.0).

```powershell
uv sync --project services/dinov2-sidecar --python 3.11
uv run --project services/dinov2-sidecar --python 3.11 python -m dinov2_sidecar.prefetch
uv run --project services/dinov2-sidecar --python 3.11 python -m unittest discover -s services/dinov2-sidecar/tests -v
uv run --project services/dinov2-sidecar --python 3.11 python -m dinov2_sidecar
```

The server listens on `127.0.0.1:7105`. `DINOV2_DEVICE=cpu` forces the CPU route.
`DINOV2_ALLOW_DOWNLOAD=1` permits a request to fetch absent pinned weights; the normal
setup path uses the explicit prefetch command. `/health` reports `unavailable` while the
pinned checkpoint is absent, `degraded` while cached and cold, and `ready` after loading.

Every view preserves aspect ratio and uses white padding on a 224 x 224 canvas. The
canvas is a 14-pixel patch multiple, so regional geometry reaches the ViT without image
stretching. Raw embeddings remain inside the sidecar; only compact pair metrics leave it.
