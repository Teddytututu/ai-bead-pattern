# AI 拼豆图纸生成算法 V2 详细升级方案

## 一、方案定位

### 1. 当前版本的准确定位

当前 `pattern-core` 已经具备一个工程结构较完整的确定性算法：

* RGBA 图片输入；
* 固定/自动画布；
* 面积缩放与重要度引导采样；
* CIELAB 与 CIEDE2000 色差；
* 有限材料色板选择；
* 最近色号分配；
* 邻域颜色一致性优化；
* 小连通域、孤立格、细条和局部拓扑整理；
* 多风格候选与规则评分；
* 材料统计和制作错误适应接口。

但当前主算法仍然是 `DeterministicPatternAlgorithm`，视觉模型只通过 `ImageAnalysis` 预留了接口；`ai-gateway` 还没有真正的模型服务实现。

因此，当前版本更准确的名称应该是：

> **结构感知的拼豆量化与网格整理基线**

而不是：

> **已经完成的 AI 审美重绘算法**

### 2. V2 的核心目标

V2 不再把问题定义为：

> 如何把照片缩成一个有限色号网格？

而改成：

> 如何先理解并重组画面，再在有限网格、有限材料色号和制作约束下，重新绘制一张具有辨识度、审美和可制造性的拼豆图？

目标流程为：

```text
输入图片
  ↓
图像理解
  ↓
构图与信息容量规划
  ↓
关键特征约束
  ↓
结构重组与大色块规划
  ↓
明暗角色设计
  ↓
全局材料配色
  ↓
离散网格联合优化
  ↓
像素簇与轮廓美化
  ↓
多候选排序
  ↓
图纸、色号、材料和制作指导
```

### 3. V2 不做什么

第一阶段明确不做以下事情：

* 不使用一个 Diffusion 模型直接生成最终拼豆图；
* 不让多模态大模型逐格决定色号；
* 不在缺少训练数据时直接训练端到端“审美模型”；
* 不同时覆盖人物、宠物、风景、建筑、复杂群像的所有情况；
* 不优先开发“拼错以后自动改图”的制作适应功能；
* 不推翻当前确定性核心和材料统计接口。

原因是最终输出必须严格满足：

* 固定网格；
* 合法材料色号；
* 色数限制；
* 硬关键特征约束；
* 可重复生成；
* 可解释修改；
* 制作成本限制。

这些约束更适合由规划、离散优化和确定性算法负责，视觉模型主要负责“看懂图片”。

---

# 二、研究依据与技术取舍

## 1. Pixelated Image Abstraction：结构与颜色不能分开看

PIA 指出，低分辨率像素化不能只依靠最近邻或普通降采样；它同时优化高分辨率特征到低分辨率输出的映射，以及有限调色板，从而减少细节丢失和模糊。([Pixl][1])

对本项目的直接启发是：

> 重要特征不能只是获得更高采样权重，还要能够在低分辨率画布中争取更多空间。

所以 V2 要从“重要度加权采样”升级到：

* 特征资源预算；
* 结构区域合并；
* 允许小范围空间位移；
* 关键特征模板搜索；
* 结构与颜色交替优化。

## 2. Make Your Own Sprites：拆开处理格子结构与边缘

MYOS 将 cell structure 和 anti-aliasing 处理拆成不同阶段，说明“格子结构”和“边缘清理”不应该由同一个黑箱模型一次完成。其官方代码支持可控 cell size，但许可限定于非商业科研使用，因此适合作为研究基线，不能直接用于商业产品。([GitHub][2])

对本项目的启发是：

> `StructurePlan` 和 `ClusterRefinement` 必须分开。

先决定结构和区域，再处理孤立格、毛刺、阶梯和细条。

## 3. SD-πXL：最终输出应被建模成离散类别网格

SD-πXL 将结果表示为 (H \times W \times n)，即每个网格位置从有限的 (n) 个颜色或元素中选择一个，并使用 Gumbel-softmax 保持可微性；论文还直接展示了 beading、刺绣和积木马赛克等制作应用。([互动几何实验室][3])

这支持本项目继续坚持：

> 最终预测对象不是任意 RGB，而是材料色号类别。

但 SD-πXL 更适合作为离线质量上限或教师方法，不适合微信小程序的在线主流程。

## 4. 视觉理解应优先复用成熟预训练模型

人物方向可以使用 MediaPipe Face Landmarker，它能够输出每张脸的 478 个三维关键点，并提供眼睛、嘴唇、面部轮廓等连接定义。([Google for Developers][4])

主体分割可以采用两类能力：

* BiRefNet 一类自动前景分割模型，用于快速生成主体 mask；
* SAM 2 一类可提示分割模型，用于用户点击修正和复杂边缘 refinement。([arXiv][5])

第一阶段不建议自研人脸模型，也不建议承诺通用宠物关键点模型。

---

# 三、目标系统架构

## 1. 运行时分层

```text
微信小程序 / Web
  │
  ├─ 图片方向修正
  ├─ 图片压缩
  ├─ 用户裁剪
  ├─ 主体/关键点手动修正
  └─ 图纸查看与编辑
          │
          ▼
services/ai-gateway
  │
  ├─ 图片类型识别
  ├─ 主体分割
  ├─ 人脸与人体关键点
  ├─ 语义区域
  ├─ 建议裁剪
  └─ 分析置信度
          │
          ▼
packages/pattern-core
  │
  ├─ CanvasPlanner
  ├─ FeatureConstraintBuilder
  ├─ StructurePlanner
  ├─ ValuePlanner
  ├─ PalettePlanner
  ├─ GridOptimizer
  ├─ ClusterRefiner
  └─ CandidateRanker
          │
          ▼
拼豆图纸 / 材料统计 / 编辑记录 / 质量指标
```

