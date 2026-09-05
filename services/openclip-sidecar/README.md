# OpenCLIP pair sidecar

本地 FastAPI 服务，用同一套 OpenCLIP 图像塔比较原图与拼豆候选。服务将两张图等比放入 `224x224` 白底画布，透明像素先合成白色，再计算：

- `semanticRetention`：归一化图像向量余弦相似度。
- `classDistributionRetention`：八类零样本分布的 Jensen-Shannon 保留率，每类融合照片、像素画和中性图像三种提示词。
- `petBirdMargin`：候选的猫/狗/兔最高概率与鸟概率之差。
- `confidence`：只描述原图类别证据的集中程度，由原图零样本分布的熵和峰值计算；候选质量完整保留在前三个评分里。

512 维图像向量只驻留 sidecar 的有界 LRU 缓存，HTTP 响应只包含三个紧凑指标。

## 固定模型

- `open_clip_torch==3.3.0`
- 架构：`ViT-B-32`
- 预训练标签：`laion2b_s34b_b79k`
- 权重：`laion/CLIP-ViT-B-32-laion2B-s34B-b79K@1a25a446712ba5ee05982a381eed697ef9b435cf`
- 代码与权重许可：MIT

权重通过 `huggingface_hub.hf_hub_download(..., revision=...)` 固定下载，再以本地 checkpoint 路径交给 OpenCLIP。该方式与 OpenCLIP `v3.3.0` README 给出的本地 checkpoint 加载方式一致。

## 命令

```powershell
pnpm openclip:setup
pnpm openclip:test
pnpm openclip:start
```

真实模型 smoke：

```powershell
pnpm openclip:smoke --reference work/full-evaluation/holdout/images/holdout-pet-03.png --candidate work/auto-eval/candidates-v15/holdout-pet-03/B-identity-48.png --candidate-id holdout-pet-03-B-identity-48
```

服务监听 `127.0.0.1:7102`。可用 `OPENCLIP_DEVICE=cpu|cuda` 与 `OPENCLIP_PRECISION=fp32|fp16` 固定执行设备和精度。

## Holdout 实测

2026-09-02 在 RTX 4060 Laptop GPU、FP32、同一常驻进程上完成 `holdout-pet-03` 对照：

| 候选 | semanticRetention | classDistributionRetention | petBirdMargin | confidence |
| --- | ---: | ---: | ---: | ---: |
| 原图自检 | 1.0000 | 1.0000 | 0.9996 | 0.9989 |
| A-baseline-48 | 0.3857 | 0.6516 | -0.0728 | 0.9989 |
| B-identity-48 | 0.3900 | 0.7190 | 0.0941 | 0.9989 |

身份候选在三个排序信号上均高于基线，并让宠物对鸟边际跨过零点。三个候选共享同一原图证据，
因此 `confidence` 保持一致；候选质量差异完整留在三个特征值中。两次独立 CUDA 进程复跑得到一致特征值。
