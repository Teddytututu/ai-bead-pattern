# 拼豆生成算法完整调研

查询日期：2026-08-15

整体方法和阶段关系见 [从绘画过程到拼豆图纸：生成方法论](drawing-to-bead-method.md)。本文集中记录模型选择、算法细节、实验设计、许可证和来源。

2026-08-16 的模型、GitHub 仓库、许可证与接入成本复核见
[可采用方法与 GitHub 项目复核](methods-and-github-review.md)。

## 结论

八个专题调研完成后，第一版算法建议采用下面这套组合：

```text
人物：MediaPipe Face Landmarker + SelfieMulticlass
宠物：DeepLab-v3 主体掩码 + RTMPose-m / AP-10K
尺寸：32 / 48 / 64 离散候选搜索
结构：边缘保持平滑 + SLIC + 受约束区域合并 + 受约束栅格化
颜色：sRGB → CIELAB(D65) → CIEDE2000 → 全局材料色板优化
光影：语义区域固有色 + 区域相对明暗 + 二至三档阴影
网格：连通域规则 + 2×2 拓扑检查 + 受约束局部搜索
排序：规则评分 → Bradley-Terry / XGBoost → 视觉特征排序头
部署：服务端主流程 + 小程序压缩上传与预览 + 轻模型端侧实验
评估：自动诊断指标 + 随机双盲成对选择 + 来源图片级数据切分
```

人物路线具备现成模型、细密五官锚点和人物多类分割。宠物路线先用通用身体关键点稳定姿态和脸部三角形，再从主体轮廓与局部色块提取耳朵、脸部花纹等身份特征。猫狗面部专用数据适合第二阶段训练，商业训练数据采用自有或单独授权图片池。

尺寸规划采用候选评分，并保持脸型和身体比例稳定。结构阶段先分配关键特征格数，再合并摄影纹理。颜色阶段同时维护屏幕参考色与实体测量色，金属、透明、夜光等材料独立成特殊色组。

完整 intrinsic decomposition、GAN 卡通化和大模型审美评分安排为第二阶段候选。首版使用区域级可解释算法建立稳定基线，并通过偏好数据逐步升级排序器。

## 术语账本

| 术语 | 本项目定义 |
|---|---|
| `ImportanceMap` | 原图坐标中的连续重要性权重，来源包括语义、关键点、轮廓、局部对比和用户标记 |
| `FeatureBudget` | 某个候选画布分配给眼、口、耳、花纹等特征的最小格数与空间余量 |
| `FeatureConstraintMap` | 目标网格上的硬约束、软约束、允许位移、对称关系和置信度 |
| `StructurePlan` | 完成轮廓简化、区域合并和关键锚点保护后的抽象结构 |
| `displayRgb` | 厂家网页、PDF 或界面预览使用的屏幕参考色 |
| `measuredLab` | 在声明的照明、观察者、几何、仪器和样片状态下测得的实体颜色 |
| `ΔE00` | CIEDE2000 色差，用于理想区域色与实体材料色的主要距离 |
| 关键点碰撞 | 两个需要独立表达的特征投影到同一目标格 |
| 工艺噪声 | 孤立豆、极小连通域、一格宽长条、轮廓毛刺等制作与观感问题 |

## 1. 评估集与基线

### 1.1 评估集

首批固定 60 张图片：

| 类型 | 数量 | 覆盖条件 |
|---|---:|---|
| 人物 | 24 | 正脸、三分之二侧脸、侧脸、眼镜、帽子、遮挡、深浅肤色、复杂光照 |
| 宠物 | 24 | 猫 12、狗 12；近景脸、全身、长毛、垂耳、花纹、复杂背景 |
| 插画 | 12 | Q 版、动漫头像、平涂角色、线稿和高饱和插画 |

图片来源优先级：团队自有并获授权的照片、书面同意的用户样本、许可清楚的公开图片。每张图记录作者、来源、许可、主体类型、姿态、遮挡、光照、背景复杂度和关键身份特征。

主实验固定三档资源：

| 画布 | 默认最大颜色数 | 主要用途 |
|---|---:|---|
| 32×32 | 16 | 低成本头像和简单宠物 |
| 48×48 | 24 | 首版推荐档 |
| 64×64 | 32 | 全身、复杂花纹和较细五官 |

另取 15 张代表图执行颜色数敏感性实验，比较 12、20、32 色。

### 1.2 四条比较路线

| 编号 | 方法 | 用途 |
|---|---|---|
| A0 | 面积缩放或最近邻缩放 + RGB 最近色 | 复现普通在线转换器 |
| A1 | 面积缩放 + Lab / ΔE00 + 连通域整理 | 工程基础线 |
| A2 | 细节保持下采样 + Lab / ΔE00 + 连通域整理 | 检验高频细节保留的贡献 |
| A3 | 尺寸规划 + 特征约束 + 结构简化 + 全局色板 | 项目首版目标 |