### 分工原则

**AI 服务负责：**

* 识别主体；
* 找关键点；
* 判断语义区域；
* 输出置信度；
* 提供建议，而不是直接决定最终色号。

**`pattern-core` 负责：**

* 固定网格；
* 特征约束；
* 材料色号合法性；
* 结构和配色优化；
* 工艺整理；
* 确定性与可重复性。

---

# 四、V2 阶段化数据结构

当前 `ImageAnalysis` 已经有主体 mask、语义区域、关键点、重要度和建议裁剪，这是一个良好基础。

但需要继续增加真正的阶段化中间表示。

## 1. CanvasPlan

```ts
export interface CanvasPlan {
  id: string
  size: GridSize
  crop: CropRect
  occupancyMode: 'full-frame' | 'subject-shape' | 'solid-background'
  subjectCoverage: number
  estimatedBeads: number
  estimatedWidthMm?: number
  estimatedHeightMm?: number
  featureBudgets: readonly FeatureBudget[]
  score: CanvasPlanScore
}
```

用于描述：

* 选择多大画布；
* 如何裁剪；
* 主体占多少；
* 哪些区域留空；
* 每个关键特征获得多少格；
* 制作成本是多少。

## 2. FeatureBudget

```ts
export interface FeatureBudget {
  featureId: string
  kind: LandmarkKind
  minimumCells: number
  preferredCells: number
  maximumCells: number
  minimumContrast: number
  allowedShiftCells: number
  symmetryGroup?: string
  confidence: number
}
```

它不表示最终画法，只表示该特征在当前画布下可使用多少表达资源。

## 3. FeatureConstraint

```ts
export interface FeatureConstraint {
  id: string
  kind: LandmarkKind
  sourceCenter: readonly [number, number]
  targetCenter: readonly [number, number]
  candidateTemplates: readonly string[]
  minimumCells: number
  maximumCells: number
  allowedShiftCells: number
  minimumContrastDeltaE: number
  hard: boolean
  symmetryGroup?: string
}
```

它是真正用于优化的约束。

例如一双眼睛不再只是两个坐标，而是：

* 两眼必须落在不同区域；
* 两眼距离不能严重失真；
* 每只眼至少使用一格；
* 眼睛与皮肤之间必须保持最小对比；
* 左右眼面积不应差异过大；
* 允许整体移动一格来改善低分辨率表达。

## 4. StructurePlan

```ts
export interface StructurePlan {
  width: number
  height: number
  occupancy: BinaryMask
  sourceMapping: Float32Array
  regionIds: Int32Array
  boundaryStrength: Float32Array
  regions: readonly StructureRegion[]
  featureConstraints: readonly FeatureConstraint[]
  confidence: number
}
```

其中 `sourceMapping` 每个输出格保存其主要对应的原图位置，使输出不再被限制为完全规则的矩形平均采样。

## 5. ValuePlan

```ts
export type ValueRoleKind =
  | 'highlight'
  | 'light'
  | 'base'
  | 'shadow'
  | 'deep-shadow'
  | 'outline'

export interface ValueRole {
  id: string
  regionId: string
  kind: ValueRoleKind
  targetLightness: number
  minimumSeparation: number
  importance: number
}
```

它描述“这块区域承担什么明暗角色”，还没有绑定具体材料色号。

## 6. PalettePlan

```ts
export interface ColorRole {
  id: string
  regionId: string
  valueRoleId: string
  idealLab: Lab
  allowedHueShift: number
  mayShareColor: boolean
  importance: number
}

export interface PalettePlan {
  selectedColorIds: readonly string[]
  assignments: Readonly<Record<string, string>>
  allowedColorIdsByRole: Readonly<Record<string, readonly string[]>>
  totalCost: number
}
```

## 7. CandidateMetricsV2

```ts
export interface CandidateMetricsV2 {
  sourceFidelity: number
  featureVisibility: number
  silhouetteQuality: number
  semanticBoundaryQuality: number
  regionAdjacencyPreservation: number
  valueOrderAccuracy: number
  paletteRoleConsistency: number
  clusterCleanliness: number
  symmetryQuality: number
  craftComplexity: number
  estimatedBuildMinutes: number
}
```

---

# 五、P0：先修正当前基线

预计时间：3～5 天。

这一阶段不增加新模型，先解决当前代码中参数语义和评价不准确的问题。

## 1. 参数修正

| 当前字段                       | 当前行为          | 修改方案                                    |
| -------------------------- | ------------- | --------------------------------------- |
| `isolatedPixelPenalty`     | 已声明，但未真正参与计算  | 接入统一能量，或在 V2 前删除                        |
| `stripePenalty`            | 只判断是否大于 0     | 作为真实数值权重                                |
| `aliasPenalty`             | 只判断是否大于 0     | 作为局部拓扑代价                                |
| `landmark.radius`          | 原图像素与网格格数混用   | 拆为 `sourceRadiusPx` 和 `gridRadiusCells` |
| `ImageAnalysis.confidence` | 基本未参与流程       | 用于控制保护强度与 fallback                      |
| `imageType`                | 类型存在但主流程未利用   | 驱动不同结构和风格 profile                       |
| `symmetryGroup`            | 只用于简单评分       | 接入网格约束                                  |
| `aiEnhancement`            | 主要影响 metadata | 由分析服务信息自动推导                             |

