# 真实模型部署记录

本页记录一次在当前 Linux CPU 环境完成的真实权重核验。记录中的 smoke 均调用真实模型权重；fixture 与 fake backend 属于独立测试层。

## 环境

- 日期：2026-09-05
- 设备：CPU；`nvidia-smi` 未返回可用 CUDA 设备
- 工作区：`/workspace/scratch/0db1a0211aa4/ai-bead-pattern`
- Hugging Face 缓存：`/root/.cache/huggingface/hub`
- 代理兼容：当前环境同时提供 HTTP 与 SOCKS 代理。`huggingface_hub` 预取前使用 `env -u ALL_PROXY -u all_proxy`；正式部署应在 sidecar 依赖中加入 `socksio`，或配置纯 HTTP 代理。

## DINOv2 ViT-S/14

- 仓库：`facebook/dinov2-small`
- revision：`ed25f3a31f01632728cabb09d1542f84ab7b0056`
- 本地快照：`/root/.cache/huggingface/hub/models--facebook--dinov2-small/snapshots/ed25f3a31f01632728cabb09d1542f84ab7b0056`
- 权重大小：88,249,960 bytes
- `model.safetensors` SHA-256：`ae1e99fcefd534ed978cdeb8326f08030c96e28b7a81ffcbc98a857c84d14be1`
- 推理：CPU，真实 `dinov2_sidecar.smoke`
- 结果：matching identity `1.0000`；changed identity `0.9780`；matching critical retention `1.0000`；changed critical retention `0.9614`；单次 smoke 约 `8.0–11.3 s`

命令：

```bash
env -u ALL_PROXY -u all_proxy \
  uv run --project services/dinov2-sidecar --python 3.11 \
  python -m dinov2_sidecar.prefetch
HF_HUB_OFFLINE=1 DINOV2_DEVICE=cpu \
  uv run --project services/dinov2-sidecar --python 3.11 \
  python -m dinov2_sidecar.smoke
```

## RTMPose-M AP-10K

- 权重：`rtmpose-m_simcc-ap10k_pt-aic-coco_210e-256x256-7a041aa1_20230206/end2end.onnx`
- 本地路径：`work/models/rtmpose/extracted/20230831/rtmpose_onnx/rtmpose-m_simcc-ap10k_pt-aic-coco_210e-256x256-7a041aa1_20230206/end2end.onnx`
- SHA-256：`1cfd1c86e0d9e5d5f95178bcd95ee9a4e8386a624cd3c57519f27ff58cac7f28`
- 推理：ONNX Runtime CPU
- 结果：confidence `0.677927`；observed landmarks `9`；inference `54–76 ms`

命令：

```bash
uv run --project services/mmpose-sidecar --python 3.11 \
  python -m mmpose_sidecar.prefetch
MMPOSE_DEVICE=cpu \
  uv run --project services/mmpose-sidecar --python 3.11 \
  python -m mmpose_sidecar.smoke
```

## SAM 2.1 Hiera Small

- 权重 revision：`ee5bba1d82bb8749febdf90f45e84b687142ba03`
- 本地快照：`/root/.cache/huggingface/hub/models--facebook--sam2.1-hiera-small/snapshots/ee5bba1d82bb8749febdf90f45e84b687142ba03`
- `model.safetensors`：184,305,280 bytes；SHA-256 `0a4067b11ce1e23d5229203f11c718a823060d15a4b23fa2372a7d4b77cbbc60`
- 推理：真实 SAM 2.1 CPU smoke
- 结果：IoU `0.9629`；stability `0.991`；prompt agreement `0.9854`；lasso containment `1.0`；单次约 `6.84 s`

## GroundingDINO Tiny + SAM 2.1

- GroundingDINO 权重 revision：`a2bb814dd30d776dcf7e30523b00659f4f141c71`
- `model.safetensors`：689,359,096 bytes；SHA-256 `1a2412ef99bd74bcd3c2a246fa1e48581f8889a1300c9051974741314fc042f3`
- CPU grounded smoke：官方 five-cat 图片识别 5 个实例
- detection score：`0.7683–0.8015`
- predicted IoU：`0.9577–0.9772`
- stability：`0.9897–0.9947`
- detector 约 `64.7 s`；SAM 约 `11.0 s`；总计约 `75.7 s`

首次预取需要安装 `socksio` 才能兼容当前 SOCKS 代理。正式 sidecar 依赖清单仍需把它固定下来，并把 grounded 首次加载放到启动 warmup 或单独延长请求预算。

## BiRefNet-general-lite

- rembg：`2.0.81`
- 下载地址：`https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx`
- 本地核验路径：`work/models/birefnet/birefnet-general-lite.onnx`
- 文件大小：224,005,088 bytes
- SHA-256：`5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333`
- 推理：临时 CPU rembg 环境，真实 `birefnet-general-lite` session
- 输入：`work/real-pet-benchmark/images/Birman_1.jpg`
- 输出：`work/birefnet-smoke.png`
- 端到端进程时间：约 `42.0 s`（含 session 初始化）；输出 PNG `138,732 bytes`

当前仓库仍通过 rembg HTTP adapter 接入 BiRefNet，独立 rembg sidecar 与启动期权重预取属于部署机工作。模型文件与 smoke 输出保存在 `work/`，适合本机复核，发布包应按部署策略重新放置并复核 hash。

## 当前状态

| 模型 | 真实权重 | 真实 smoke | 设备 | 状态 |
|---|---:|---:|---|---|
| DINOv2 Small | 已缓存 | 已通过 | CPU | ready |
| RTMPose-M AP-10K | 已缓存 | 已通过 | CPU | ready |
| SAM 2.1 Small | 已缓存 | 已通过 | CPU | ready |
| GroundingDINO Tiny + SAM 2.1 | 已缓存 | 已通过 | CPU | ready，首轮较慢 |
| BiRefNet-general-lite | 已下载 | 已通过 | CPU | ready，需部署 rembg HTTP 服务 |
