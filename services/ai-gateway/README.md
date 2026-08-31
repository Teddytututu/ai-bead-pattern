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

## 统一 Provider 合同

`AIModelProvider` 将视觉模块收敛为三个结构化输出：

- `ImageAnalysis`：mask、关键点、语义区、深度或边缘派生的结构证据
- `LearnedProposal`：学习型像素化与生成式候选的真实 RGBA 结果
- `PreferenceFeatures`：视觉嵌入、材质概率和偏好排序特征

`AIProviderRegistry` 按能力和优先级注册 Provider，`CompositeImageAnalyzer`
负责选择、执行、融合与贡献记录。`route: 'deterministic'` 直接交回冻结算法基线；
神经路线支持严格失败与逐能力降级两种策略。

```ts
import {
  AIProviderRegistry,
  CompositeImageAnalyzer,
  RembgVisionProvider,
} from '@ai-bead-pattern/ai-gateway'

const providers = new AIProviderRegistry()
providers.register(new RembgVisionProvider(), 100)

const result = await new CompositeImageAnalyzer(providers).analyze({
  image: rgbaImage,
  capabilities: ['subject-segmentation', 'edge-thin-structure'],
  route: 'neural-analysis',
  failureMode: 'best-effort',
})
```

## 通用 HTTP Provider

`HttpVisionProvider` 连接本地 Python sidecar、GPU 服务或远程推理服务。它会：

- 使用 PNG + JSON multipart 请求，减少原始 RGBA 传输体积
- 校验输入尺寸、请求能力和目标网格
- 绑定模型 id、版本、源码 commit 与权重 revision
- 限制响应字节数、候选数量和诊断文本长度
- 传递取消信号并执行超时
- 将 JSON 数组水合为 `Float32Array` / `Uint8ClampedArray`
- 通过 `/health` 验证运行模型与目录身份一致

服务响应采用 `ai-gateway-provider-v1`。模型服务需要返回真实推理结果；网关会拒绝
身份漂移、非法数组、尺寸冲突和未声明能力。

## 固定模型目录

`MODEL_CATALOG` 记录每个候选的源码 commit、权重 revision、代码与权重许可、输入尺寸、
隐私位置、设备、显存/延迟状态和失败策略。当前目录覆盖：

| 能力 | 固定候选 | 运行位置 |
|---|---|---|
| 主体与细边缘 | rembg 2.0.81 + BiRefNet-general-lite | 已接入，本地 CPU/GPU |
| 交互分割 | SAM 2.1 Hiera Tiny | 外部 Provider |
| 人脸与姿态关键点 | MediaPipe Face / Pose | 外部 Provider |
| 宠物关键点 | MMPose RTMPose-M AP-10K | 外部 Provider |
| 人像语义 | MediaPipe Selfie Multiclass | 外部 Provider |
| 视觉表征与排序特征 | DINOv2 Small | 外部 Provider |
| 材质表征 | SigLIP Base 224 | 外部 Provider |
| 深度 | Depth Anything V2 Small | 外部 Provider |
| 像素化与生成候选 | Provider 合同已就绪 | 等待维护活跃且权重许可完整的运行模型 |

目录条目表示经过许可与身份核对的部署目标。实际启用状态由 Provider 注册和健康探针给出。
`RESEARCH_MODEL_CATALOG` 单独记录 SD-piXL：它具备网格和色板控制，官方说明约需 24 GB
显存并运行数小时，部署还需逐项固定 SDXL、ControlNet 与 VAE 权重，因此保持离线研究状态。
