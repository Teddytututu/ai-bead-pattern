# 拼豆生成算法第一批调研

查询日期：2026-08-15

## 结论

第一版算法建议采用下面这套组合：

```text
人物：MediaPipe Face Landmarker + SelfieMulticlass
宠物：DeepLab-v3 主体掩码 + RTMPose-m / AP-10K
尺寸：32 / 48 / 64 离散候选搜索
结构：边缘保持平滑 + SLIC + 受约束区域合并 + 受约束栅格化
颜色：sRGB → CIELAB(D65) → CIEDE2000 → 全局材料色板优化
评估：自动诊断指标 + 随机双盲成对选择
```

人物路线具备现成模型、细密五官锚点和人物多类分割。宠物路线先用通用身体关键点稳定姿态和脸部三角形，再从主体轮廓与局部色块提取耳朵、脸部花纹等身份特征。猫狗面部专用数据适合第二阶段训练，商业训练数据采用自有或单独授权图片池。

尺寸规划采用候选评分，避免直接套用 seam carving 改变脸型和身体比例。结构阶段先分配关键特征格数，再合并摄影纹理。颜色阶段同时维护屏幕参考色与实体测量色，金属、透明、夜光等材料独立成特殊色组。

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

## 6. 最小验证实验

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

## 7. 技术选择与实施顺序

| 优先级 | 工作 | 产物 |
|---:|---|---|
| P0 | 固定 60 图评估集和 A0/A1/A2 | 可重复比较基准 |
| P0 | 接入人物关键点与六类分割 | `UnderstandingResult` 人物版 |
| P0 | 接入宠物主体与 RTMPose | `UnderstandingResult` 宠物版 |
| P0 | 实现 32/48/64 尺寸评分 | `CanvasPlan` 与 `FeatureBudget` |
| P0 | Guided/SLIC/区域合并/栅格约束实验 | `StructurePlan` |
| P0 | CIEDE2000 测试与 Artkal 参考色卡导入 | 颜色基础基准 |
| P1 | 20 色实体测量样片 | `measuredLab` 首批数据 |
| P1 | CatFLW/DogFLW 专用模型研究 | 猫狗耳朵与面部锚点增强 |
| P1 | 全局材料色板优化 | `ColorPlan` |

算法入口 `PatternAlgorithm.generate(request)` 保持稳定。内部新增阶段数据即可，产品侧继续使用同一入口。

## 8. 许可证与发布安排

| 项目 | 许可或状态 | 使用建议 |
|---|---|---|
| MediaPipe | Apache-2.0 | 首版人物模型与分割 |
| MMPose | Apache-2.0 | 首版宠物推理框架 |
| AP-10K 仓库 | CC BY 4.0；源图片来自多套数据 | 研究与模型验证，发布前逐项复核来源 |
| CatFLW / DogFLW | CC BY-NC 4.0 | 研究验证与方法比较 |
| Colour | BSD-3-Clause | Python 颜色基准 |
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

### 颜色

- Sharma, G., Wu, W., & Dalal, E. N. The CIEDE2000 Color-Difference Formula. https://doi.org/10.1002/col.20070
- Celebi, M. E. Improving the performance of k-means for color quantization. https://doi.org/10.1016/j.imavis.2010.10.002
- CIE. Colorimetry, 4th Edition. https://cie.co.at/publications/colorimetry-4th-edition
- ICC. sRGB registry. https://www.color.org/chardata/rgb/srgb.xalter

Scite 检查：以上有 DOI 的核心论文均完成题录与引用语境查询，返回的 `editorialNotices` 为空列表。部分 ACM 与 IEEE 原文采用出版社访问，方法结论同时由摘要、开放稿或作者稿交叉核对。

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
| 色差 | CIEDE2000, 10.1002/col.20070 | 实现说明、测试数据、连续性细节 | 主色差与 34 组单测 | 题录完成，作者页交叉核对 |
| Artkal 色卡 | 官方 S-5mm RGB PDF | 225 色、显示参考声明、特殊材质 | 研究参考色 + 实测色 | 官方页面与 PDF 核对 |
| Hama 色卡 | 官方 Midi PDF | 色号、名称、材质分类、颜色变化声明 | 实测前的编号目录 | 官方页面与 PDF 核对 |

所有证据查询日期为 2026-08-15。论文与官方资料的结论分别写入对应专题，项目权重、阈值和通过条件均标记为首轮工程设定。
