# 拼豆生成核心论文精读与实验映射

查询日期：2026-08-16

## 结论

五篇论文覆盖了拼豆生成的主要技术基础：

```text
结构与色板联合抽象
  ↓
学习型像素画分布
  ↓
格子尺寸与边缘解耦
  ↓
固定网格与有限元素生成
  ↓
制作过程中的图纸自适应
```

项目的研究重点集中在四个问题：

1. 低分辨率下如何为眼睛、嘴、脸型、耳朵和身份花纹分配格数。
2. 人物与宠物比例如何随画布尺寸进行受控重构。
3. 皮肤、头发、衣服等语义区域如何形成艺术化明暗层级。
4. 真实拼豆色号如何组成协调、稳定且易于制作的全图色板。

首版技术路线采用传统计算机视觉、离散优化和轻量视觉模型的组合。
学习型结构模型与偏好模型在固定评估集和人工选择数据成熟后加入。

## 1. 研究时间线

| 年份 | 研究 | 解决的问题 | 项目用途 |
|---:|---|---|---|
| 2012/2013 | Pixelated Image Abstraction | 低分辨率结构与有限色板联合优化 | PIA 传统优化强基线 |
| 2018 | Deep Unsupervised Pixelization | 从无配对数据学习像素画外观 | 学习型结构先验 |
| 2022 | Make Your Own Sprites | 格子尺寸、边缘混叠和颜色分阶段学习 | 可控网格与边缘修整基线 |
| 2022 | Handicraft Adaptation | 制作失误后的图纸动态适配 | 制作助手扩展方向 |
| 2024 | SD-πXL | 固定 `H × W × n` 与有限元素生成 | 离线教师和质量上限 |

这条时间线呈现出清楚的技术演进：研究先处理缩图质量，随后学习像素画分布，
再加入格子控制和离散元素约束。语义特征预算、区域明暗设计和拼豆领域配色
仍由本项目继续推进。

## 2. Pixelated Image Abstraction

