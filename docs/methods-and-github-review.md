# 可采用方法与 GitHub 项目复核

查询日期：2026-08-16

本文承接 [拼豆生成算法完整调研](algorithm-research.md) 与
[V2 算法升级方案](algorithm-upgrade-v2.md)，集中回答三个工程问题：

1. 哪些方法适合直接进入 AI Gateway 与 `pattern-core`。
2. 哪些仓库适合建立强基线、离线教师或竞品对照。
3. 首轮实验怎样用较小投入验证结构、配色和排序收益。

GitHub 活跃度、Stars 和许可证均为查询日快照。模型权重许可证按官方仓库、模型卡和
发布页单独核对。

## 2026-09-02 宠物结构与灰度配色复核

本轮读取了三个官方仓库的当前实现与配置：

- [PixelOE](https://github.com/KohakuBlueleaf/PixelOE)，Apache-2.0。采用局部对比引导、
  亮度通道细节选择、色度通道中值统计和轮廓扩张思路。
- [MMPose](https://github.com/open-mmlab/mmpose)，Apache-2.0。AP-10K 配置明确提供双眼、
  鼻、颈部、尾根和四肢关键点。
- [DeepLabCut](https://github.com/DeepLabCut/DeepLabCut)，LGPL-3.0。SuperAnimal Quadruped
  提供面向侧视四足动物的检测、裁剪和姿态估计流程。

进入程序的行为：

1. 宠物侧脸判断联合主体长宽比、口鼻突出量和左右方向证据；侧脸使用单眼、单耳、口鼻、
   上下颌、尾尖和前后脚掌锚点，裁剪覆盖完整主体。
2. `cell-aware` 采样用局部中位色度配合高对比亮度，灰度照片中的孤立彩色噪声失去放大路径。
3. `PalettePlan` 对 `Lab chroma < 8` 的角色限制候选材料色 `chroma <= 12`，明暗台阶保持中性。
4. 耳尖角色直接从低明度轮廓色中选色，单格原始量化色仅供普通特征参考。

真实宠物集 `v13` 共 6 张、每张 4 个候选。灰度侧脸犬的青绿耳部杂色已经清除，猫、狗、兔
类别均能读出。侧脸犬仍存在颈部与前腿合并导致的比例问题，下一轮以姿态骨架和身体分区为主。
内置视觉记录累计 36 条，冻结留出集 48 个成对比较上，学习排序准确率由 0.500 提升到
0.521，log loss 由 0.7081 降到 0.7057。

## 已进入产品

- `services/ai-gateway` 已实现 rembg HTTP `SegmentationProvider`，默认模型为
  `birefnet-general-lite`。
- 模型输出已映射为主体软掩码、边界重要度、自动裁剪、分析置信度和模型版本。
- `pattern-core` v0.2.3 已接收这些字段，并增加成功、best-effort、稳定候选 ID、
  分类型特征评估和 V2 合同校验。

下一批实现聚焦 MediaPipe / MMPose 语义锚点与 PIA-lite。OR-Tools、DINOv2、
通用奖励模型继续按实验门槛推进。

## 结论

下一阶段采用下面这套组合，工程收益最高：

```text
主体边界：rembg + BiRefNet-general-lite ONNX
人物语义：MediaPipe Face Landmarker + SelfieMulticlass
宠物锚点：MMPose RTMPose-m / AP-10K
交互修正：SAM 2.1 tiny
结构基线：AlexandreBinninger/pixelization 的 PIA 实现
生产结构：OpenCV / scikit-image + 自研 PIA-lite
区域明暗：语义区域 + 稳健分位数 + 二至三档 ShadeRamp
色板规划：Colour + OR-Tools / SciPy MILP
网格修复：现有确定性局部搜索 + 小窗口 CP-SAT
质量诊断：TorchMetrics / PIQ 中的 LPIPS、SSIM、MS-SSIM
偏好排序：规则分 → Bradley-Terry → LightGBM / XGBoost
视觉特征：DINOv2-small，进入偏好数据形成后的排序阶段
```

三项新增判断：

- `rembg` 已经封装 BiRefNet、IS-Net、U²-Net 与 ONNX Runtime，适合快速建立统一分割适配器。
- 新发布的 Rust 仓库 `AlexandreBinninger/pixelization` 提供 MIT 许可的 PIA 实现，适合作为结构强基线。
- 通用图像奖励模型主要面向文生图。拼豆排序先使用项目指标与成对选择，随后加入 DINOv2 特征。

## 方法在系统中的位置

```text
Image
  |
  v
AI Gateway
  |- MediaPipe: 人脸点、头发、皮肤、衣服、配饰
  |- BiRefNet: 主体 mask 与边界置信度
  |- MMPose: 宠物眼、鼻、颈部、四肢锚点
  `- SAM 2: 用户点击或框选后的 mask 修正
  |
  v
ImageAnalysis / UnderstandingResult
  |
  v
pattern-core
  |- CanvasPlan / FeatureBudget
  |- StructurePlan / PIA-lite
  |- ValuePlan / ShadeRamp
  |- PalettePlan / CP-SAT or MILP
  |- ClusterRefiner / local search
  `- CandidateEvaluation / pairwise ranker
```

## 1. 主体、人物与宠物理解

### 1.1 BiRefNet 作为主体边界主模型

[BiRefNet](https://github.com/ZhengPeng7/BiRefNet) 采用全局定位与细节重建两部分，梯度参考
专门服务于细边界。官方仓库提供 MIT 代码与权重、ONNX 转换、动态分辨率模型、肖像模型、
通用模型和轻量模型。标准模型在官方 RTX 4090 测试中达到 1024×1024、FP16 17 FPS、
约 3.45 GB 显存。GitHub Release 中的通用轻量 ONNX 约 224 MB，适合首轮服务端接入。

[rembg](https://github.com/danielgatis/rembg) 已提供 `birefnet-general-lite`、
`birefnet-general`、`birefnet-portrait`、`birefnet-dis` 等模型入口，并支持 Python 库、
CLI、HTTP 服务和 Docker。首轮实验直接通过 rembg 建立 `SegmentationProvider`，验证完成后
再决定是否抽出独立 ONNX Runtime 服务。

推荐模型顺序：

| 模型 | 用途 | 首轮位置 |
|---|---|---|
| `birefnet-general-lite` | 通用人物、宠物、物体 | 默认主体 mask |
| `birefnet-portrait` | 半身与头像 | 人像专项候选 |
| `birefnet-general` | 边界质量上限 | 离线质量对照 |
| `BiRefNet_dynamic` | 任意输入分辨率 | 第二轮质量候选 |

### 1.2 MediaPipe 继续负责人像语义

[MediaPipe](https://github.com/google-ai-edge/mediapipe) 保持人物首选。Face Landmarker
提供五官与脸型锚点，SelfieMulticlass 提供头发、脸部皮肤、身体皮肤、衣服和配饰区域。
BiRefNet 提供主体外边界，MediaPipe 提供主体内部语义，两者输出融合成统一
`UnderstandingResult`。

融合规则建议：

```text
foreground = BiRefNet mask
face / hair / skin / clothes = MediaPipe semantic masks ∩ foreground
landmark confidence = Face Landmarker confidence
boundary confidence = BiRefNet gradient confidence
```

### 1.3 MMPose 负责人宠物锚点

[MMPose](https://github.com/open-mmlab/mmpose) 的 RTMPose / AP-10K 配置提供双眼、鼻子、
颈部、尾根和四肢锚点。BiRefNet 负责毛发外边界，RTMPose 负责姿态与脸部局部坐标，耳朵
继续由轮廓高曲率、对称关系和头部颜色区域联合提取。

### 1.4 SAM 2 进入交互修正

[SAM 2](https://github.com/facebookresearch/sam2) 采用 Apache-2.0，SAM 2.1 tiny 为
38.9 M 参数。官方速度表基于 A100，tiny 达到 91.2 FPS。它适合处理下面两类操作：

- 用户点击主体，修正自动 mask 选错对象。
- 用户框选头发、耳朵、尾巴等区域，刷新局部边界。

自动首轮继续采用 BiRefNet。SAM 2 的价值集中在用户控制与复杂多主体图片。

### 1.5 研究候选

| 方法 | 能力 | 项目位置 |
|---|---|---|
| [DIS-SAM](https://github.com/Tennine2077/DIS-SAM) | SAM + IS-Net 两阶段精细分割 | 提示式边界研究对照 |
| [LawDIS](https://github.com/XinyuYanTJU/LawDIS) | 语言控制与窗口局部细化 | 离线交互教师 |
| [FlowDIS](https://arxiv.org/abs/2605.05077) | Flow Matching + 文本控制 | 论文跟踪 |
| [DIS](https://github.com/xuebinqin/DIS) | IS-Net 通用分割 | 轻量稳定对照 |
| [MVANet](https://github.com/qianyu-dlut/MVANet) | 多视图精细边界 | 高精度研究对照 |

LawDIS 依赖 Stable Diffusion 2 与专用 checkpoint，部署成本较高。FlowDIS 处于 2026 预印本
阶段。两者适合启发“语言或窗口控制 mask”的产品交互。

## 2. 结构抽象与 PIA-lite

### 2.1 PIA 的现成强基线

[AlexandreBinninger/pixelization](https://github.com/AlexandreBinninger/pixelization) 是
2025 年公开的 Rust 库，采用 MIT 许可，包含 K-Means 与 Pixelated Image Abstraction。
该仓库由 SD-πXL 作者维护，并已经发布 `pixelization` crate。它适合承担三项工作：

1. 生成 PIA 结构基线。
2. 验证超像素映射对眼睛、轮廓和小花纹的收益。
3. 对照自研 PIA-lite 的速度与结构指标。

仓库当前提交集中在首次公开发布阶段，依赖评级设为研究基线；生产路线继续保持自研
TypeScript 核心与可解释阶段合同。

### 2.2 生产结构路线

[OpenCV](https://github.com/opencv/opencv) 与
[scikit-image](https://github.com/scikit-image/scikit-image) 覆盖 Guided/Bilateral Filter、
SLIC、RAG、形态学、连通域和轮廓。生产版 PIA-lite 建议按下面顺序实现：

```text
多尺度边缘保持平滑
  -> SLIC 超像素
  -> 语义隔离
  -> 颜色、边界、重要性联合区域合并
  -> FeatureBudget 分配
  -> 输出格到输入区域的局部映射搜索
  -> 关键锚点回填
```

核心新增变量为 `sourceMapping`。每个输出格记录来源区域、局部位移、语义区域、结构锚点与
置信度，后续 ValuePlan 与 PalettePlan 复用同一结构结果。

### 2.3 边缘模型优先级

| 仓库 | 许可 | 维护快照 | 建议 |
|---|---|---|---|
| [TEED](https://github.com/xavysp/TEED) | MIT | 2023-10 最近推送 | 轻量学习边缘对照 |
| [PiDiNet](https://github.com/hellozhuo/pidinet) | 许可待确认 | 2024-07 最近推送 | 许可证确认后再进入实验 |
| OpenCV Canny / Scharr | Apache-2.0 | 活跃 | 首轮生产方案 |

目标网格只有 32 至 64 格，经典边缘与语义 mask 已能提供稳定约束。学习边缘模型安排在
长毛、透明边缘和复杂背景专项中验证。

## 3. 明暗与区域颜色角色

ValuePlan 继续采用区域级方法：

1. 在每个语义连通区域统计稳健亮度分布。
2. 使用 2 至 3 个分位点形成 `base / light / shadow`。
3. 通过相邻区域对比修正脸、头发、衣服和宠物花纹的亮暗顺序。
4. 将高频纹理压入区域角色，将身份纹理保留为独立小区域。

White-box Cartoonization、intrinsic decomposition、LawDIS 与 SD-πXL 均进入离线教师组。
教师输出负责提出候选，最终颜色仍由真实材料色卡约束。

## 4. 色板规划与实体颜色

### 4.1 推荐求解方式

[Colour](https://github.com/colour-science/colour) 作为 Python 色彩基准，`pattern-core`
继续保留已验证的 CIEDE2000 实现。全局 PalettePlan 分成两个规模：

```text
区域级：20 至 120 个区域 × 24 至 80 个候选豆色
格子级：32² 至 64² 个格 × 区域候选色子集
```

区域级使用 [OR-Tools](https://github.com/google/or-tools) CP-SAT 或
[SciPy](https://github.com/scipy/scipy) MILP：

```text
变量 x[r,c] = 区域 r 是否使用颜色 c
变量 y[c]   = 全图是否启用颜色 c

约束：
  每个区域选择 1 至 k 个角色色
  x[r,c] <= y[c]
  sum(y[c]) <= 材料颜色上限
  硬特征颜色保持可区分

目标：
  重要性加权 DeltaE00
  + 区域明暗顺序代价
  + 相邻区域对比代价
  + 启用色号代价
```

格子级继续使用候选色子集与局部搜索。CP-SAT 集中处理 5×5、7×7 的眼口耳、花纹和轮廓
窗口，能够控制耗时与变量规模。

### 4.2 量化基线

| 仓库 | 许可 | 作用 | 判断 |
|---|---|---|---|
| [RgbQuant.js](https://github.com/leeoniya/RgbQuant.js) | MIT | JavaScript 量化与预定义 palette | 浏览器 A0/A1 基线 |
| [rscolorq](https://github.com/okaneco/rscolorq) | Apache-2.0 | 空间量化与抖动联合优化 | 离线强基线 |
| [image_to_pixel_art_wasm](https://github.com/gametorch/image_to_pixel_art_wasm) | MIT | Rust/WASM K-Means 与固定 palette | 端侧速度对照 |
| [libimagequant](https://github.com/ImageOptim/libimagequant) | GPL-3.0/商业双许可 | 高质量量化 | 内部基准或商业授权 |

rscolorq 强调低色数下的空间量化，适合测试“邻域感知量化”收益。其最近代码推送为 2021 年，
生产依赖优先选用 OpenCV、SciPy 与项目自身实现。

### 4.3 色卡数据来源

[BeadColors](https://github.com/maxcleme/beadcolors) 采用 MIT，提供 MARD、Perler、Hama、
Artkal 等品牌 CSV，适合建立色号目录和导入器测试。仓库 RGB 属于社区整理值。正式色卡继续
维护三层来源：

1. 厂家公开色号与名称。
2. 社区 RGB 参考值与来源记录。
3. 项目实体测量的 `measuredLab`。

## 5. 网格能量与局部修复

现有 `pattern-core` 已具备连通域、孤立格、细条、拓扑和 palette coherence。下一轮增加
两个求解器即可：

### 5.1 小窗口 CP-SAT

眼睛、嘴、耳朵、尾巴尖、衣服标志采用 5×5 或 7×7 窗口。每格只保留 2 至 5 个候选色，
目标包含：

- 原始区域颜色代价。
- 硬特征可见度。
- 左右对称与相对位置。
- 孤立格、细条和阶梯代价。
- 修改格数量。

### 5.2 SciPy maximum flow

SciPy 提供 BSD-3-Clause 的 `scipy.sparse.csgraph.maximum_flow`，可构建二元 graph-cut
实验，并作为 alpha-expansion 的底层求解器候选。容量需要缩放为整数，能量转换与数值范围
进入单元测试。

[PyMaxflow](https://github.com/pmneila/PyMaxflow) 采用 GPL，适合研究验证。
[pydensecrf](https://github.com/lucasb-eyer/pydensecrf) 采用 MIT，最近推送为 2024-03，
C++/Cython 安装成本较高，安排在后续候选。

## 6. 多候选排序

### 6.1 排序升级顺序

| 阶段 | 模型 | 输入 | 适用数据量 |
|---|---|---|---:|
| R0 | 规则加权 | 自动指标 | 0 至 500 对 |
| R1 | Bradley-Terry / 逻辑回归 | 候选指标差值 | 500 至 2,000 对 |
| R2 | LightGBM LambdaRank / XGBoost `rank:pairwise` | 指标、区域统计、参数 | 2,000 至 10,000 对 |
| R3 | DINOv2-small + 小型排序头 | 原图、候选图、局部裁剪、指标 | 10,000 对以上 |

[scikit-learn](https://github.com/scikit-learn/scikit-learn) 的逻辑回归足以实现 R1。
[LightGBM](https://github.com/lightgbm-org/LightGBM) 与
[XGBoost](https://github.com/dmlc/xgboost) 均提供正式排序目标。每张来源图片作为一个 query
group，候选方案在组内排序，训练与测试按来源图片切分。

### 6.2 DINOv2 优先于 CLIP

[DINOv2](https://github.com/facebookresearch/dinov2) 的代码与通用权重采用 Apache-2.0，
能够输出全局 token 与 patch token。拼豆排序可提取四类特征：

- 原图与候选的全局语义相似度。
- 脸部、宠物头部和身份花纹裁剪相似度。
- 主体边界附近 patch 相似度。
- 候选之间的视觉差异。

[CLIP](https://github.com/openai/CLIP) 更适合主体类别与文本描述一致性。拼豆质量高度依赖
局部结构、材料色和工艺复杂度，DINOv2 与自动指标的组合更贴近任务。

### 6.3 感知指标只作诊断特征

[TorchMetrics](https://github.com/Lightning-AI/torchmetrics) 采用 Apache-2.0，包含 LPIPS、
SSIM 与 MS-SSIM。[PIQ](https://github.com/photosynthesis-team/piq) 同样采用 Apache-2.0。
两者适合离线评估与排序特征。

LPIPS 和 SSIM 衡量视觉保真或结构相似。拼豆还包含主动简化与工艺目标，因此它们进入特征
集合，由人类偏好决定最终权重。

[IQA-PyTorch](https://github.com/chaofengc/IQA-PyTorch) 模型覆盖很广，当前代码许可为
PolyForm Noncommercial 1.0.0，适合内部研究。

### 6.4 通用奖励模型的位置

| 模型 | 原始任务 | 项目判断 |
|---|---|---|
| [ImageReward](https://github.com/zai-org/ImageReward) | 文本与生成图偏好 | 离线教师特征 |
| [PickScore](https://github.com/yuvalkirstain/PickScore) | 同提示词生成图比较 | 偏好数据协议参考 |
| [HPSv2](https://github.com/tgxs002/HPSv2) | 文生图人类偏好 | 风格候选诊断 |

这些模型依赖 prompt 与文生图数据分布。它们适合回答“候选是否像描述”，项目排序器还要回答
“五官是否清楚、色号是否协调、图纸是否好拼”。首版保持领域指标与项目成对数据主导。

2026 年的 [LPIFM](https://arxiv.org/abs/2608.01301) 使用同一来源的 A/B/Tie 选择训练
source-conditioned 排序器。该论文面向红外与可见光融合，训练协议与拼豆候选高度相似，
适合借鉴四项设计：同源比较、Tie 标签、完整候选对、来源图片级切分。

## 7. 同类 GitHub 项目

### 7.1 项目快照

| 仓库 | Stars | 最近推送 | 许可 | 可借鉴部分 |
|---|---:|---|---|---|
| [Zippland/perler-beads](https://github.com/Zippland/perler-beads) | 867 | 2026-05 | AGPL-3.0 | 多品牌色板与成熟产品基线 |
| [BeadColors](https://github.com/maxcleme/beadcolors) | 39 | 2026-03 | MIT | 品牌色号目录 |
| [bead-grid-studio](https://github.com/zwhy149/bead-grid-studio) | 1 | 2026-08 | Apache-2.0 | 小线稿连通组件 owner 追踪、单 HTML 交付 |
| [MOSAIBeads](https://github.com/TonyVan123/mosaibeads) | 0 | 2026-08 | MIT | 参数搜索、Pareto 候选、4 MB MobileNet 特征 |
| [pbdx](https://github.com/anantheparty/pbdx) | 0 | 2026-05 | 许可待确认 | Lab/CIEDE2000、抖动与邻域平滑 |
| [fuse-bead-pattern-generator](https://github.com/Steeefanie/fuse-bead-pattern-generator) | 0 | 2026-07 | 许可待确认 | 全局 palette 子集贪心与交换优化 |

### 7.2 开源产品覆盖范围

现有项目已经较好覆盖：

- 品牌色板与色号映射。
- Lab / CIEDE2000 匹配。
- 抖动、孤立格整理和材料统计。
- 手工逐格编辑、网格与导出。
- 少量参数搜索或轻量语义特征。

本项目的差异化继续集中在四处：

1. 人物与宠物锚点驱动的 FeatureBudget。
2. PIA-lite 对网格空间的主动重新分配。
3. 语义区域级 ValuePlan 与真实材料 ShadeRamp。
4. 同源 A/B/Tie 数据训练的领域排序器。

Zippland 的 AGPL 代码适合黑盒竞品对照。bead-grid-studio 与 MOSAIBeads 处于近期首发阶段，
适合吸收测试维度与产品交互，核心算法继续独立实现。

## 8. GitHub 维护与许可证矩阵

| 仓库 | Stars | 最近推送 | 许可 | 分类 |
|---|---:|---|---|---|
| BiRefNet | 4,049 | 2026-07 | MIT | 直接接入 |
| rembg | 24,265 | 2026-08 | MIT | 直接接入 |
| MediaPipe | 36,627 | 2026-08 | Apache-2.0 | 直接接入 |
| MMPose | 7,830 | 2025-08 | Apache-2.0 | 直接接入 |
| SAM 2 | 19,705 | 2026-05 | Apache-2.0 | 交互修正 |
| OpenCV | 90,454 | 2026-08 | Apache-2.0 | 直接接入 |
| scikit-image | 6,573 | 2026-08 | BSD 系 | 研究与实现参考 |
| Colour | 2,635 | 2026-08 | BSD-3-Clause | 颜色基准 |
| OR-Tools | 13,903 | 2026-08 | Apache-2.0 | 直接接入 |
| SciPy | 14,927 | 2026-08 | BSD-3-Clause | 直接接入 |
| scikit-learn | 66,961 | 2026-08 | BSD-3-Clause | R1 排序器 |
| LightGBM | 18,688 | 2026-08 | MIT | R2 排序器 |
| XGBoost | 28,658 | 2026-08 | Apache-2.0 | R2 排序器 |
| DINOv2 | 13,233 | 2026-06 | Apache-2.0 | R3 视觉特征 |
| TorchMetrics | 2,458 | 2026-07 | Apache-2.0 | 质量诊断 |
| PIQ | 1,572 | 2024-05 | Apache-2.0 | 质量诊断对照 |
| Pixelization Rust | 1 | 2025-12 | MIT | PIA 强基线 |
| RgbQuant.js | 475 | 2024-01 | MIT | 浏览器量化基线 |
| rscolorq | 75 | 2021-03 | Apache-2.0 | 空间量化基线 |
| libimagequant | 925 | 2026-06 | GPL-3.0/商业 | 授权后接入 |
| IQA-PyTorch | 3,366 | 2026-07 | PolyForm Noncommercial | 内部研究 |
| PyMaxflow | 260 | 2024-11 | GPL | 内部研究 |
| PiDiNet | 620 | 2024-07 | 许可待确认 | 许可确认 |

## 9. 首轮实验

### E10：主体与语义融合

样本使用现有 60 图评估集。

| 路线 | 输出 |
|---|---|
| MediaPipe | 人物内部语义与五官锚点 |
| BiRefNet-general-lite | 通用主体 mask |
| BiRefNet-portrait | 人像专项 mask |
| DIS / IS-Net | 轻量分割对照 |

检查 Boundary F-score、毛发与耳朵保留率、主体误选率、冷启动时间、CPU/GPU P50/P95、
模型常驻内存。首轮通过目标为边界人工偏好胜率达到 65%，GPU P95 增量控制在 2 秒内。

### E11：PIA 与 PIA-lite

选择 20 张最容易丢眼睛、耳朵、发型和花纹的图片，固定 48×48 与 24 色。

```text
A1 当前面积采样
B0 Rust PIA
B1 SLIC + 区域合并
B2 B1 + FeatureBudget
B3 B2 + sourceMapping 局部位移
```

检查关键特征可见率、主体轮廓 Boundary F-score、区域碎片数、孤立格比例和人类偏好。
B3 相对 A1 的关键特征可见率目标提升 10 个百分点，人类偏好胜率目标达到 65%。

### E12：ValuePlan 与 PalettePlan

固定 B3 结构，比较：

```text
C0 当前逐格 Lab
C1 区域二至三档明暗
C2 C1 + 贪心 palette 子集
C3 C1 + OR-Tools / SciPy 区域 palette 优化
```

检查重要性加权 DeltaE00、区域亮暗顺序、相邻区域对比、材料色号数和阴影碎片数。C3 在
同等色号上限下，重要性加权 DeltaE00 目标下降 5%，区域亮暗顺序目标达到 95%。

### E13：ClusterRefiner

在眼口耳、发型转折和宠物花纹处建立 5×5、7×7 小窗口，对比现有局部搜索与 CP-SAT。
检查硬特征保持、修改格数、能量下降、耗时与确定性。每候选局部优化 P95 目标控制在
300 ms，重复运行保持逐格一致。

### E14：成对排序

每张图片保留 4 个候选，共形成 `60 × C(4,2) = 360` 个 A/B/Tie 对。20% 样本重复标注，
训练与测试按来源图片切分。

```text
R0 规则分
R1 Bradley-Terry
R2 LightGBM LambdaRank
R2+DINO DINOv2-small 特征
```

检查三分类准确率、非 Tie 方向准确率、Kendall tau、分图片类型胜率和置信度校准。R1 在
独立图片集上先达到 60% 非 Tie 方向准确率，再进入 R2。

## 10. 实施顺序

| 顺序 | 工作 | 交付 |
|---:|---|---|
| 1 | rembg + BiRefNet adapter | `UnderstandingResult.foreground` |
| 2 | MediaPipe / MMPose 融合 | 人物与宠物 FeatureConstraint |
| 3 | Rust PIA 基线 | 固定评估脚本与结果图 |
| 4 | PIA-lite sourceMapping | `StructurePlan` |
| 5 | 区域 ValuePlan | `ShadeRamp` |
| 6 | OR-Tools / SciPy PalettePlan | 全局材料色板方案 |
| 7 | 小窗口 ClusterRefiner | 五官与轮廓局部修复 |
| 8 | A/B/Tie 采集与 Bradley-Terry | 第一版领域排序器 |

这条顺序优先验证主体、结构和明暗。视觉大模型与通用奖励模型在偏好数据形成后进入，能够
减少早期算力投入和数据域偏差。

## 论文参考

- Zheng, P., Gao, D., Fan, D.-P., et al. (2024). Bilateral Reference for
  High-Resolution Dichotomous Image Segmentation. *CAAI Artificial Intelligence Research*.
  <https://doi.org/10.26599/AIR.2024.9150038>
- Zhang, R., Isola, P., Efros, A. A., Shechtman, E., & Wang, O. (2018). The Unreasonable
  Effectiveness of Deep Features as a Perceptual Metric. *CVPR*.
  <https://doi.org/10.1109/CVPR.2018.00068>
- Kirstain, Y., Levy, O., Matiana, S., et al. (2023). Pick-a-Pic: An Open Dataset of User
  Preferences for Text-to-Image Generation. *NeurIPS*.
  <https://doi.org/10.52202/075280-1594>
- Ding, M., Dong, Y., Li, Q., et al. (2023). ImageReward: Learning and Evaluating Human
  Preferences for Text-to-Image Generation. *NeurIPS*.
  <https://doi.org/10.52202/075280-0700>
- Tirandaz, Z., Foster, D., Romero, J., & Nieves, J. L. (2023). Efficient quantization of
  painting images by relevant colors. *Scientific Reports, 13*.
  <https://doi.org/10.1038/s41598-023-29380-8>
- Oquab, M., Darcet, T., Moutakanni, T., et al. (2023). DINOv2: Learning Robust Visual
  Features without Supervision. <https://arxiv.org/abs/2304.07193>
- Liu, H., Liu, M., Li, P., & Zan, G. (2026). Ranking Image Fusion the Way Humans Do: A
  Learned Pairwise Preference Measure for Infrared-Visible Fusion Assessment.
  <https://arxiv.org/abs/2608.01301>

以上论文在 Scite 中完成题录与 editorial notice 检查，editorial notice 列表为空。
GitHub 项目采用官方仓库、README、LICENSE、Release、模型卡与提交记录核对。