当前 `stripePenalty` 和 `aliasPenalty` 的实现确实只把数值当开关，`isolatedPixelPenalty` 没有真正进入局部优化。

## 2. 修正 FeatureExpressibility

当前逻辑主要检查多个关键点是否映射到不同网格，并没有检查最终输出中这些特征是否真的可见。

改为：

```text
FeatureVisibility =
  位置接近程度
  × 特征实际面积达标率
  × 与周围区域对比度
  × 连通结构完整度
  × 对称关系
```

例如眼睛必须满足：

* 眼睛对应格存在；
* 该格颜色与周围皮肤存在足够差异；
* 不是被邻域优化变成肤色；
* 左右眼的面积和位置关系合理。

没有视觉分析时，不应默认返回 `0.85`，而应该：

```text
score = unknown
confidence = 0
```

评分器再根据置信度决定是否使用该指标。

## 3. 评分拆分

当前颜色误差主要针对已经做过风格和亮度分档的中间图，因此存在“先简化目标，再评价自己是否还原”的问题。

改为两个独立分数：

### Source Fidelity

比较最终结果与原图的：

* 主体轮廓；
* 关键特征；
* 大区域关系；
* 主要颜色关系。

### Plan Fidelity

比较最终结果与 `StructurePlan`、`ValuePlan`、`PalettePlan` 的一致性。

## 4. 自动画布评分修正

去掉当前主要基于总格数的固定 `canvasFit` 公式。

改为：

[
S_{canvas} =
w_fS_{feature}
+w_sS_{subject}
+w_cS_{composition}
+w_bS_{boundary}
-w_nC_{beads}
-w_tC_{time}
]

其中：

* (S_{feature})：关键特征模板是否可实现；
* (S_{subject})：主体覆盖与完整性；
* (S_{composition})：裁剪后构图；
* (C_{beads})：总豆数；
* (C_{time})：预计制作时间。

---

# 六、P1：接入真正的图像理解

预计时间：第 1～2 周。

## 1. 人物主线

首版人物分析输出：

* 人脸框；
* 脸部轮廓；
* 左右眼区域；
* 眉毛；
* 鼻子中心；
* 嘴唇区域；
* 头部姿态；
* 人体主要关节；
* 主体 mask；
* 建议裁剪。

MediaPipe Face Landmarker 可作为首版关键点来源，其输出已经足以计算眼睛中心、眼睛形状、嘴部宽度、脸型和倾斜角。([Google for Developers][4])

## 2. 主体分割

建议采用两级结构：

### 自动分割

使用 BiRefNet 一类前景分割模型，快速得到人物、宠物或物体的主体边界。([arXiv][5])

### 交互式修正

用户点击主体或错误区域时，使用 SAM 2 一类可提示分割模型 refinement。SAM 2 支持图像提示分割和自动 mask 生成。([GitHub][6])

## 3. 宠物首版策略

第一版不直接训练通用宠物关键点模型，采用：

```text
主体分割
  +
头部区域检测
  +
局部暗点/高对比候选
  +
用户确认眼睛、鼻子和耳朵
```

用户只需要在错误时点一下：

* 左眼；
* 右眼；
* 鼻子；
* 需要保护的花纹。

这种人机协作比在早期依赖不稳定的宠物关键点自动识别更可靠。

## 4. 重要度融合

当前实现使用 `max()` 融合边缘、主体、语义和关键点。

建议改为概率式融合：

[
I(x)=1-\prod_k(1-w_kI_k(x))
]

信息来源包括：

* 主体；
* 关键点；
* 主体轮廓；
* 语义边界；
* 身份花纹；
* 用户手动标记；
* 显著性；
* 模型置信度。

这样多个中等强度信号可以共同形成高重要度，而不是只有最强信号生效。

## 5. 低置信度回退

```text
高置信度：
自动生成

中等置信度：
展示主体和关键点，让用户快速确认

低置信度：
切换到通用模式，只保护主体、轮廓和用户标记
```

不得让低置信度模型输出直接成为硬约束。

---

# 七、P2：构图、尺寸和特征模板规划

预计时间：第 2～3 周。

## 1. 候选搜索空间

对以下组合进行 Beam Search：

* 32×32；
* 48×48；
* 64×64；
* 96×96；
* 多种裁剪；
* 主体缩放；
* 主体水平和垂直位移；
* 背景保留/去除；
* 不同五官模板。

不应只比较固定居中裁剪。

## 2. Occupancy 模式

当前主体 mask 主要用于重要度，输出区域仍基本是矩形填满。

增加三种产品模式：

### Full Frame

整张矩形都是拼豆。

### Subject Shape

主体外区域为空格，不放豆。

### Solid Background

主体外使用一种统一背景色。

`BeadPattern.cells` 已经允许缺失坐标表示空白，因此不必推翻最终数据结构。

## 3. 眼睛、嘴和鼻子的模板库

示例：

```text
眼睛：
E1：单格
E2：横向两格
E3：纵向两格
E4：2×2
E5：深色主体 + 亮点
E6：斜向两格

嘴：
M1：单点
M2：两点
M3：短横线
M4：阶梯弧线
M5：开口嘴

鼻子：
N0：省略
N1：单点
N2：短线
```

模板库不是固定审美规则，而是离散候选集合。

系统计算：

[
E_{template} =
E_{position}
+E_{shape}
+E_{ratio}
+E_{contrast}
+E_{symmetry}
+E_{cost}
]

再选择当前尺寸下最合适的模板。

## 4. FeatureBudget

对于每个画布候选，先计算：

