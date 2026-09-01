# Pixel proposal sidecar

本地 Provider 使用固定版本的 PixelArt Sprite checkpoint 和 LCM-LoRA SDv1.5，提供两类真实 img2img 提案：

- `learned-pixelization`：较低重绘强度，优先保留主体身份和轮廓。
- `generative-proposal`：较高重绘强度与两个确定性 seed，提供风格差异。

输入先按比例放入正方形推理画布，空白区域使用原图角点背景色。模型结果进行最近邻缩小，再由 Pattern Core 执行目标格重建、实体色板映射、关键特征保护和网格精修。

```powershell
pnpm pixel-proposal:setup
pnpm demo:ai
```

首次生成会下载固定 revision 的模型权重并加载到 CUDA。8 GB 显存使用 sequential model CPU offload、VAE tiling 和 VAE slicing。

FastAPI 主进程保持轻量，每个确定性 seed 在独立 CUDA worker 中执行。worker 写出经过校验的 RGBA 结果后退出，临时目录随请求清理；学习像素化与生成式提案可以连续运行，API 健康检查保持响应。
