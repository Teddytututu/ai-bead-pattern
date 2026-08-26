# AI Gateway

外部视觉模型接入层。当前提供 rembg HTTP 适配器、MediaPipe 人脸关键点映射、
人像语义区域映射和融合接口，并统一转换为 `pattern-core` 的 `ImageAnalysis`。

## 已接入

- 主体软掩码 `subjectMask`
- 主体边界与前景融合的 `importanceMap`
- 带置信度的自动裁剪
- `rembg/模型名` 版本记录
- 超时、取消、响应大小和图像尺寸校验
- 主脸选择与相近多脸的 `ambiguous` 状态
- 9 个稳定人脸锚点及来源记录
- `subject`、`face-skin`、`hair`、`body-skin`、`clothes` 语义区域
- 语义区域与权威 corrected subject mask 相交

## Portrait Vision

`MediaPipeFaceLandmarkProvider` 和 `MediaPipePortraitSemanticProvider` 接收可注入的模型函数，部署层可以连接 MediaPipe Tasks、ONNX 或远程推理服务。`analyzePortrait` 负责主脸判定、关键点与语义区域融合；相近多脸返回 `ambiguous`，交给产品界面选择主体。

## 启动 rembg

rembg 当前支持 Python 3.11 至 3.13。CPU 环境可以直接启动本地服务：

```bash
pip install "rembg[cpu,cli]"
rembg s --host 127.0.0.1 --port 7000 --no-ui
```

模型会在首次请求时下载到 rembg 的模型目录。GPU 部署可按 rembg 官方说明改用
`rembg[gpu,cli]`。

## 调用

```ts
import { RembgHttpSegmentationProvider } from '@ai-bead-pattern/ai-gateway'
import { createPatternAlgorithm } from '@ai-bead-pattern/pattern-core'

const provider = new RembgHttpSegmentationProvider({
  endpoint: 'http://127.0.0.1:7000',
})

const segmentation = await provider.segment({ image: rgbaImage })
const result = await createPatternAlgorithm().generate({
  image: rgbaImage,
  palette,
  options,
  analysis: segmentation.analysis,
})
```

可选模型包含 `birefnet-general`、`birefnet-portrait` 和
`isnet-general-use`。默认轻量模型适合首轮在线延迟验证。