* 两眼能否分开；
* 单眼最多可以占几格；
* 嘴巴是否有表达空间；
* 脸部轮廓有多少锚点；
* 宠物耳朵和花纹能否形成独立区域；
* 身体和背景剩余多少空间。

画布不是由眼睛单独决定，而是由全部关键特征的可实现性和制作成本共同决定。

---

# 八、P3：真正的 StructurePlan

预计时间：第 3～4 周。

## 1. 结构规划不再等于加权采样

当前 `guidedAreaSample()` 会提高重要区域采样权重，极重要像素甚至可以直接覆盖一个输出格。

保留它作为基线，但 V2 新增真正的空间与区域规划。

## 2. 区域邻接图

首先建立：

```text
语义区域
  ↓
连通分量
  ↓
超像素或区域生长
  ↓
Region Adjacency Graph
```

每个节点记录：

* 语义标签；
* 面积；
* 平均 Lab；
* 亮度范围；
* 重要度；
* 是否包含关键特征；
* 与周围区域的边界强度。

区域合并代价：

[
C_{merge}(a,b)=
w_cD_{color}
+w_bD_{boundary}
+w_sD_{semantic}
+w_iD_{importance}
+w_fD_{feature}
]

低重要度、颜色相近、边界弱的区域优先合并。

包含眼睛、嘴、耳朵、身份花纹的区域禁止被普通合并。

## 3. PIA-lite 空间重组

每个输出格 (i) 不再固定对应原图矩形中心，而有一个可调整的采样位置 (p_i)。

初始位置为规则映射 (p_i^0)，优化：

[
E_{map}=
\sum_i
\alpha_i|p_i-p_i^0|^2
-\beta_i I(p_i)
+
\lambda
\sum_{(i,j)}
|(p_i-p_j)-(p_i^0-p_j^0)|^2
]

含义：

* 不允许输出格无限偏离原位置；
* 重要区域可以吸引附近网格资源；
* 相邻格保持相对结构；
* 防止网格翻折和严重变形。

第一版只允许每格移动不超过其原始采样区宽度的 25%～40%。

第二版再考虑网格 mesh warp 或更完整的特征映射。

## 4. StructurePlan 输出内容

此阶段输出：

* 空白/主体占用关系；
* 大区域标签；
* 轮廓；
* 关键特征模板；
* 区域邻接关系；
* 每个格主要对应的原图位置；
* 结构置信度。

此时仍然不决定最终材料色号。

---

# 九、P4：明暗角色设计

预计时间：第 4～5 周。

## 1. 当前实现的局限

当前 `designRegionValues()` 将同一语义区域或色相桶中的亮度吸附到 2～4 个分位值。

它是有效的亮度量化基线，但存在：

* 极亮和极暗异常值影响；
* 同一语义标签内多个不相连区域混在一起；
* RGB 三通道同时加减导致色彩截断；
* 不区分固有花纹和光照阴影；
* 不保证空间连续性。

## 2. V2 流程

```text
语义区域
  ↓
拆成连通分量
  ↓
边缘保持平滑
  ↓
去除高频纹理与摄影噪声
  ↓
估计区域基础色
  ↓
计算相对明暗
  ↓
空间连续的 2～4 档分层
  ↓
生成 ValueRole
```

## 3. 首版算法

每个区域使用：

* Guided Filter 或 bilateral smoothing；
* 去掉最低和最高 2%～5% 的亮度异常；
* 加权一维 k-medians；
* Potts 空间连续项；
* 最小亮度间隔；
* 低动态范围自动减少层数。

能量：

[
E(V)=
\sum_i w_i|L_i-\mu_{V_i}|
+
\lambda
\sum_{(i,j)}
g_{ij}[V_i\neq V_j]
]

其中：

* (L_i)：平滑后的亮度；
* (\mu_{V_i})：对应明暗角色中心；
* (g_{ij})：区域内部强平滑、真实边界弱平滑。

## 4. 色彩空间

* 材料色差继续使用 CIEDE2000；
* 明暗调整优先在 Lab/OKLab 的亮度通道完成；
* 不再直接在 sRGB 三通道上统一加减数值；
* 必须进行色域裁剪和回映射。

## 5. 重模型的使用位置

Intrinsic decomposition 或 white-box cartoonization 不作为在线依赖，而作为：

* 研究对照；
* 困难样本教师；
* 生成训练伪标签；
* 判断轻量算法上限。

---

# 十、P5：从“选颜色”升级到“颜色角色规划”

预计时间：第 5～6 周。

## 1. 当前色卡选择保留为基线

当前 `selectPalette()` 使用加权色差进行贪心有限色卡选择，这是合理的固定材料色板基线。

但 V2 不再直接问：

> 哪 16 个颜色最接近整张图片？

而问：

> 哪些材料色最适合承担皮肤、头发、眼睛、衣服、背景各自的亮部、基础色、阴影和轮廓？

## 2. 颜色角色示例

```text
face-light
face-base
face-shadow

hair-highlight
hair-base
hair-shadow

eye-outline
eye-fill
eye-highlight

clothes-base
clothes-shadow

background-base
```

## 3. 角色级离散优化

变量：

* (z_c)：材料颜色 (c) 是否被选中；
* (x_{r,c})：颜色角色 (r) 是否使用材料颜色 (c)。

目标：

[
\min
\sum_{r,c}w_rD(r,c)x_{r,c}
+\lambda_n\sum_cz_c
+\lambda_oE_{order}
+\lambda_kE_{contrast}
+\lambda_hE_{hue}
+\lambda_rE_{reuse}
]

约束：

