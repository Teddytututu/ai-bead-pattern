# RTMPose AP-10K keypoint sidecar

This local service maps one or more detected pet boxes to source-sized AP-10K
landmarks. Grounded-SAM-2 supplies stable `pet-01`, `pet-02`, ... instance
boxes. The sidecar batches every box into one ONNX Runtime call and returns 17
landmarks per instance: eyes, nose, neck, tail root, shoulders, front legs, hips,
and rear legs.

## Pinned method

- MMPose v1.3.2 source commit `5408bc76f5b848cf925a0d1857899011d8c5b497`
- AP-10K source commit `181b1a04755e4dc6fe5616ef7a88496f47bfe228`
- RTMPose-M AP-10K ONNX SHA-256
  `1cfd1c86e0d9e5d5f95178bcd95ee9a4e8386a624cd3c57519f27ff58cac7f28`
- `rtmlib` preprocessing reference commit
  `03a1693e59e4f7cd84582c0fb30459b3bf18ad42`
- Input tensor `N x 3 x 256 x 256`; SimCC outputs `N x 17 x 512`
- Bounding-box padding `1.25`; SimCC split ratio `2.0`

The archive metadata contains an older 192x256 pipeline entry. The actual ONNX
tensor metadata and the upstream model table both report 256x256, so runtime
validation follows the model tensor.

MMPose and the runtime glue use Apache-2.0. AP-10K data uses CC-BY-4.0; deployment
and redistributed model artifacts should retain the dataset attribution.

## Run

```powershell
pnpm mmpose:setup
pnpm mmpose:test
pnpm mmpose:smoke
$env:MMPOSE_ENDPOINT = 'http://127.0.0.1:7104'
pnpm mmpose:start
```

`MMPOSE_MODEL_PATH` selects an existing ONNX file. `MMPOSE_DEVICE=cuda` requests
the CUDA execution provider when the installed ONNX Runtime build exposes it;
the service records the provider selected for each inference.

`GET /health` reports `unavailable` until the pinned ONNX file exists,
`degraded` while the cached model awaits its first inference, and `ready` after
the ONNX Runtime session has loaded.