Kopf 等人的内容自适应下采样通过调整采样核的位置和形状保持线条连接；Weber 等人的 DPID 采用线性复杂度卷积，对局部突出差异赋予更高权重。DPID 的用户研究获得较高偏好，同时论文记录了细线变粗与混叠案例。因此 A2 适合作为强基线，A3 继续负责语义保护和工艺整理。[Content-adaptive image downscaling](https://doi.org/10.1145/2508363.2508370)，[Rapid, detail-preserving image downscaling](https://doi.org/10.1145/2980179.2980239)

另外设置四条像素化研究对照，分别检验结构抽象、网格控制、学习型像素化和离散实体生成：

| 编号 | 研究对照 | 主要检验项 |
|---|---|---|
| P0 | Pixelated Image Abstraction | 超像素映射与有限调色板联合优化 |
| P1 | Deep Unsupervised Pixelization | 多尺度网格、锐利边缘与局部结构保持 |
| P2 | Make Your Own Sprites | cell size 控制、cell-aware 与 aliasing-aware 分阶段处理 |
| P3 | SD-πXL | 固定 `H × W × n` 离散元素生成与实体制作适配 |

P0 与 A3 的结构和色板阶段最接近，适合作为传统优化强对照。P1 与 P2 进入第二阶段模型对照，其中 P2 官方代码和数据授权范围限于非商业科研、教学与个人实验。P3 直接覆盖有限网格、有限元素集合与 beading 等制作任务，适合作为离线生成教师与上限参考。[Pixelated Image Abstraction](https://doi.org/10.1016/j.cag.2012.12.007)，[Deep Unsupervised Pixelization](https://doi.org/10.1145/3272127.3275082)，[Make Your Own Sprites](https://doi.org/10.1145/3550454.3555482)，[SD-πXL](https://doi.org/10.1145/3680528.3687570)

### 1.3 自动诊断指标

自动指标分成四组：

| 维度 | 指标 |
|---|---|
| 关键特征 | 关键点覆盖率、关键点碰撞率、位置误差、眼口耳最小格数满足率 |
| 结构 | 主体轮廓 IoU、Boundary F-score、左右对称误差、轮廓断裂数 |
| 颜色 | 重要性加权 ΔE00、亮暗顺序一致率、相邻区域对比、材料色号数量 |
| 工艺 | 孤立豆比例、1 至 2 格小连通域比例、一格宽长条长度、总豆数 |

关键点位置误差统一换算到目标网格，以 1 格作为首轮调参阈值。关键点碰撞指两个需独立表达的特征落入同一格，例如双眼中心或眼睛与鼻子重合。

### 1.4 人工偏好实验

RetargetMe 比较了八种图像重定向方法，发现常见图像距离与人类排序存在偏差。后续客观评分工作采用重点区域、伪影、全局结构、美学规则和对称性五类因素，并在 RetargetMe 与新增用户研究上验证排序相关性。[RetargetMe](https://doi.org/10.1145/1882261.1866186)，[Objective Quality Prediction](https://doi.org/10.1109/TVCG.2016.2517641)

本项目采用三问成对盲评：

1. 哪张更容易认出主体？
2. 哪张整体更好看？
3. 哪张更愿意实际制作？

每对结果随机交换左右位置，允许平局。每对收集至少 5 票，按人物、宠物、插画和画布尺寸分别统计胜率，并使用 bootstrap 置信区间。第一轮工程目标建议设为：A3 相对 A1 的整体偏好达到 65%，置信区间下界越过 50%；关键特征碰撞率下降 30%；孤立豆与小碎片合计下降 40%。这些数值属于项目目标，首轮实验后按真实难度校准。

## 2. 人物、宠物主体与关键点

### 2.1 人物首版

MediaPipe Face Landmarker 输出每张脸的 478 个三维关键点、52 个 blendshape 分数和面部变换矩阵。Attention Mesh 论文说明区域注意力专门提升眼睛和嘴唇精度，统一模型在 Pixel 2XL 上约 16.6 ms，眼部归一化误差优于级联方案。[Face Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker)，[Attention Mesh](https://arxiv.org/abs/2006.10962)

MediaPipe Image Segmenter 的 SelfieMulticlass 提供六类掩码：背景、头发、身体皮肤、脸部皮肤、衣服、配饰，同时提供类别掩码与逐类置信度掩码。官方 Pixel 6 基准约为 CPU 217.76 ms、GPU 71.24 ms，适合首版服务端处理。[Image Segmenter](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter)

推荐输出：

| 数据 | 来源 | 算法用途 |
|---|---|---|
| 眼睛、眉毛、鼻子、嘴唇、脸型点 | Face Landmarker | 特征格数、对称关系、轮廓锚点 |
| 头发、脸、皮肤、衣服、配饰 | SelfieMulticlass | 语义区域、固有色统计、区域合并隔离 |
| blendshape | Face Landmarker | 嘴型、眯眼、张嘴等状态提示 |
| 置信度 | 两个模型 | 调整硬约束与软约束强度 |

### 2.2 宠物首版

AP-10K 包含 10,015 张带关键点图片、13,028 个实例、23 个科和 54 个物种，采用 17 个关键点：双眼、鼻子、颈部、尾根和四肢关节。训练、验证、测试按物种执行 7:1:2 划分。MMPose 提供 RTMPose-m 的现成配置和权重，输入 256×256，AP 为 0.722。[AP-10K](https://arxiv.org/abs/2108.12617)，[MMPose AP-10K 配置](https://github.com/open-mmlab/mmpose/blob/main/configs/animal_2d_keypoint/rtmpose/ap10k/rtmpose_ap10k.md)

AP-10K 支撑姿态、双眼、鼻子和身体比例。耳朵轮廓、嘴部细节与代表性花纹由下面三类信号提供：

1. 以双眼、鼻子、颈部建立头部局部坐标系。
2. 在主体轮廓上搜索头部上方的高曲率对称候选，形成耳尖与耳根软约束。
3. 在头部掩码内按颜色对比、连通性和对称性提取花纹候选。

DeepLab-v3 的 MediaPipe 模型包含 person、cat、dog 等类别，适合提供宠物主体粗掩码。宠物头部裁剪可由主体框、双眼鼻子三角形和轮廓共同确定。[Image Segmenter](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter)

### 2.3 猫狗面部专用路线

| 数据集 | 当前规模 | 锚点 | 主要发现 | 项目位置 |
|---|---:|---:|---|---|
| CatFLW | 2,079 张 | 48 | 基于猫面部解剖和 CatFACS | 第二阶段猫脸模型 |
| DogFLW | 仓库 4,335 张；2025 论文 3,732 张 | 46 | 耳朵误差最高，垂耳变化最难 | 第二阶段狗脸模型 |

DogFLW 论文给出的 ELD 测试结果中，整体 NME 为 6.52；眼睛、鼻子、耳朵区域 NME 分别为 2.24、4.22、13.19。垂耳犬的耳部 NME 为 15.28，明显高于立耳犬的 9.79。这组结果说明耳朵应作为独立身份特征，并由轮廓和专用锚点共同保护。[Dog facial landmarks detection](https://doi.org/10.1038/s41598-025-07040-3)，[DogFLW 仓库](https://github.com/martvelge/DogFLW)，[CatFLW 仓库](https://github.com/martvelge/CatFLW)

CatFLW 与 DogFLW 仓库采用 CC BY-NC 4.0，且仓库以数据发布为主。研究验证可以直接使用；商业训练安排自建标注集、单独授权或律师复核后的来源。

## 3. 构图与尺寸规划

### 3.1 离散候选搜索

首版只搜索 32×32、48×48、64×64。每个尺寸同时搜索少量裁剪框，裁剪框来自主体框扩边、脸部框扩边、全身框和原图构图四类模板。

建议评分：

```text
CanvasScore =
  0.24 × 关键特征可表达度
+ 0.20 × 主体完整度
+ 0.16 × 轮廓空间
+ 0.14 × 构图平衡
+ 0.12 × 对称保持
+ 0.08 × 背景简洁度
+ 0.06 × 模型置信度
- 制作成本项
```

权重属于首轮搜索起点，通过盲评和消融实验调整。

### 3.2 关键特征可表达度

每个候选尺寸先将关键点和区域投影到网格，计算：

- 双眼是否落入独立格组
- 眼间距、嘴宽、鼻口距离的量化误差
- 双耳是否各有连续支撑格
- 脸部轮廓是否拥有足够转折点
- 代表性花纹是否达到最小面积
- 五官周围是否留有对比色空间

建议建立 `FeatureBudget`：

| 特征 | 32×32 起始预算 | 48×48 起始预算 | 64×64 起始预算 |
|---|---:|---:|---:|
| 单眼 | 1 至 2 格 | 2 至 4 格 | 4 至 8 格 |
| 嘴部 | 1 至 3 格 | 3 至 6 格 | 5 至 10 格 |
| 单耳 | 2 至 5 格 | 4 至 10 格 | 8 至 18 格 |
| 身份花纹 | 2 格 | 3 至 6 格 | 6 至 12 格 |

预算表示搜索约束，最终数值由评估集校准。候选出现关键点碰撞时，尺寸评分直接降低；48×48 能解除主要碰撞时，系统优先推荐 48×48。

### 3.3 与图像重定向研究的关系

图像重定向研究表明，单一缩放、裁剪或 seam carving 各有适用范围，多算子组合更容易获得人类偏好。[Multi-operator media retargeting](https://doi.org/10.1145/1531326.1531329)

本项目吸收其“多候选 + 人类排序”思想，尺寸生成保留规则化几何：裁剪、统一缩放、主体位置微调。人物脸型、宠物身体比例和目标网格坐标保持稳定，结构重绘阶段随后分配细节。

## 4. 结构简化与关键特征保护

### 4.1 首版算法组合

```text
工作分辨率归一化
  ↓
Guided Filter / Bilateral Filter 多尺度平滑
  ↓
SLIC 超像素
  ↓
语义、颜色、边界、重要性联合区域合并
  ↓
轮廓简化与特征锚点回填
  ↓
受约束网格栅格化
```

Guided Filter 基于局部线性模型，具备线性时间实现，并可将引导图结构传递到输出。Bilateral Filter 同时考虑空间距离与颜色距离，适合降低低对比摄影纹理。[Guided Image Filtering](https://doi.org/10.1109/TPAMI.2012.213)，[Bilateral Filtering](https://doi.org/10.1109/ICCV.1998.710815)

SLIC 在 CIELAB 与空间坐标上执行局部 k-means，直接控制超像素数量与紧致度。论文用边界召回、欠分割误差、速度和分割效果进行比较；紧致度参数 `m` 在 Lab 图像中可从 1 至 40 搜索。[SLIC](https://doi.org/10.1109/TPAMI.2012.120)

Real-time Video Abstraction 使用多轮 bilateral smoothing、DoG 边缘和软颜色量化，用户研究中抽象人脸命名速度与场景记忆表现均有提升。这支持“先压平低对比纹理，再强调关键轮廓”的方向。[Real-time video abstraction](https://doi.org/10.1145/1141911.1142018)

### 4.2 重要性地图

建议首版采用可解释组合：

```text
Importance =
  语义区域权重
+ 关键点高斯场
+ 主体边界权重
+ 局部对比权重
+ 用户标记权重
```

人物默认优先级：眼睛 > 嘴部 > 脸型与发型 > 鼻子 > 身体轮廓 > 衣服纹理 > 背景。

宠物默认优先级：眼睛与鼻子 > 耳朵 > 脸部轮廓 > 代表性花纹 > 身体姿态 > 毛发纹理 > 背景。

模型置信度决定约束强度。高置信度眼睛进入硬约束；低置信度耳尖进入软约束；用户点击的重点区域进入最高优先级硬约束。

### 4.3 区域合并目标

区域合并代价建议包含：

```text
MergeCost =
  区域平均 ΔE00
+ 公共边界强度
+ 语义标签差异
+ 重要性损失
+ 关键特征违反项
+ 合并后形状复杂度
```

首轮参数搜索：

- SLIC 数量：目标格数的 0.25、0.5、1.0 倍
- SLIC 紧致度：5、10、20
- 平滑半径：按目标单格在工作图中的像素宽度设置 0.5、1.0、1.5 倍
- 区域停止条件：合并后达到目标区域数、颜色误差阈值或关键约束阈值

### 4.4 受约束栅格化

每个目标格读取源区域覆盖率、重要性积分和特征约束。处理顺序如下：

1. 预留眼睛、嘴部、鼻子、耳朵和身份花纹的最小支撑格。
2. 以覆盖率分配主体大区域。
3. 以边界连续性修正轮廓格。
4. 将低重要性碎片合并到邻接大区域。
5. 检查对称特征、轮廓连通和一格长条。

这一步负责把连续图像区域转换成工艺合法的离散结构。SLIC 提供候选区域，最终网格由特征预算和拓扑约束决定。

Pixelated Image Abstraction 同时优化特征映射与有限调色板，为“结构和颜色联合决定”提供传统优化基线。Make Your Own Sprites 将 cell-aware 与 aliasing-aware 处理拆开，适合检验格子尺寸控制和边缘混叠。Deep Unsupervised Pixelization 通过 GridNet、PixelNet 与 DepixelNet 保持多尺度网格、锐利边缘和局部结构。SD-πXL 将输出表示为 `H × W × n` 张量，每格选择有限颜色或元素类别，并在官方项目中展示拼豆、积木马赛克与刺绣应用。

## 5. 色卡、颜色空间与色差

### 5.1 颜色空间

首版统一采用：

```text
sRGB 数值
  ↓ 反伽马
线性 RGB
  ↓ D65 矩阵
CIEXYZ
  ↓
CIELAB
  ↓
CIEDE2000
```

ICC 的 sRGB 注册信息给出 D65 白点 `x=0.3127, y=0.3290`。CIE 15:2018 汇总标准观察者、标准照明体、反射率参考、照明与观察条件、三刺激值、颜色空间和色差计算。[ICC sRGB](https://www.color.org/chardata/rgb/srgb.xalter)，[CIE Colorimetry, 4th Edition](https://cie.co.at/publications/colorimetry-4th-edition)

CIEDE2000 作为主色差。Sharma 等人的实现说明页提供 34 组 Lab 测试对、期望 ΔE00、MATLAB 与 Excel 实现，并说明公式中的数值连续性细节。后续实现以这 34 组数据作为强制单元测试。[CIEDE2000 paper](https://doi.org/10.1002/col.20070)，[作者测试数据](https://hajim.rochester.edu/ece/sites/gsharma/ciede2000/)

`colour-science/colour` 提供 CIEDE2000 与完整颜色转换，许可证为 BSD-3-Clause，适合作为 Python 研究基准和 TypeScript 实现的交叉验证来源。[Colour 文档](https://colour.readthedocs.io/en/develop/generated/colour.difference.delta_E_CIE2000.html)，[Colour 仓库](https://github.com/colour-science/colour)

### 5.2 厂家色卡现状

Artkal 官方 S-5mm 色卡发布 225 色 RGB PDF。PDF 明确说明 RGB 仅作参考，显示设备与实体豆颜色会产生差异，并建议以实体颜色为准。金、银、铜单列为材质标签，RGB 栏为空。[Artkal S 色卡页](https://www.artkalfusebeads.com/pages/s-color-chart)，[Artkal RGB PDF](https://cdn.shopify.com/s/files/1/1323/8195/files/S_MIDI_Beads_RGB_Color_Chart_2024.pdf?v=1744686607)

Hama 官方 Midi 色卡提供色号、名称和材料类别，覆盖 Solid、Translucent、Glow-in-the-dark、Shine、Neon 与 Mix。色卡同时说明颜色与尺寸可能存在变化，PDF 以视觉色块为主，数值 RGB 与 Lab 由实体测量建立。[Hama 色卡页](https://hama.dk/en/pages/colour-chart)，[Hama Midi PDF](https://cdn.shopify.com/s/files/1/0726/3771/0492/files/Midi_-_Colour_palette.pdf?v=1777369953)

由此形成两类字段：

```ts
interface MaterialColorProfile {
  brand: string
  colorId: string
  colorName: string
  materialClass: 'solid' | 'transparent' | 'metallic' | 'neon' | 'glow'
  displayRgb?: RGB
  measuredLab?: Lab
  sourceUrl: string
  sourceVersion: string
  measurementProfile?: {
    illuminant: 'D65'
    observer: '2deg'
    geometry: string
    instrument: string
    displaySide: string
    batch: string
    measuredAt: string
  }
}
```

### 5.3 实体校准方案

首版只建立一种展示面标准，建议采用豆面展示态（熨烫前），保持豆孔和表面质感。测量流程：

1. 每个色号制作紧密排列的测量样片，覆盖仪器光斑。
2. 在 D65 条件下使用 2° 标准观察者，记录仪器与测量几何。
3. 每个色号测量至少 3 个位置，取 Lab 中位数并记录离散度。
4. 记录品牌、色号、批次、购买日期和样片状态。
5. 透明、金属、夜光与霓虹独立测量和展示，默认照片色板只启用 Solid。
6. 使用 ColorChecker 或仪器自带白板执行每日校准。

第二阶段增加标准熨烫样片。产品预览可以在“豆面”和“熨烫面”两个配置间切换。

### 5.4 全局色板优化

K-means 适合生成理想颜色候选。Celebi 的实验显示，快速精确 k-means 配合合适初始化可成为高效颜色量化器；论文同时记录了视觉面积较小却语义重要的脸部区域容易被大区域颜色分布覆盖。这正是重要性加权的必要原因。[K-means color quantization](https://doi.org/10.1016/j.imavis.2010.10.002)

建议目标函数：

```text
ColorEnergy =
  Σ 区域面积 × 区域重要性 × ΔE00
+ 明暗顺序违反项
+ 相邻区域对比损失
+ 关键特征对比损失
+ 总颜色数量代价
+ 稀缺材料代价
```

流程先为每个语义区域生成固有色、亮部、中间色和阴影色候选，再从真实材料色号中联合选择。最终映射以区域为单位，网格单元沿用区域色号；局部单格颜色调整只服务于眼睛、高光和轮廓等明确特征。

## 6. 卡通化、扁平化与二分阴影

### 6.1 首版技术选择

光影阶段以 `StructurePlan` 的语义区域为单位处理。每个区域先估计固有色，再从区域内部的相对明暗生成二档或三档阴影：

```text
区域像素
  ↓
边缘保持平滑 / 纹理压缩
  ↓
区域固有色估计
  ↓
相对明暗残差
  ↓
二档或三档分层
  ↓
从真实材料色卡选择有序亮暗色组
```

推荐三种首版风格：

| 风格 | 阴影层数 | 结构倾向 | 配色倾向 |
|---|---:|---|---|
| 简洁平涂 | 2 | 大色块、轮廓清楚 | 色差较大、颜色较少 |
| 平衡 | 3 | 保留主要体积转折 | 固有色、亮部、阴影完整 |
| 高对比 | 2 至 3 | 强调五官与姿态 | 提升关键区域明暗差 |

### 6.2 纹理压缩方法

L0 Gradient Minimization 直接控制非零梯度数量，适合生成稀疏而清楚的主要边缘。Relative Total Variation 使用窗口内总变差与固有变差的比值区分结构和纹理，适合压缩毛发细丝、衣服纹理和背景重复纹理。[L0 Gradient Minimization](https://doi.org/10.1145/2024156.2024208)，[Relative Total Variation](https://doi.org/10.1145/2366145.2366158)

建议形成四条光影比较路线：

| 编号 | 方法 | 项目用途 |
|---|---|---|
| S0 | Guided Filter + 区域亮度分位数 | 首版快速基线 |
| S1 | L0 smoothing + 区域亮度分位数 | 强轮廓、低纹理候选 |
| S2 | RTV + 区域亮度分位数 | 长毛、布料与复杂背景候选 |
| S3 | White-box Cartoonization 中间表示 | 第二阶段学习型对照 |

White-box Cartoonization 将卡通外观拆成平滑表面、稀疏色块结构和高频纹理三类表示。这种分解与本项目的 `StructurePlan + ColorPlan` 接近，适合第二阶段作为教师模型或候选生成器。[Learning to Cartoonize Using White-Box Cartoon Representations](https://doi.org/10.1109/CVPR42600.2020.00811)

XDoG 适合作为补充轮廓证据。最终色块边界继续由主体轮廓、语义边界和关键特征约束共同决定。[XDoG](https://doi.org/10.1016/j.cag.2012.03.004)

### 6.3 固有色与光照分离

Intrinsic Images in the Wild 将图像分为 reflectance 与 shading，并指出真实场景中的自动分解仍具有较高难度。首版采用区域级近似，将完整 intrinsic 网络安排在第二阶段。[Intrinsic Images in the Wild](https://doi.org/10.1145/2601097.2601206)

每个语义区域 `r` 建议计算：

```text
A_r = 区域平滑后 Lab 中位色
B_r(x) = L*(x) - median(L*_r)
Q_r(x) = weighted_quantile_bin(B_r(x), K_r)
```

其中：

- `A_r` 表示区域固有色近似。
- `B_r(x)` 表示区域内部相对明暗。
- `K_r` 为 2 或 3，由风格、区域面积和目标网格尺寸决定。
- 权重来自 `ImportanceMap`、边界距离、镜面高光抑制和模型置信度。

Multi-scale Retinex 可作为明暗基底的对照方法，重点检查色偏、光晕和局部对比变化。[Multi-scale Retinex](https://doi.org/10.1109/83.597272)

### 6.4 材料阴影色组

阴影色选择同时满足：

1. 同一区域的 `L*` 严格有序。
2. 色相漂移位于风格允许范围。
3. 关键特征与邻域保持最低对比。
4. 同一材料类别内选择色号。
5. 全图颜色数量满足 `maxColors`。

建议为每个基础色维护候选关系：

```ts
interface ShadeRamp {
  baseColorId: string
  lightColorIds: readonly string[]
  shadowColorIds: readonly string[]
  hueShift: 'neutral' | 'warm-light-cool-shadow' | 'cool-light-warm-shadow'
  confidence: number
}
```

实体色卡完成测量后，`ShadeRamp` 由 `measuredLab`、区域语义和人工偏好共同校准。

## 7. 网格优化、孤立豆与轮廓美化

### 7.1 处理顺序

首版采用确定性规则与小范围局部搜索：

```text
关键特征单元锁定
  ↓
连通域与孤立豆整理
  ↓
一格宽长条检查
  ↓
2×2 对角拓扑检查
  ↓
轮廓阶梯与毛刺整理
  ↓
对称特征一致性调整
  ↓
受约束局部搜索
```

每次改色只从有限候选集合中选择：当前色、四邻域主色、所属区域色组和关键轮廓色。候选集合建议控制在 6 个以内。

### 7.2 连通性与拓扑

工艺指标以四邻域连通域为主，八邻域用于视觉连续性辅助判断。人物双眼、嘴部、鼻尖、宠物耳尖与身份花纹由 `FeatureConstraintMap` 指定保护状态。

建议规则：

- 1 格连通域：普通区域优先合并到能量最低的邻域色。
- 2 格连通域：结合区域重要性、边界证据和身份特征置信度决定保留或合并。
- 一格宽长条：长度达到 4 格后检查两侧颜色、原图边界与结构标签。
- 2×2 对角布局：检查两组对角色的语义与连通意图，选择轮廓连续性更高的布局。
- 轮廓毛刺：检查单格凸起、单格凹口和连续折返，按局部边界代价调整。

Depixelizing Pixel Art 重点处理方格中对角邻居的连接歧义，并通过拓扑连接保持细线结构。本项目借用其对角歧义判断，输出仍保持拼豆方格。[Depixelizing Pixel Art](https://doi.org/10.1145/1964921.1964994)

### 7.3 局部能量函数

```text
GridEnergy =
  原区域颜色代价
+ 边界一致性代价
+ 小连通域代价
+ 一格宽长条代价
+ 2×2 拓扑代价
+ 对称差异代价
+ 全图色号数量代价
+ 关键特征违反项
```

Graph Cut 的 alpha-expansion 适合一元项与度量型两两平滑项，并提供已知近似界。Label Costs 扩展可以直接惩罚解中出现的颜色种类数量。[Graph Cuts](https://doi.org/10.1109/34.969114)，[Label Costs](https://doi.org/10.1007/s11263-011-0437-z)

孤立域、长条、2×2 拓扑和关键特征属于高阶条件。首版先执行确定性规则，再对 3×3 或 5×5 小窗口进行局部搜索。Graph Cut 与 OR-Tools 小窗口整数优化进入对照实验。

### 7.4 确定性与回滚

每个局部调整记录：

```ts
interface GridEditRecord {
  cell: GridPoint
  fromColorId: string
  toColorId: string
  rule: string
  energyBefore: number
  energyAfter: number
  featurePriority: number
}
```

接受条件采用 `energyAfter < energyBefore`，平局按固定优先级处理。扫描顺序、候选顺序和随机种子写入算法版本元数据，保证同一输入稳定复现。

### 7.5 工具与许可证

| 工具 | 作用 | 当前许可判断 | 建议 |
|---|---|---|---|
| OpenCV | 连通域、形态学、滤波、颜色转换 | Apache-2.0 | 首版主工具 |
| scikit-image | SLIC、区域属性、轮廓与形态学实验 | BSD 系 | 研究与交叉验证 |
| OR-Tools | 小窗口整数优化 | Apache-2.0 | P1 对照 |
| PyMaxflow | Graph Cut 实现 | GPL | 商业版本保持隔离 |

## 8. 多候选生成与审美排序

### 8.1 三层排序结构

```text
第一层：硬条件过滤
  色号合法、关键特征完整、网格尺寸正确
第二层：规则评分
  辨识度、结构、配色、工艺、成本
第三层：偏好排序
  学习同一输入下候选 A 与候选 B 的人类选择
```

通用审美数据集与模型提供视觉质量先验。AVA 收集大规模美学评分，NIMA 预测评分分布，MUSIQ 在多尺度与原始分辨率上评估视觉质量。[AVA](https://doi.org/10.1109/CVPR.2012.6247954)，[NIMA](https://doi.org/10.1109/TIP.2018.2831899)，[MUSIQ](https://doi.org/10.1109/ICCV48922.2021.00510)

拼豆结果同时受辨识度、材料与制作复杂度约束，最终排序器采用项目内偏好数据训练。CLIP 视觉语言先验可作为候选特征，任务分数继续由拼豆偏好数据校准。[CLIP Look and Feel](https://doi.org/10.1609/aaai.v37i2.25353)

### 8.2 候选生成轴

每张输入建议生成 4 至 6 个候选，变化来自以下参数：

| 参数轴 | 候选值 |
|---|---|
| 结构细节预算 | 低、中、高 |
| 阴影层数 | 2、3 |
| 颜色数量 | 12、20、32 或尺寸对应上限 |
| 轮廓权重 | 柔和、平衡、清楚 |
| 对比度 | 柔和、标准、高对比 |
| 工艺复杂度 | 低、标准 |

候选差异需要集中在少数参数轴，便于解释用户选择并支持后续归因分析。

### 8.3 偏好数据协议

每一对候选来自同一输入图片、同一画布尺寸和同一材料色板。记录三类问题：

1. 主体辨识度更高的候选。
2. 整体观感更好的候选。
3. 更愿意实际制作的候选。

左、右位置随机交换，并允许平局。数据切分以原始输入图片为单位，同一图片的全部候选进入同一数据分区。该规则可以控制候选泄漏。

建议记录：

```ts
interface PairwisePreference {
  sourceImageId: string
  candidateAId: string
  candidateBId: string
  question: 'recognition' | 'aesthetic' | 'craft'
  choice: 'a' | 'b' | 'tie'
  leftRightOrder: 'ab' | 'ba'
  raterGroup: string
  createdAt: string
}
```

Pick-a-Pic 与 ImageReward 展示了利用真实用户成对选择训练图像排序模型的路径。两者面向文本生成图像，本项目采用其数据组织思想，并使用拼豆专属特征与问题设计。[Pick-a-Pic](https://doi.org/10.52202/075280-1594)，[ImageReward](https://doi.org/10.52202/075280-0700)

### 8.4 模型升级顺序

| 阶段 | 数据规模建议 | 模型 | 输入 |
|---|---:|---|---|
| R0 | 0 至 500 对 | 手工权重 | 自动指标 |
| R1 | 500 至 2,000 对 | Bradley-Terry / 逻辑回归 | 自动指标与风格参数 |
| R2 | 2,000 至 10,000 对 | XGBoost pairwise | 自动指标、区域统计、风格参数 |
| R3 | 10,000 对以上 | 冻结视觉编码器 + 小型排序头 | 网格图、原图、自动指标 |

这些数量属于工程启动阈值，真实学习曲线用于调整。Bradley-Terry 模型直接描述成对比较概率：

```text
P(A > B) = sigmoid(score(A) - score(B))
```

[Bradley-Terry paired comparison](https://doi.org/10.2307/2334029)

### 8.5 评估与偏差控制

排序器评估指标：

- 成对选择准确率
- Kendall tau 排序相关
- 按人物、宠物、插画分组的胜率
- 按画布尺寸分组的胜率
- 平局校准与置信度校准
- 推荐项被用户替换的比例
- 用户后续修改单元数量

偏差控制：左右随机、风格出现次数均衡、重复哨兵对、来源图片级切分、单个评分者贡献上限和分类型报告。

## 9. 小程序与服务端计算分配

### 9.1 微信小程序能力现状

微信官方文档显示：

- Worker 在独立线程与全局上下文运行，通过消息复制传输数据，最大并发数量为 1。
- `wx.request`、`wx.uploadFile` 与 `wx.downloadFile` 最大并发数量为 10，默认网络超时为 60 秒。
- 小程序进入后台后，持续超过 5 秒的网络请求会收到中断回调。
- `wx.compressImage` 支持质量和目标宽高，iOS 的图片压缩格式范围以 JPG 为主。
- 小程序 AI 推理能力处于 Beta，接收 ONNX 模型，并支持 CPU 与部分 NPU 路径；官方算子页显示 GPU 推理开放状态仍在推进。
- 官方 INT8 示例同时支持 QAT 与 PTQ，MobileNetV2 在 iPhone 13 Pro Max 的示例耗时从约 10 ms 降到约 5 ms。

来源：[Worker](https://developers.weixin.qq.com/miniprogram/dev/framework/workers.html)，[网络](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)，[图片压缩](https://developers.weixin.qq.com/miniprogram/dev/api/media/image/wx.compressImage.html)，[AI 推理](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/inference/tutorial.html)，[INT8 量化](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/inference/tutorial_int8.html)，[算子列表](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/inference/supports.html)

### 9.2 首版部署建议

| 位置 | 工作 |
|---|---|
| 小程序主线程 | 选择图片、参数输入、上传进度、结果展示 |
| 小程序 Worker | 图片方向修正、尺寸读取、轻量哈希、预览级统计 |
| 服务端 | 主体分割、关键点、尺寸评分、结构简化、配色、网格优化、多候选排序 |
| 端侧 AI 实验 | 图片类型分类、质量预检、轻量人脸存在性判断 |

首版采用服务端主流程。人物与宠物模型、多个画布候选、结构优化和偏好排序共享一次标准化输入，便于统一版本、缓存与性能测量。端侧 ONNX 路线在 P1 阶段评估设备覆盖、算子兼容、模型体积与精度。

### 9.3 任务与缓存

建议任务键：

```text
SHA256(标准化图片)
+ algorithmVersion
+ paletteVersion
+ canvasOptions
+ styleOptions
+ modelVersions
```

同一任务键直接复用理解结果和候选结果。多尺寸、多风格候选共享主体分割、关键点与大部分区域统计。

### 9.4 性能目标

以下数值属于首轮工程目标：

| 阶段 | P50 | P95 |
|---|---:|---:|
| 输入解码与标准化 | 0.2 s | 0.5 s |
| 人物或宠物理解 | 1.5 s | 4.0 s |
| 三尺寸结构与配色候选 | 2.5 s | 6.0 s |
| 网格优化与排序 | 0.5 s | 1.5 s |
| 服务端总耗时 | 5.0 s | 12.0 s |

输入长边建议先归一化到 1,280 至 1,600 像素，模型推理使用各自固定输入尺寸，目标网格阶段只处理 32、48、64 的离散数据。性能报告同时记录 CPU 型号、GPU 型号、并发数、模型版本和候选数量。

## 10. 最小验证实验

### 实验 E1：人物理解

- 样本：人物 24 张
- 输出：478 点、六类人物掩码、置信度
- 检查：眼口关键点、头发边界、脸与衣服分离、遮挡稳定性
- 通过条件：人工抽查中主要五官落点稳定，关键点到网格映射复现一致

### 实验 E2：宠物理解

- 样本：猫狗 24 张
- 输出：主体掩码、17 点、耳朵候选、花纹候选
- 检查：正脸、侧脸、垂耳、长毛、遮挡和小主体
- 通过条件：眼鼻三角稳定；耳朵与主要花纹获得候选区域；置信度能区分高风险样本

### 实验 E3：尺寸规划

- 样本：全部 60 张
- 输出：32、48、64 三档评分和 FeatureBudget
- 检查：关键点碰撞、主体完整度、构图平衡、豆数成本
- 通过条件：推荐理由可追溯到具体特征格数和构图指标

### 实验 E4：结构简化

- 对比：A1、A2、A3
- 参数：SLIC 数量、紧致度、平滑半径、合并阈值
- 检查：关键特征、轮廓连续、碎片、长条、背景压缩
- 通过条件：A3 的关键特征碰撞与工艺噪声达到第一轮目标

### 实验 E5：色卡与色差

- 校验：CIEDE2000 官方作者页 34 组测试数据
- 色卡：Artkal 官方 RGB 参考表 + 20 色实体小样首轮测量
- 对比：RGB 欧氏距离、ΔE76、ΔE00、区域全局优化
- 通过条件：公式测试全量通过；人工比较中 ΔE00 与全局优化获得更高配色偏好

### 实验 E6：光影与扁平化

- 样本：人物、宠物、插画各 8 张
- 对比：S0、S1、S2、S3
- 检查：区域亮暗顺序、跨语义区域泄漏、色偏、光晕、关键特征对比
- 通过条件：至少一条区域级路线在观感盲评中胜过直接亮度量化，并保持关键特征完整

### 实验 E7：网格局部美化

- 样本：全部 60 张的 A3 候选
- 对比：原始网格、规则整理、规则加局部搜索
- 检查：孤立豆、小连通域、长条、2×2 对角歧义、轮廓折返、特征违反次数
- 通过条件：工艺噪声达到首轮下降目标，关键区域违反次数保持为零或进入人工复核

### 实验 E8：候选排序

- 数据：同图候选成对选择，按原始图片划分训练、验证和测试
- 对比：规则权重、Bradley-Terry、XGBoost pairwise、视觉特征排序头
- 检查：选择准确率、Kendall tau、分类型胜率、置信度校准
- 通过条件：学习型排序器在独立图片测试集上胜过规则权重，并保持分类型表现稳定

### 实验 E9：部署与性能

- 设备：两档手机、小程序开发工具、CPU 服务端与候选 GPU 服务端
- 工作量：32、48、64 三尺寸与 4、6 个候选
- 检查：端到端耗时、峰值内存、缓存命中、失败恢复、后台切换行为
- 通过条件：P50 与 P95 达到首轮工程目标，算法版本与缓存键保持一致

## 11. 技术选择与实施顺序

| 优先级 | 工作 | 产物 |
|---:|---|---|
| P0 | 固定 60 图评估集和 A0/A1/A2 | 可重复比较基准 |
| P0 | 接入人物关键点与六类分割 | `UnderstandingResult` 人物版 |
| P0 | 接入宠物主体与 RTMPose | `UnderstandingResult` 宠物版 |
| P0 | 实现 32/48/64 尺寸评分 | `CanvasPlan` 与 `FeatureBudget` |
| P0 | Guided/SLIC/区域合并/栅格约束实验 | `StructurePlan` |
| P0 | CIEDE2000 测试与 Artkal 参考色卡导入 | 颜色基础基准 |
| P0 | 区域固有色与二至三档阴影 | `ShadeRamp` 与光影基线 |
| P0 | 连通域、长条、2×2 拓扑与局部搜索 | 确定性网格优化器 |
| P0 | 规则候选评分与成对选择记录 | `CandidateEvaluation` 与偏好数据 |
| P0 | 服务端主流程、缓存键与阶段耗时 | 算法服务运行规范 |
| P1 | 20 色实体测量样片 | `measuredLab` 首批数据 |
| P1 | CatFLW/DogFLW 专用模型研究 | 猫狗耳朵与面部锚点增强 |
| P1 | 全局材料色板优化 | `ColorPlan` |
| P1 | L0、RTV 与 XDoG 对照 | 纹理压缩与轮廓证据 |
| P1 | Bradley-Terry / XGBoost 排序 | 第一版学习型排序器 |
| P1 | 小程序 ONNX INT8 轻模型实验 | 端侧能力报告 |
| P2 | White-box / intrinsic 教师模型 | 学习型光影候选 |
| P2 | 冻结视觉编码器与排序头 | 项目偏好模型 |

算法入口 `PatternAlgorithm.generate(request)` 保持稳定。内部新增阶段数据即可，产品侧继续使用同一入口。

## 12. 许可证与发布安排

| 项目 | 许可或状态 | 使用建议 |
|---|---|---|
| MediaPipe | Apache-2.0 | 首版人物模型与分割 |
| MMPose | Apache-2.0 | 首版宠物推理框架 |
| AP-10K 仓库 | CC BY 4.0；源图片来自多套数据 | 研究与模型验证，发布前逐项复核来源 |
| CatFLW / DogFLW | CC BY-NC 4.0 | 研究验证与方法比较 |
| Colour | BSD-3-Clause | Python 颜色基准 |
| OpenCV | Apache-2.0 | 首版滤波、颜色与连通域工具 |
| scikit-image | BSD 系 | SLIC、区域属性与研究对照 |
| OR-Tools | Apache-2.0 | 小窗口整数优化实验 |
| ONNX Runtime | MIT | 服务端轻模型推理候选 |
| XGBoost | Apache-2.0 | P1 偏好排序器候选 |
| PyMaxflow | GPL | 研究隔离与许可证专项复核 |
| Make Your Own Sprites 官方代码与数据 | 非商业科研许可 | 方法研究和内部对照；商业产品另行取得书面授权 |
| White-box Cartoonization 实现 | 仓库条款按版本复核 | 论文方法研究与教师候选 |
| CLIP / DINO 类视觉权重 | 模型与权重按版本复核 | P2 排序特征候选 |
| Artkal / Hama 官方色卡 | 厂家发布资料，数据再分发采用单独授权 | 内部参考；公开品牌色库前取得授权或发布自测数据 |

商业版本的训练图片、品牌色号和模型权重分别建立来源清单。每个条目记录来源、许可、版本、修改和归属说明。

## 参考资料

### 评估与尺寸

- Rubinstein, M., Gutiérrez, D., Sorkine, O., & Shamir, A. A comparative study of image retargeting. https://doi.org/10.1145/1882261.1866186
- Liang, Y., Liu, Y.-J., & Gutiérrez, D. Objective Quality Prediction of Image Retargeting Algorithms. https://doi.org/10.1109/TVCG.2016.2517641
- Rubinstein, M., Shamir, A., & Avidan, S. Multi-operator media retargeting. https://doi.org/10.1145/1531326.1531329
- Kopf, J., Shamir, A., & Peers, P. Content-adaptive image downscaling. https://doi.org/10.1145/2508363.2508370
- Weber, N. et al. Rapid, detail-preserving image downscaling. https://doi.org/10.1145/2980179.2980239
- Ponomarenko, N. et al. Image database TID2013. https://doi.org/10.1016/j.image.2014.10.009

### 图像理解与结构

- Grishchenko, I. et al. Attention Mesh. https://arxiv.org/abs/2006.10962
- Yu, H. et al. AP-10K. https://arxiv.org/abs/2108.12617
- Jiang, T. et al. RTMPose. https://arxiv.org/abs/2303.07399
- Martvel, G. et al. Automated Detection of Cat Facial Landmarks. https://doi.org/10.1007/s11263-024-02006-w
- Martvel, G. et al. Dog facial landmarks detection and its applications for facial analysis. https://doi.org/10.1038/s41598-025-07040-3
- Achanta, R. et al. SLIC Superpixels. https://doi.org/10.1109/TPAMI.2012.120
- He, K., Sun, J., & Tang, X. Guided Image Filtering. https://doi.org/10.1109/TPAMI.2012.213
- Tomasi, C., & Manduchi, R. Bilateral Filtering. https://doi.org/10.1109/ICCV.1998.710815
- Winnemöller, H., Olsen, S. C., & Gooch, B. Real-time video abstraction. https://doi.org/10.1145/1141911.1142018

### 像素化与离散生成

- Gerstner, T. et al. Pixelated image abstraction with integrated user constraints. https://doi.org/10.1016/j.cag.2012.12.007
- Han, C. et al. Deep unsupervised pixelization. https://doi.org/10.1145/3272127.3275082
- Wu, Z. et al. Make Your Own Sprites. https://doi.org/10.1145/3550454.3555482
- Binninger, A., & Sorkine-Hornung, O. SD-πXL: Generating Low-Resolution Quantized Imagery via Score Distillation. https://doi.org/10.1145/3680528.3687570
- Make Your Own Sprites official implementation and license. https://github.com/WuZongWei6/Pixelization

### 颜色

- Sharma, G., Wu, W., & Dalal, E. N. The CIEDE2000 Color-Difference Formula. https://doi.org/10.1002/col.20070
- Celebi, M. E. Improving the performance of k-means for color quantization. https://doi.org/10.1016/j.imavis.2010.10.002
- CIE. Colorimetry, 4th Edition. https://cie.co.at/publications/colorimetry-4th-edition
- ICC. sRGB registry. https://www.color.org/chardata/rgb/srgb.xalter

### 光影与扁平化

- Xu, L. et al. Image Smoothing via L0 Gradient Minimization. https://doi.org/10.1145/2024156.2024208
- Xu, L. et al. Structure Extraction from Texture via Relative Total Variation. https://doi.org/10.1145/2366145.2366158
- Jobson, D. J. et al. A Multiscale Retinex for Bridging the Gap Between Color Images and Human Observation. https://doi.org/10.1109/83.597272
- Bell, S. et al. Intrinsic Images in the Wild. https://doi.org/10.1145/2601097.2601206
- Wang, X., & Yu, J. Learning to Cartoonize Using White-Box Cartoon Representations. https://doi.org/10.1109/CVPR42600.2020.00811
- Winnemöller, H. et al. XDoG. https://doi.org/10.1016/j.cag.2012.03.004

### 网格与图优化

- Boykov, Y. et al. Fast Approximate Energy Minimization via Graph Cuts. https://doi.org/10.1109/34.969114
- Delong, A. et al. Fast Approximate Energy Minimization with Label Costs. https://doi.org/10.1007/s11263-011-0437-z
- Kopf, J., & Lischinski, D. Depixelizing Pixel Art. https://doi.org/10.1145/1964921.1964994

### 审美与偏好

- Bradley, R. A., & Terry, M. E. Rank Analysis of Incomplete Block Designs: The Method of Paired Comparisons. https://doi.org/10.2307/2334029
- Murray, N. et al. AVA: A Large-Scale Database for Aesthetic Visual Analysis. https://doi.org/10.1109/CVPR.2012.6247954
- Talebi, H., & Milanfar, P. NIMA: Neural Image Assessment. https://doi.org/10.1109/TIP.2018.2831899
- Ke, J. et al. MUSIQ: Multi-scale Image Quality Transformer. https://doi.org/10.1109/ICCV48922.2021.00510
- Wang, J. et al. Exploring CLIP for Assessing the Look and Feel of Images. https://doi.org/10.1609/aaai.v37i2.25353
- Kirstain, Y. et al. Pick-a-Pic. https://doi.org/10.52202/075280-1594
- Xu, J. et al. ImageReward. https://doi.org/10.52202/075280-0700

### 小程序与工具

- 微信小程序多线程 Worker. https://developers.weixin.qq.com/miniprogram/dev/framework/workers.html
- 微信小程序网络使用说明. https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html
- 微信小程序图片压缩. https://developers.weixin.qq.com/miniprogram/dev/api/media/image/wx.compressImage.html
- 微信小程序 AI 推理能力. https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/inference/tutorial.html
- 微信小程序 INT8 量化. https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/inference/tutorial_int8.html
- 微信小程序 AI 算子支持列表. https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/inference/supports.html
- OpenCV Python package. https://pypi.org/project/opencv-python/
- scikit-image. https://pypi.org/project/scikit-image/
- OR-Tools. https://pypi.org/project/ortools/
- ONNX Runtime. https://pypi.org/project/onnxruntime/

Scite 检查：主体理解、结构与颜色核心 DOI 已完成题录与引用语境查询。Graph Cuts、Label Costs 与 Depixelizing Pixel Art 完成全文摘要和引用语境核对，`editorialNotices` 为空列表。随后 Scite 免费额度耗尽，其余新增论文采用 Crossref、OpenAlex、arXiv 与官方文档交叉核对。

## 证据表

| 专题 | 来源 | 原文锚点 | 本项目判断 | Scite 状态 |
|---|---|---|---|---|
| 人工评估 | RetargetMe, 10.1145/1882261.1866186 | 八种方法、大规模用户比较、自动距离与人类排序 | 成对盲评作为主验收 | 题录、摘要、引用语境完成 |
| 客观评分 | Liang et al., 10.1109/TVCG.2016.2517641 | 五类因素、37 张 RetargetMe 图片、17 张新增图片 | 自动指标分结构、伪影、构图和对称性 | 全文摘录、引用语境完成 |
| 细节下采样 | Kopf et al., 10.1145/2508363.2508370 | 自适应采样核、线条清晰与连接 | A2 强基线 | 题录、摘要、引用语境完成 |
| 快速下采样 | Weber et al., 10.1145/2980179.2980239 | 局部差异加权、用户研究、细线变粗与混叠 | 用于检验高频细节贡献 | 全文摘录、引用语境完成 |
| 人脸关键点 | Attention Mesh, arXiv:2006.10962 | 478 点、眼唇区域头、Pixel 2XL 性能 | 人物首版关键点 | 开放论文全文核对 |
| 人物分割 | MediaPipe Image Segmenter | 六类人物掩码、置信度、Pixel 6 延迟 | 人物首版语义区域 | 官方文档核对 |
| 宠物姿态 | AP-10K, arXiv:2108.12617 | 10,015 图、54 物种、17 点、7:1:2 | 宠物首版姿态和脸部三角形 | 开放论文全文核对 |
| 宠物推理 | MMPose RTMPose AP-10K | 256×256、AP 0.722、公开权重 | 服务端宠物基线 | 官方配置核对 |
| 狗脸锚点 | 10.1038/s41598-025-07040-3 | 46 点、耳部误差、垂耳误差 | 耳朵独立保护 | 全文摘录、引用语境完成 |
| 超像素 | SLIC, 10.1109/TPAMI.2012.120 | Lab+空间距离、边界召回、欠分割误差 | 结构候选区域 | 全文摘录、引用语境完成 |
| 边缘平滑 | Guided Filter, 10.1109/TPAMI.2012.213 | 局部线性模型、线性时间 | 主平滑候选 | 题录、摘要、引用语境完成 |
| 图像抽象 | 10.1145/1141911.1142018 | bilateral、DoG、软量化、用户研究 | 低对比纹理压缩 | 题录、摘要、引用语境完成 |
| 像素化抽象 | 10.1016/j.cag.2012.12.007 | 特征映射与有限调色板联合优化 | 传统优化强对照 | Crossref 题录与 Princeton 项目页核对 |
| 学习型像素化 | 10.1145/3272127.3275082 | GridNet、PixelNet、DepixelNet、锐利边缘 | 第二阶段模型对照 | Crossref 题录与作者项目页核对 |
| 格子控制 | 10.1145/3550454.3555482 | cell-aware、aliasing-aware、cell size 控制 | 第二阶段模型对照 | Crossref 摘要与官方仓库核对 |
| 离散实体生成 | 10.1145/3680528.3687570 | `H × W × n`、有限元素、beading 与 embroidery | 离线教师与上限参考 | Crossref 题录与 ETH 项目页核对 |
| 色差 | CIEDE2000, 10.1002/col.20070 | 实现说明、测试数据、连续性细节 | 主色差与 34 组单测 | 题录完成，作者页交叉核对 |
| Artkal 色卡 | 官方 S-5mm RGB PDF | 225 色、显示参考声明、特殊材质 | 研究参考色 + 实测色 | 官方页面与 PDF 核对 |
| Hama 色卡 | 官方 Midi PDF | 色号、名称、材质分类、颜色变化声明 | 实测前的编号目录 | 官方页面与 PDF 核对 |
| L0 平滑 | 10.1145/2024156.2024208 | 稀疏梯度、主要边缘保持 | 强轮廓纹理压缩候选 | Crossref 与论文题录核对 |
| RTV | 10.1145/2366145.2366158 | 结构与纹理变化度量、结构提取 | 长毛与重复纹理候选 | Crossref 摘要核对 |
| Intrinsic 分解 | 10.1145/2601097.2601206 | reflectance/shading、真实场景挑战 | 首版采用区域级近似 | Crossref 摘要核对 |
| White-box 卡通化 | 10.1109/CVPR42600.2020.00811 | 表面、结构、纹理三类表示 | 第二阶段教师候选 | Crossref 题录核对 |
| Graph Cut | 10.1109/34.969114 | alpha-expansion、度量平滑项、近似界 | 两两平滑项对照 | Scite 摘要与引用语境完成 |
| Label Costs | 10.1007/s11263-011-0437-z | 标签数量代价与空间平滑 | 全图色号数量代价 | Scite 摘要与引用语境完成 |
| 像素拓扑 | 10.1145/1964921.1964994 | 对角连接歧义与特征连通 | 2×2 拓扑检查 | Scite 摘要与引用语境完成 |
| 审美数据 | AVA, 10.1109/CVPR.2012.6247954 | 大规模主观美学评分 | 通用视觉先验参考 | Crossref 题录核对 |
| 审美评分 | NIMA, 10.1109/TIP.2018.2831899 | 预测评分分布 | 通用质量特征候选 | Crossref 题录核对 |
| 多尺度质量 | MUSIQ, 10.1109/ICCV48922.2021.00510 | 原始尺寸、多尺度质量表示 | 候选视觉特征参考 | Crossref 与 OpenAlex 核对 |
| 成对偏好 | Bradley-Terry, 10.2307/2334029 | 成对选择概率模型 | R1 排序器 | Crossref 题录核对 |
| 用户偏好数据 | Pick-a-Pic / ImageReward | 真实用户成对选择、排序模型 | 项目偏好数据协议参考 | Crossref 与 OpenAlex 摘要核对 |
| 小程序 Worker | 微信官方文档 | 独立线程、复制传输、最大并发 1 | 轻量预处理与统计 | 官方页面核对 |
| 小程序网络 | 微信官方文档 | 默认 60 秒、请求并发 10、后台 5 秒中断 | 服务端任务设计 | 官方页面核对 |
| 小程序 AI | 微信官方文档 | ONNX、INT8、设备算子差异 | P1 端侧轻模型实验 | 官方页面核对 |

所有证据查询日期为 2026-08-15。论文与官方资料的结论分别写入对应专题，项目权重、阈值和通过条件均标记为首轮工程设定。