```text
每个角色只能选择一个材料色
角色使用某色时，该色必须被选入全局色板
总颜色数量 ≤ maxColors
亮部必须比基础色亮
基础色必须比阴影亮
眼睛与脸部至少保持指定对比
关键轮廓不得与相邻主体色完全合并
```

角色数量通常只有十几个，因此可以在服务端使用 CP-SAT 或小规模整数规划。

OR-Tools 的 CP-SAT 面向整数约束问题，要求模型变量和约束使用整数表达，适合这种角色—色号离散选择。([Google for Developers][7])

## 4. 每格颜色候选限制

完成角色色板以后：

* 皮肤格只允许使用皮肤色阶；
* 头发格只允许使用头发色阶；
* 眼睛允许使用眼睛填充、轮廓和高光色；
* 轮廓格可以共享全局深色；
* 背景不能随意侵入主体区域。

这样可以显著减少搜索空间，也能减少不自然色彩。

## 5. 真实材料色卡建设

当前 `generic-24.json` 是通用 24 色占位色板，不足以作为真实品牌材料匹配依据。

正式色卡建议增加：

```ts
interface MeasuredMaterialColor {
  brand: string
  series: string
  code: string
  displayHex: string
  measuredLab: Lab
  illuminant: 'D65'
  observer: '2deg'
  finish: 'opaque' | 'transparent' | 'glitter' | 'special'
  batch?: string
  available: boolean
}
```

优先级：

1. 建立一个品牌的完整实测色卡；
2. 再支持多品牌映射；
3. 屏幕显示色和匹配用实测 Lab 分开保存；
4. 特殊材质单独分类，不与普通不透明色直接混合匹配。

---

# 十一、P6：统一离散网格优化

预计时间：第 6 周。

## 1. 当前模型

当前 `optimizePaletteAssignments()` 是一个四邻域 Potts 型局部优化：

* 单格色差；
* 邻域颜色是否相同；
* 边界处放松平滑；
* 重要格提高保真。

保留为快速 fallback。

## 2. V2 能量

最终每格标签 (l_i) 属于有限色号和空白：

[
l_i\in
{\varnothing,c_1,c_2,\ldots,c_n}
]

总能量：

[
E(L)=
E_{data}
+\lambda_bE_{boundary}
+\lambda_fE_{feature}
+\lambda_rE_{region}
+\lambda_vE_{value}
+\lambda_sE_{symmetry}
+\lambda_cE_{cluster}
+\lambda_tE_{craft}
]

### Data

当前格与理想颜色角色的距离。

### Boundary

真实语义边界处允许换色，区域内部抑制无意义换色。

### Feature

眼睛、嘴、耳朵和身份花纹的硬/软约束。

### Region

保持区域标签和邻接关系。

### Value

亮部、基础色和阴影顺序不能颠倒。

### Symmetry

左右眼、耳朵和局部对称特征保持一致。

### Cluster

抑制无意义孤立格和碎片。

### Craft

限制总色数、细长条、制作难度和材料库存。

## 3. 求解策略

### 快速在线版

* 每格只保留 3～6 个合法候选色；
* 棋盘格更新，避免固定逐行扫描偏差；
* 正向、反向两轮；
* 多个初始化；
* 每次修改必须降低全局能量；
* 32/48/64 画布控制在秒级。

### 服务端增强版

* 一元项和度量型两两项：Graph Cut / alpha-expansion；
* 高阶特征约束：局部搜索；
* 小窗口：CP-SAT 或枚举；
* 设置严格超时，超时后返回当前最佳合法解。

---

# 十二、P7：像素簇和轮廓 Refinement

预计时间：第 6～7 周。

## 1. 不再继续堆叠独立 `if`

当前 `grid.ts` 使用：

* 小连通域替换；
* 左右或上下夹心格替换；
* 3×3 多数颜色替换。

V2 改成统一操作库：

```text
ChangeCell
MergeSmallComponent
FillGap
RemoveSpike
ShiftBoundaryCell
Replace2x2Pattern
BalanceSymmetryPair
SimplifyStripe
RepairStaircase
```

## 2. 每个操作统一计算收益

[
\Delta E=
\Delta E_{source}
+\Delta E_{feature}
+\Delta E_{boundary}
+\Delta E_{cluster}
+\Delta E_{symmetry}
+\Delta E_{craft}
]

只有总能量下降时才接受。

## 3. 区分合法单格和噪声

一个单格不一定是错误：

* 单格眼睛；
* 单格高光；
* 单格鼻子；
* 耳尖；
* 花纹身份点；
* 轮廓转折。

删除前必须检查：

* 是否属于关键特征；
* 是否与模板相关；
* 是否有足够局部对比；
* 是否位于语义边界；
* 是否是用户锁定格。

## 4. 真正的细条检测

不再只检查一个夹心格，而使用：

* 横纵 run-length；
* 连通域宽度；
* 骨架长度；
* 区域面积/周长比；
* 是否与主体轮廓平行；
* 是否跨越语义区域。

这样才能区分：

* 合法线稿；
* 头发边缘；
* 眼睛线；
* 量化产生的无意义一格宽长条。

---

# 十三、P8：风格系统升级

当前五种风格主要依靠亮度、对比度、饱和度和最大色数变化。

V2 风格必须进入结构层。

