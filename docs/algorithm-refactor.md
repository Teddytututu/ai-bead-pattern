# 拼豆算法重构边界

更新日期：2026-09-05

当前主线已经形成一套可用的确定性拼豆核心。重构的目标是让每个算法阶段拥有清晰输入、输出和测试位置，让 AI 视觉证据与最终图纸优化各司其职。

## 保留的高价值算法

| 阶段 | 算法 | 价值 | 代码位置 |
| --- | --- | --- | --- |
| 图像证据 | 主体 mask、语义区域、关键点、重要度和 provenance | 为后续结构规划提供可追溯输入 | `generation/evidence.ts`、`analysis-evidence.ts` |
| 主体形状 | 连通块、孔洞、轮廓追踪、SDF、覆盖率和薄结构投影 | 在低分辨率网格中保持轮廓和主体拓扑 | `shape.ts` |
| 构图规划 | 画布候选、主体占用、特征格数预算和成对特征可行性 | 在生成前分配有限网格资源 | `planning/canvas-planner.ts` |
| 特征规划 | 眼睛、嘴、鼻、耳尖、身份标记模板搜索与成对布局 | 保持辨识度和硬特征位置 | `planning/feature-*` |
| 结构规划 | 语义区域合并、边界简化、特征保护和受限 source mapping | 把照片结构转换为可制作的大色块 | `planning/structure-planner.ts` |
| 明暗规划 | 区域级 highlight / light / base / shadow / outline 角色 | 建立稳定的明暗层级 | `planning/value-planner.ts` |
| 材料配色 | CIELAB、CIEDE2000、真实材料色号、库存和替代色 | 保证输出落在可购买色卡中 | `planning/palette-planner.ts`、`planning/palette-quantizer.ts` |
| 网格整理 | 孤立格、细条、锯齿、局部簇和预算约束下的局部搜索 | 提高实际拼制稳定性 | `grid.ts`、`grid-refinement.ts` |
| 候选评价 | 结构、辨识度、颜色、边界、工艺成本和材料统计 | 支持自动画布与风格排序 | `generation/evaluation.ts` |
| 偏好聚合 | A/B/Tie 与 Bradley–Terry | 为后续个性化排序提供可复现反馈 | `preference*.ts` |

## 当前主流程

```text
ImageAnalysis
  -> GenerationPolicy
  -> ShapeModel / CanvasPlan
  -> FeaturePlacement
  -> StructurePlan
  -> ValuePlan
  -> PalettePlan 或 PaletteQuantizer
  -> FeatureColorResolver
  -> PaletteCoherence / GridOptimizer / ClusterRefinement
  -> InventoryRepair
  -> CandidateMetrics / CandidateRanking
```

`AI Gateway` 提供主体、语义和关键点证据；`pattern-core` 将证据转为固定网格、合法色号和可解释编辑。模型输出始终经过确定性规划与校验。

## 本轮重构

### 1. `pipeline.ts` 变成编排层

原先的单文件同时承载校验、身份指纹、证据投影、特征布局、候选生成和评价。现在主入口保留生成阶段顺序、共享规划缓存、候选排序和结果状态处理，代码规模从约 2700 行收敛到约 200 行。

### 2. 抽出可复用规划阶段

- `generation-policy.ts`：尺寸、风格、占位模式、缩放方式、色差方式和建议裁剪。
- `generation/identity.ts`：稳定序列化、生成身份和候选身份所需的哈希。
- `generation/validation.ts`：输入、分析证据、调色板和运行预算校验。
- `generation/evidence.ts`：重要度、语义区域、主体回退和透明薄结构判断。
- `planning/feature-planner.ts`：成对五官、单特征模板、载体区域和硬特征保护。
- `generation/evaluation.ts`：颜色误差、边界一致性、特征可见度、身份相似度和候选评分。
- `generation/candidate.ts`：单候选的结构化生成过程。

### 3. 统一普通图片路径的调色板算法

`palette-quantizer.ts` 负责两步：

1. 使用重要度加权的有限色板贪心选择，保留必需特征色号。
2. 使用一次性距离矩阵进行确定性最近色分配，并按有效库存消耗颜色容量。

后续网格整理可能改变颜色分布，因此 `enforcePaletteInventory()` 作为最终硬约束修复阶段：优先把低重要度、未锁定格替换为仍有库存的近邻色；硬特征无法满足库存时，候选进入 `best-effort` 并保留原因。

## 分支使用规则

`main` 作为算法事实基线。`codex/full-product-roadmap`、`codex/v031-canvas-planning` 和 `codex/v031-shape-cache-hardening` 保留为历史实验线，重构内容以主线已有测试和实现为依据。

## 后续迭代顺序

1. 为 40 张真实图片建立来源分组的结构、色彩、材料和制作指标。
2. 在冻结留出集上比较 A0、A1、MVP 和各阶段消融结果。
3. 以具体失败样本驱动结构规划、特征预算和库存修复的参数调整。
4. 当偏好数据规模稳定后，再把 Bradley–Terry 结果接入候选排序。
