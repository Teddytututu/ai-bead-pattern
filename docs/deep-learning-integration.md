# 深度学习接入与在线算法改进

更新日期：2026-09-01

## 论文结论

本轮复核了三条与拼豆生成直接相关的学习路线：

| 论文 | 可转化的程序原则 | 当前接入 |
|---|---|---|
| Deep Unsupervised Pixelization, TOG 2018, DOI `10.1145/3272127.3275082` | 结构生成与外观生成分开；用边缘、梯度和重建一致性约束信息保留 | 将学习结果作为结构提案，后续继续执行实体色板和网格规则 |
| Make Your Own Sprites, TOG 2022, DOI `10.1145/3550454.3555482` | cell-aware 阶段确定格子结构，aliasing-aware 阶段清理边缘 | 新增 `cell-aware` 采样；现有 `grid-refinement` 承担第二阶段 |
| SD-piXL, SIGGRAPH Asia 2024, DOI `10.1145/3680528.3687570` | 直接优化 `H x W x n` 离散元素，参考图、边缘和深度提供空间条件 | 保留生成式 Provider 入口，输出继续经过实体色板、连通性和制作成本筛选 |

OpenAlex 检索复核了论文标题、作者、年份和 DOI。MYOS 的官方代码与数据许可覆盖研究、教学和个人实验，商业部署需要另行授权；SD-piXL 的计算成本适合离线教师和质量上限实验。

## 当前程序行为

### Cell-aware 采样

`ResizeMethod` 增加 `cell-aware`。每个目标格先计算区域加权均值，再根据学习模型提供的主体、边缘和重要性证据选择代表像素，降低高对比轮廓被平均成灰色的概率。

启用条件：

- MVP 使用 AI、AI+人工或融合主体证据时自动启用。
- 透明细线继续使用专用透明结构保持流程。
- A0、A1 保持冻结，继续作为消融基线。

### 两阶段边缘处理

```text
AI 分析或学习型结构提案
  -> cell-aware 目标格采样
  -> 实体 Lab 色板规划
  -> alias / stripe / isolated-cell 网格精修
  -> 结构、身份特征、明度和制作成本评分
```

这套流程对应 MYOS 的两阶段设计，同时保持一格一色、真实色号和连通性约束。

### 学习型候选进入主流程

AI Gateway 返回的 `learned-pixelization` 或 `generative-proposal` 现在会被 Demo 选择并送入 Pattern Core。目标网格取 Provider 返回的 `targetGrid`，输出随后经过：

1. cell-aware 重采样；
2. 真实材料色板映射；
3. 明度与色板规划；
4. 孤立格、色带和锯齿精修；
5. 候选评分与人工偏好比较。

界面状态会标出“学习像素化”或“生成提案”，模型身份写入生成分析来源。

### 本地 Pixel Art + LCM Provider

生产目录加入 `pixel-art-sprite-lcm-local`，固定以下权重 revision：

- PixelArt Sprite checkpoint：`8229c9b6e928103f0e657cfe6b14d902cb2101d6`
- LCM-LoRA SDv1.5：`cf2fced511dbe7e26c8d1d397e728fbab875db4b`

sidecar 使用 Diffusers 0.35.2、CUDA FP16、sequential model CPU offload、VAE tiling 和 VAE slicing。原图按比例放入推理画布；学习像素化采用较低 img2img strength，生成式提案采用较高 strength 与两个可回放 seed。输出进行最近邻缩小，随后进入 Pattern Core。

API 主进程保持轻量，每个 seed 交给独立 CUDA worker。worker 写出 RGBA 结果后立即退出，临时输入和结果目录随请求清理。生成式双候选分别运行，单次原生 CUDA 故障只影响当前 seed，健康检查和后续请求仍由 API 主进程继续处理。

SDXL Base + Pixel Art XL + LCM-LoRA SDXL 已保留在研究目录。本机完成权重下载后，5.14 GB UNet 在当前 Windows 进程内存预算下装载失败；这条路线适合独立高内存 GPU worker。

模型提案会在自身像素空间重新执行主体、宠物脸部、双眼、鼻子、耳尖和裁剪推断，解决原图分析坐标与提案坐标错位。模型加载状态、身份和推理来源由健康检查传到浏览器。

### 模型提案合同

AI Gateway 与浏览器水合层都会校验提案路线、模型身份、置信度、RGBA 数据和目标网格。异常模型输出会在进入 Pattern Core 之前终止；合法提案仍由确定性规划器完成尺寸、色板、连通性和制作成本处理。

## 后续模型实验

优先实验顺序：

1. MYOS 研究权重：固定 32/48/64 目标格，比较轮廓、耳尖、眼鼻和像素簇指标。
2. DINOv2 或 SigLIP：计算原图与候选主体裁剪的身份相似度，进入候选排序。
3. Depth Anything V2：只提供前中后景和遮挡证据，保持确定性画布规划。
4. SD-piXL：建立少量离线教师样本，训练轻量结构提案模型。

模型完成条件包括固定权重身份、许可记录、真实推理、冻结数据集对照和候选图人工检查。