| 风格  | 结构预算         | 明暗        | 配色       | 特征模板     |
| --- | ------------ | --------- | -------- | -------- |
| 还原  | 保留较多区域和轮廓    | 3～4 档     | 接近原图     | 比例优先     |
| 可爱  | 放大头脸和眼睛，简化身体 | 2～3 档     | 略亮、略暖    | 大眼、小鼻、简嘴 |
| 简洁  | 强区域合并        | 2 档       | 少色       | 最小模板     |
| 高对比 | 强化主体轮廓       | 2～3 档，大跨度 | 深轮廓、清晰亮暗 | 强特征对比    |
| 柔和  | 减少硬轮廓        | 3 档，小跨度   | 邻近色阶     | 圆润模板     |

风格候选不应只是同一结构换一套色彩参数，而应该产生明显不同的结构和制作复杂度。

---

# 十四、P9：候选生成与审美排序

预计时间：第 7 周。

## 1. 规则评分 V2

首版建议：

```text
RuleScore =
  关键特征可见度
+ 主体轮廓质量
+ 语义边界保持
+ 明暗层级一致性
+ 区域配色角色一致性
+ 色块整洁度
+ 对称质量
- 制作复杂度
```

评分必须观察最终网格，而不是只观察关键点是否映射成功。

## 2. 候选多样性

最终返回候选不能只是总分前五名，否则可能全部相似。

采用类似：

[
SelectionScore(c)=
Quality(c)
-\lambda\max_{s\in Selected}Similarity(c,s)
]

相似度可由：

* 网格标签一致率；
* 色板重合率；
* 结构区域一致率；
* 风格参数距离；

共同计算。

## 3. 偏好数据

每次用户选择候选时记录：

```ts
interface PreferenceEvent {
  sourceHash: string
  algorithmVersion: string
  candidateA: string
  candidateB: string
  selected: string
  displayOrder: readonly [string, string]
  editedAfterSelection: boolean
  editCount: number
}
```

必须随机化 A/B 展示顺序，避免位置偏差。

## 4. 模型升级顺序

### Ranker V0

人工规则评分。

### Ranker V1

Bradley–Terry 或 XGBoost pairwise：

* 输入自动指标；
* 输出 A 胜过 B 的概率。

### Ranker V2

冻结视觉编码器＋小型排序头：

* 原图；
* 拼豆预览；
* 自动指标；
* 风格参数。

不建议在没有数千组成对偏好前训练视觉排序器。

---

# 十五、代码目录升级

建议保留当前版本作为对照，不进行大爆炸式重写。

```text
packages/pattern-core/src/
├─ legacy/
│  ├─ pipeline-v02.ts
│  ├─ legacy-grid.ts
│  └─ legacy-structure.ts
│
├─ contracts/
│  ├─ analysis.ts
│  ├─ planning.ts
│  ├─ structure.ts
│  ├─ value.ts
│  ├─ palette.ts
│  ├─ grid.ts
│  └─ evaluation.ts
│
├─ planning/
│  ├─ canvas-planner.ts
│  ├─ crop-search.ts
│  ├─ occupancy-planner.ts
│  ├─ feature-budget.ts
│  └─ template-library.ts
│
├─ structure/
│  ├─ importance.ts
│  ├─ region-graph.ts
│  ├─ region-merge.ts
│  ├─ source-mapping.ts
│  └─ structure-planner.ts
│
├─ value/
│  ├─ smoothing.ts
│  ├─ value-clustering.ts
│  ├─ value-order.ts
│  └─ value-planner.ts
│
├─ palette/
│  ├─ material-profile.ts
│  ├─ role-builder.ts
│  ├─ role-optimizer.ts
│  └─ palette-plan.ts
│
├─ grid/
│  ├─ energy.ts
│  ├─ label-candidates.ts
│  ├─ icm.ts
│  ├─ constraints.ts
│  └─ optimizer.ts
│
├─ refinement/
│  ├─ components.ts
│  ├─ stripes.ts
│  ├─ topology.ts
│  ├─ symmetry.ts
│  └─ local-search.ts
│
├─ candidates/
│  ├─ style-profiles.ts
│  ├─ generator.ts
│  ├─ diversity.ts
│  └─ ranker.ts
│
├─ evaluation/
│  ├─ source-fidelity.ts
│  ├─ feature-visibility.ts
│  ├─ boundary-metrics.ts
│  ├─ craft-metrics.ts
│  └─ ablation.ts
│
└─ pipeline-v2.ts
```

`pipeline.ts` 最终只负责阶段编排，不继续包含颜色选择、评分、画布规划等所有实现。

---

# 十六、API 兼容方案

保留现有入口：

```ts
createPatternAlgorithm()
```

增加：

```ts
createPatternAlgorithm({
  engine: 'legacy' | 'v2',
  version: '0.3.0'
})
```

生成请求增加可选项：

```ts
interface PatternOptionsV2 {
  engine?: 'legacy' | 'v2'
  occupancyMode?: 'full-frame' | 'subject-shape' | 'solid-background'
  structureProfile?: 'faithful' | 'cute' | 'simple'
  optimizationQuality?: 'fast' | 'balanced' | 'quality'
  allowManualCorrection?: boolean
}
```

最终 `BeadPattern`、材料统计和大部分现有结果字段继续兼容。

---

# 十七、测试与评估体系

## 1. 评估集

建议第一批建立 120 张固定评估集：

* 单人人像：40；
* 单宠物：40；
* 插画/动漫：20；
* 困难输入：20。

困难输入包括：

* 复杂背景；
* 强逆光；
* 低对比；
* 遮挡；
* 侧脸；
* 黑色宠物；
* 白色宠物；
* 小主体；
* 多主体；
* 高噪声图片。

其中至少 20 张邀请有拼豆经验的人制作或修订参考图。

## 2. 基线

固定比较：