论文：
[Pixelated image abstraction with integrated user constraints](https://doi.org/10.1016/j.cag.2012.12.007)

### 2.1 核心方法

PIA 同时求解两个变量：

- 每个输出格对应原图中的哪一片区域。
- 整幅输出采用哪些有限颜色。

论文先建立与输出格一一对应的 superpixel，再交替执行修改后的 SLIC 映射和
调色板优化。空间位置、区域颜色和输出色板在同一迭代过程中相互影响，颜色
计算位于 CIELAB 空间。

```text
输入图像
  ↓
规则初始化的 superpixel
  ↓
区域映射更新 ↔ 有限色板更新
  ↓
每个 superpixel 对应一个输出格
```

这种映射允许输出结构相对原图产生局部位移。低分辨率下，眼睛和嘴等特征
可以获得更多空间，人物比例也可以接近像素画和漫画中的受控变形。

### 2.2 Importance Map

论文允许用户提供与输入图同尺寸的灰度权重图。每个 superpixel 的先验权重
来自内部像素重要度的平均值。脸部获得高权重时，调色板会把更多颜色分配给
脸部，背景获得较少颜色。

本项目将这一输入升级为自动生成的 `ImportanceMap`：

```text
ImportanceMap =
  语义区域权重
+ 人脸或宠物关键点
+ 主体轮廓
+ 局部对比
+ 用户标记
+ 模型置信度
```

### 2.3 论文结果与项目判断

论文用户研究中，PIA 相较最近邻和 cubic 基线获得更高选择率。专业像素画师
仍通过场景理解、特征强调、选择性 dithering 和 edge highlighting 获得更强
结果。论文也将 artist choices 与 human-in-the-loop 列为后续方向。

项目采用 PIA 作为第一条重点复现路线：

- 保留 superpixel 与调色板联合更新。
- 将人工重要度图替换为语义驱动的 `ImportanceMap`。
- 将自由颜色替换为真实材料色号集合。
- 增加 `FeatureBudget` 与 `FeatureConstraintMap`。
- 将最终输出接入拼豆网格整理器。

## 3. Deep Unsupervised Pixelization

论文：
[Deep unsupervised pixelization](https://doi.org/10.1145/3272127.3275082)

### 3.1 网络结构

论文使用无配对普通图像与像素画数据，主要包含三个子网络：

| 模块 | 作用 |
|---|---|
| GridNet | 生成多尺度网格结构和不同混叠状态 |
| PixelNet | 学习像素画外观、锐利边缘和局部结构 |
| DepixelNet | 将像素化结果恢复到普通图像域 |

训练同时使用 adversarial、L1、gradient 与 mirror loss。镜像恢复关系约束信息
保留，梯度损失约束边缘和颜色，GAN 损失推动结果靠近像素画分布。

### 3.2 工程限制

- 像素外观固定在输入分辨率约 `1/6`。
- 目标尺寸调整依赖输入预缩放，细节与伪影风险随之进入流程。
- GAN 输出允许颜色漂移和偶发伪影。
- 输出保持连续 RGB，实体色号映射仍需后续离散优化。

### 3.3 项目用途

DUP 适合作为学习型结构与审美先验。项目可以训练一个轻量 `BeadStructureNet`，
输出经过拼豆风格压缩的结构图或区域图。最终网格尺寸和材料色号继续由确定性
模块控制。

首版实验将 DUP 放在历史模型对照组，重点观察：

- 锐利边缘和局部结构质量。
- 人脸、宠物耳朵与花纹的保留率。
- 颜色漂移和随机伪影。
- 32、48、64 三档目标尺寸的适配成本。

## 4. Make Your Own Sprites

论文：
[Make Your Own Sprites](https://doi.org/10.1145/3550454.3555482)

### 4.1 解耦设计

MYOS 将像素化拆为 cell-aware 与 aliasing-aware 两个阶段，分别处理格子结构
和边缘混叠。参考像素画提供 cell structure 表征，辅助网络控制目标格子尺寸。

```text
输入图片 + 参考像素画
  ↓
cell structure 表征
  ↓
cell-aware pixelization
  ↓
aliasing-aware refinement
  ↓
清晰像素画
```

论文为训练构造专用像素画数据，并加入多种 cell size 与 anti-aliasing 程度。
这一设计说明格子尺寸、边缘锐度和颜色分配适合由独立模块处理。

### 4.2 项目用途

项目重点借鉴两项设计：

1. `CellStructureEncoder`：为目标尺寸提供可控格子结构表征。
2. `ClusterRefinement`：独立修整锯齿、毛刺、断裂轮廓和破碎色块。

MYOS 输出仍位于连续图像域。项目在其后增加真实材料色号分类、连通域规则、
2×2 拓扑检查和小窗口离散搜索。

### 4.3 许可证

[官方代码与数据许可证](https://github.com/WuZongWei6/Pixelization/blob/main/LICENSE.md)
覆盖非商业科研、教学、科学出版和个人实验。商业产品集成需要版权所有者书面许可。
项目将官方实现用于内部研究对照，并保持代码、数据和模型权重隔离。

## 5. SD-πXL

论文：
[SD-πXL: Generating Low-Resolution Quantized Imagery via Score Distillation](https://doi.org/10.1145/3680528.3687570)

### 5.1 离散生成形式

SD-πXL 将生成器表示为 `H × W × n` 张量：

- `H × W` 表示目标网格。
- `n` 表示允许使用的颜色或实体元素数量。
- 每个格子最终选择一个类别。

Softmax 将元素表示为可微分凸组合，Gumbel-softmax 提供清晰的近似离散选择，
最终结果再映射到单一类别。这个形式与拼豆板和真实色卡高度一致。

### 5.2 语义与空间条件

SD-πXL 使用扩散模型的 score distillation 提供语义梯度，并通过 prompt、参考图、
边缘、深度和 ControlNet 维持目标内容与空间结构。官方结果展示 cross-stitch、
fuse beads 和 interlocking bricks 等实体制作形式。

### 5.3 工程位置

论文报告的典型优化需要 RTX 4090、6000 步和约 1.5 小时。方法还依赖 prompt，
每个格子的随机采样彼此独立，邻域联合建模仍有扩展空间。

项目将 SD-πXL 放在三个位置：

- 高质量离线基线。
- 小规模评估集的质量上限。
- 结构模型与偏好模型的数据教师。

线上生成继续采用确定性主流程，目标耗时维持在秒级。

## 6. Pixel Art Adaptation for Handicraft Fabrication

论文：
[Pixel Art Adaptation for Handicraft Fabrication](https://doi.org/10.1111/cgf.14694)

### 6.1 研究问题

编织、十字绣和 bead weaving 过程中可能出现格子位移、重复或跳过。已经完成的
部分具有较高返工成本。论文在锁定已制作区域的前提下，自动调整后续区域，
降低错误带来的视觉伪影，并向用户提供多种适配方案。

```text
原图纸 + 当前制作进度 + 已发生错误
  ↓
锁定已制作区域
  ↓
搜索后续区域的适配方案
  ↓
用户选择继续制作方案
```

### 6.2 产品扩展

这一方向可以形成“拼豆制作助手”：

1. 用户拍摄当前拼豆板。
2. 系统识别已完成区域与错误位置。
3. 锁定实体完成状态。
4. 调整后续若干行或局部区域。
5. 输出更新图纸与差异提示。

该能力与图纸生成共享材料色卡、离散网格、局部搜索和工艺约束，适合安排在
核心生成质量稳定后的产品扩展阶段。

## 7. 五篇论文的能力分布

| 能力 | PIA | DUP | MYOS | SD-πXL | Handicraft Adaptation |
|---|---:|---:|---:|---:|---:|
| 结构重映射 | 强 | 中 | 中 | 语义梯度 | 局部适配 |
| 重要性权重 | 人工输入 | 隐式学习 | 参考结构 | prompt / 图像条件 | 已制作区域锁定 |
| 目标格子控制 | 固定输出尺寸 | 输入约 1/6 | 可控 cell size | 固定 `H × W` | 固定工艺网格 |
| 有限颜色 | 联合优化 | 连续 RGB | 连续 RGB | 固定 `n` 类别 | 图纸颜色约束 |
| 像素边缘 | 传统优化 | PixelNet | AliasNet | 离散生成 | 局部更新 |
| 真实材料色号 | 项目补充 | 项目补充 | 项目补充 | 支持有限元素 | 可接材料色卡 |
| 区域明暗设计 | 项目研发 | 隐式风格 | 隐式风格 | 扩散先验 | 沿用原图纸 |
| 偏好学习 | 用户研究 | 感知实验 | 感知实验 | 视觉结果 | 用户选择方案 |

## 8. 项目研究问题

### 8.1 语义特征的离散格数分配

系统需要决定单眼使用一格、两格或更大像素簇。这个决策同时读取目标尺寸、
脸部比例、关键点置信度、邻域对比和身份特征优先级。

建议建立离散候选并评分：

```text
FeatureLayoutScore =
  关键点位置误差
+ 特征可辨识度
+ 对称关系
+ 邻域对比
+ 轮廓连续性
+ 网格成本
```

### 8.2 受控比例重构

PIA 已经允许区域产生局部位移。项目进一步加入人物与宠物结构约束，明确每个
关键点的允许位移、最小间距和比例范围。低分辨率下的结构重构由可解释参数
控制，并保存修改记录。

### 8.3 区域明暗设计

照片明暗先转换为语义区域内的相对层级：

```text
区域固有色
  ├─ 亮部
  ├─ 中间色
  └─ 阴影色
```

皮肤、头发、衣服和背景分别建立 `ShadeRamp`。区域面积、目标尺寸和风格参数
共同决定二档或三档明暗。这个阶段承担主要的艺术化重构。

### 8.4 拼豆领域配色

全局色板目标同时包含感知色差、明暗顺序、冷暖关系、相邻区域对比、关键特征
对比、材料类别和总色数。用户成对选择数据随后校准色板评分。

## 9. 算法模块与论文对应

| 项目模块 | 论文基础 | 当前状态 | 下一项实验 |
|---|---|---|---|
| A0/A1 缩放与配色基线 | PIA 对照设计 | 已实现 | 固定 48×48 评估集 |
| `ImportanceMap` | PIA user constraints | 接口与权重已实现 | 接入语义关键点生成器 |
| `FeatureBudget` | PIA 局部重映射 | 已规划 | 眼口耳离散布局搜索 |
| `StructurePlan` | PIA、DUP | 部分实现 | PIA superpixel 复现 |
| `CellStructureEncoder` | MYOS | 研究候选 | 32/48/64 cell 控制对照 |
| `ShadeRamp` | 项目研发 | 已规划 | 区域二档与三档明暗实验 |
| `ColorPlan` | PIA、SD-πXL | MVP 有限色板已实现 | 区域全局色板优化 |
| `ClusterRefinement` | MYOS | 连通域规则已实现 | 轮廓阶梯与 2×2 拓扑 |
| 离线教师 | SD-πXL | 待建立 | 小规模 48×48 上限集 |
| 制作适配 | Handicraft Adaptation | 产品扩展 | 锁定区域局部重规划 |
| `BeadPreferenceModel` | 项目偏好数据 | 数据契约已规划 | 成对选择采集页 |

## 10. 固定实验矩阵

首轮聚焦 48×48 人物、宠物和插画，所有方法使用相同裁剪、相同材料色卡和
相同最大颜色数。

| 编号 | 方法 | 目的 |
|---|---|---|
| B0 | 最近邻 + RGB 最近色 | 普通转换器基线 |
| B1 | 面积缩放 + Lab / ΔE00 | 工程基础线 |
| B2 | PIA 复现 | 结构与色板联合优化强对照 |
| B3 | MYOS | 可控 cell 与边缘模型对照 |
| B4 | SD-πXL | 离线质量上限 |
| O1 | B2 + 自动 `ImportanceMap` | 检验语义保护贡献 |
| O2 | O1 + `FeatureBudget` | 检验离散特征布局贡献 |
| O3 | O2 + `ShadeRamp` | 检验区域明暗设计贡献 |
| O4 | O3 + 全局材料色板优化 | 检验拼豆配色贡献 |
| O5 | O4 + `ClusterRefinement` | 检验工艺与轮廓修整贡献 |

### 10.1 固定条件

- 画布：48×48。
- 最大颜色数：15 色与 24 色两档。
- 材料色卡：同一版本的 Generic Palette 与实体测量色卡。
- 输入集：人物 20 张、宠物 20 张、插画 10 张。
- 随机性：保存随机种子和模型版本。
- 数据划分：同一原图的全部候选进入同一分区。

### 10.2 指标

| 维度 | 指标 |
|---|---|
| 辨识度 | 人工主体识别率、关键点覆盖率、关键点碰撞率 |
| 结构 | 轮廓 IoU、Boundary F-score、对称误差、断裂数量 |
| 明暗 | 区域层级顺序、阴影连通性、跨区域泄漏 |
| 配色 | 重要性加权 ΔE00、相邻区域对比、色号数量 |
| 工艺 | 孤立豆、小连通域、细长条、总豆数 |
| 偏好 | 主体辨识、整体观感、实际制作意愿的成对胜率 |
| 工程 | 运行时间、峰值内存、失败率、模型与许可证成本 |

### 10.3 实验顺序

1. 固定 B0、B1 与测试集，形成可重复基线。
2. 复现 B2，确认结构和色板联合优化的增益。
3. 逐项加入 O1 至 O5，执行消融实验。
4. 使用 B3 检验学习型格子控制和边缘处理。
5. 使用 B4 建立少量高质量离线参考。
6. 收集成对偏好数据，训练排序器。

## 11. 研发优先级

### P0：PIA 与项目主流程

- 复现 PIA superpixel 与有限色板联合优化。
- 接入当前 `ImportanceMap` 契约。
- 固定 48×48、15 色和 24 色基线。
- 建立人物、宠物、插画的对照图板。

### P1：项目核心增量

- 实现 `FeatureBudget` 离散布局搜索。
- 实现区域二档与三档 `ShadeRamp`。
- 实现真实材料色卡全局优化。
- 扩展轮廓阶梯和像素簇修整。

### P2：学习型对照与教师

- 评估 MYOS 的 cell control 与 AliasNet。
- 建立 DUP 历史模型对照。
- 生成少量 SD-πXL 离线上限样本。
- 启动 `BeadPreferenceModel` 数据采集。

### P3：制作助手

- 识别拼豆板制作进度。
- 锁定已完成区域。
- 对后续区域执行局部重规划。
- 输出更新图纸和差异提示。

## 参考资料

- Gerstner, T. et al. Pixelated image abstraction with integrated user constraints.
  <https://doi.org/10.1016/j.cag.2012.12.007>
- Han, C. et al. Deep unsupervised pixelization.
  <https://doi.org/10.1145/3272127.3275082>
- Wu, Z. et al. Make Your Own Sprites.
  <https://doi.org/10.1145/3550454.3555482>
- Binninger, A., & Sorkine-Hornung, O. SD-πXL: Generating Low-Resolution
  Quantized Imagery via Score Distillation.
  <https://doi.org/10.1145/3680528.3687570>
- Igarashi, Y., & Igarashi, T. Pixel Art Adaptation for Handicraft Fabrication.
  <https://doi.org/10.1111/cgf.14694>
- Pixelated Image Abstraction project page and paper.
  <https://pixl.cs.princeton.edu/pubs/Gerstner_2012_PIA/index.php>
- Deep Unsupervised Pixelization project page.
  <https://ttwong12.github.io/papers/pixel/pixel.html>
- Make Your Own Sprites official implementation and license.
  <https://github.com/WuZongWei6/Pixelization>
- SD-πXL project page.
  <https://igl.ethz.ch/projects/sd-pixl/>

以上论文的题录、方法描述、限制和许可证于 2026-08-16 通过论文原文、作者项目页、
官方仓库和 DOI 元数据核对。