```text
A0：最近邻 + RGB
A1：面积缩放 + Lab
A2：当前结构版 MVP
V2-1：CanvasPlan
V2-2：+ FeatureConstraint
V2-3：+ StructurePlan
V2-4：+ ValuePlan
V2-5：+ PalettePlan
V2-6：+ GridOptimizer
V2-Full：+ Ranker
```

## 3. 自动指标

### 结构

* 主体 silhouette IoU；
* 轮廓 Boundary F1；
* 语义区域邻接保持率；
* 关键点位置误差；
* 特征可见率；
* 特征模板满足率。

### 明暗

* 区域亮暗顺序正确率；
* 阴影连通性；
* 明暗层数；
* 区域内部碎片数。

### 配色

* 区域加权 ΔE；
* 色阶顺序；
* 主体/背景对比；
* 关键特征最小对比；
* 总颜色数；
* 色号合法率。

### 工艺

* 孤立格比例；
* 小连通域比例；
* 一格宽长条长度；
* 色块平均面积；
* 总豆数；
* 预计制作时间；
* 材料缺货数量。

### 审美

* A/B 盲评胜率；
* 推荐项实际选择率；
* 用户切换候选次数；
* 生成后手动修改格数；
* 实际完成率。

## 4. 建议验收门槛

以下是项目建议目标，不是现有实测结果：

* 所有输出色号合法率：100%；
* 相同输入和参数结果完全可重复；
* 人物双眼可见率：≥95%；
* 相比当前 MVP，孤立格比例降低 ≥50%；
* 相比当前 MVP，人工盲评胜率 ≥65%；
* 生成后中位修改格数降低 ≥30%；
* 32/48/64 主流程 P50 ≤5 秒；
* P95 ≤12 秒；
* 服务异常时能够回退到当前确定性算法。

当前实现规划也将服务端目标设为 P50 5 秒、P95 12 秒，并建议进行逐阶段消融。

---

# 十八、八周实施安排

比赛作品提交截止到 2026 年 10 月 17 日 23:59，北京时间，因此当前适合采用八周开发、最后数日冻结的节奏。

| 时间          | 核心任务                               | 交付                   |
| ----------- | ---------------------------------- | -------------------- |
| 8月17日—23日   | P0 基线修正、评估集、CI、golden test         | 可可信比较的 v0.2.1        |
| 8月24日—30日   | 人脸关键点、主体分割、手动修正                    | `ImageAnalysis` 真正接入 |
| 8月31日—9月6日  | CanvasPlan、Occupancy、FeatureBudget | 自动尺寸与构图规划            |
| 9月7日—13日    | FeatureConstraint、模板库、区域邻接图        | 关键特征结构版              |
| 9月14日—20日   | StructurePlan、区域合并、PIA-lite        | 结构重绘候选               |
| 9月21日—27日   | ValuePlan、颜色角色、材料色卡优化              | 明暗与全局配色              |
| 9月28日—10月4日 | GridOptimizer、ClusterRefinement    | 可制作优化版               |
| 10月5日—11日   | Ranker、消融、盲评、性能和产品集成               | 比赛候选版本               |
| 10月12日—16日  | 冻结、修 Bug、审核、材料和演示                  | 正式提交版本               |

---

# 十九、PR 拆分建议

## PR-01：Freeze Baseline

* 固定当前 commit 输出；
* 增加真实图片 fixture；
* 保存 A0/A1/MVP JSON 与 PNG；
* 增加 GitHub Actions；
* 修正未生效参数；
* 版本升至 `0.2.1-baseline`.

## PR-02：V2 Contracts

* 新增 `CanvasPlan`；
* 新增 `FeatureBudget`；
* 新增 `FeatureConstraint`；
* 新增 `StructurePlan`；
* 新增 `ValuePlan`；
* 新增 `PalettePlan`；
* 增加 `engine` 切换。

## PR-03：Vision Analysis

* 实现人物 Face Landmarker adapter；
* 实现主体分割 adapter；
* 输出模型版本和置信度；
* Demo 展示 mask 和关键点；
* 支持用户点击修正。

## PR-04：Canvas Planner

* 自动裁剪搜索；
* 主体比例；
* Occupancy；
* 特征格数预算；
* 物理尺寸与制作成本。

## PR-05：Feature Templates

* 眼睛模板；
* 嘴模板；
* 鼻子模板；
* 对称约束；
* 最小对比约束；
* 实际输出可见度指标。

## PR-06：Structure Plan

* Region adjacency graph；
* 低重要区域合并；
* 边界简化；
* PIA-lite source mapping；
* 结构候选可视化。

## PR-07：Value and Palette Plan

* 连通语义区域；
* 鲁棒明暗分层；
* ColorRole；
* CP-SAT 角色色号匹配；
* 实测色卡接口。

## PR-08：Grid Energy Optimizer

* 统一能量；
* 硬约束；
* top-k 标签；
* 棋盘格 ICM；
* 多起点；
* 超时与 fallback。

## PR-09：Cluster Refinement

* 小区域；
* 真正细条；
* 2×2 拓扑；
* 阶梯边缘；
* 对称修复；
* 带能量变化的编辑记录。

## PR-10：Ranking and Release

* CandidateMetricsV2；
* 候选多样性；
* 偏好记录；
* 盲评工具；
* 小程序集成；
* 性能与缓存。

---

# 二十、三人团队分工建议

## 成员 A：视觉理解

负责：

* 人脸和人体关键点；
* 主体分割；
* 宠物分析；
* 置信度；
* 手动修正；
* `ai-gateway`。

## 成员 B：结构与优化

负责：

* CanvasPlan；
* FeatureConstraint；
* StructurePlan；
* ValuePlan；
* PalettePlan；
* GridOptimizer。

## 成员 C：产品与评估

负责：

* 微信小程序；
* 浏览器 Demo；
* 图纸编辑；
* 数据集；
* 指标；
* A/B 测试；
* 材料色卡与输出。

每个模块至少由另一名成员 review，避免算法、产品和评估各自割裂。

---

# 二十一、风险与回退策略

## 1. 视觉模型识别错误

处理方式：

* 每个结果附置信度；
* 中低置信度请求用户确认；
* 所有硬特征允许人工修正；
* 无模型结果时回退到通用主体＋边缘模式。

## 2. 结构优化过度夸张

处理方式：

* 保留 source mapping 位移上限；
* 同时输出“还原版”和“结构增强版”；
* 计算原图保真；
* 用户可调“还原—美化”强度。

## 3. 过度平滑导致身份丢失

处理方式：

* 关键特征独立约束；
* 身份花纹允许用户标记；
* 区域合并前检查重要度；
* 保留多个结构候选。

## 4. 色卡实际颜色不准

处理方式：

* 区分屏幕 hex 和实测 Lab；
* 标记品牌、系列、批次和材质；
* 第一版只承诺一个经过校准的材料系列；
* 未经实测色卡标注为“近似预览”。

## 5. 离散优化耗时过高

处理方式：

* 角色级优化先于格子级优化；
* 每格限制 top-k 候选色；
* 32/48/64 使用不同质量配置；
* 设置时间预算；
* 超时返回合法中间解；
* 缓存相同图片和参数。

## 6. 审美评分不可信

处理方式：

* 规则评分只做第一版；
* 不把自动评分包装成客观审美；
* 保存用户真实选择；
* 使用成对偏好校准；
* 盲评数据按原图划分训练和测试。

---

# 二十二、版本定义

## v0.2.1：可信基线

完成：

* 参数修复；
* 真实评估集；
* golden tests；
* 正确指标；
* CI；
* 当前算法稳定冻结。

## v0.3.0：结构规划版

完成：

* 真实图像分析；
* CanvasPlan；
* FeatureConstraint；
* Occupancy；
* StructurePlan；
* 五官模板；
* 输出特征可见度评价。

这是比赛最核心的版本。

## v0.4.0：审美配色版

完成：

* ValuePlan；
* ColorRole；
* 全局材料色卡优化；
* 区域受限标签；
* 统一网格能量；
* Cluster Refinement。

## v0.5.0：偏好学习版

完成：

* 用户 A/B 数据；
* pairwise ranker；
* 风格个性化；
* 用户修改行为学习；
* 重模型蒸馏实验。

---

# 二十三、最终完成标准

V2 不是“代码里出现了更多 AI 模块”就算完成，而必须同时达到：

1. **理解正确**
   主体、关键特征和语义区域具有可检查结果与置信度。

2. **结构真正重组**
   输出不再只是规则矩形降采样，而存在明确 `StructurePlan`。

3. **特征真正可见**
   眼睛、嘴和身份花纹在最终网格中具有面积、对比和连通结构。

4. **明暗经过设计**
   阴影来自区域级明暗角色，而不是全图阈值或简单 RGB 变暗。

5. **配色具有角色**
   材料色分别承担亮部、固有色、阴影、轮廓和关键特征。

6. **工艺优化可解释**
   每次修改都有原因、能量变化和约束信息。

7. **评价观察最终结果**
   评分不再只观察中间图或关键点坐标。

8. **审美由真实偏好校准**
   规则评分逐渐被用户 A/B 选择校准。

9. **始终符合材料约束**
   每格必须是合法色号或空白，材料统计准确。

10. **保留可靠回退**
    任何模型或增强优化失败时，都能回退到当前确定性基线。

整个升级最关键的顺序是：

> **先修正评价 → 再建立结构规划 → 再做明暗和颜色角色 → 最后学习人类偏好。**

不要先接更大的生成模型。当前最大的瓶颈不是模型不够强，而是系统还没有明确表示“要保护什么结构、要分配多少表达资源、每种颜色承担什么美术角色”。只有先把这些中间表示建立起来，机器学习才有清晰、稳定、可验证的学习目标。

[1]: https://pixl.cs.princeton.edu/pubs/Gerstner_2012_PIA/index.php "Pixelated Image Abstraction"
[2]: https://github.com/WuZongWei6/Pixelization?utm_source=chatgpt.com "GitHub - WuZongWei6/Pixelization: AIGC, Pixelization, Pixel Art, SIGGRAPH ASIA If you like this work~ :stars: · GitHub"
[3]: https://igl.ethz.ch/projects/sd-pixl/ "igl | Interactive Geometry Lab | ETH Zurich | SD-𝜋XL: Generating Low-Resolution Quantized Imagery via Score Distillation"
[4]: https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js?utm_source=chatgpt.com "Face landmark detection guide for Web  |  Google AI Edge  |  Google for Developers"
[5]: https://arxiv.org/abs/2401.03407?utm_source=chatgpt.com "Bilateral Reference for High-Resolution Dichotomous Image Segmentation"
[6]: https://github.com/facebookresearch/sam2?utm_source=chatgpt.com "GitHub - facebookresearch/sam2: The repository provides code for running inference with the Meta Segment Anything Model 2 (SAM 2), links for downloading the trained model checkpoints, and example notebooks that show how to use the model. · GitHub"
[7]: https://developers.google.com/optimization/cp/cp_solver "CP-SAT Solver  |  OR-Tools  |  Google for Developers"
