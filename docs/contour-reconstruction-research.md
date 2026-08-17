# 主体轮廓与目标格结构重构研究

更新日期：2026-08-17

## 结论

当前轮廓质量上限来自形状表示层。`ImageAnalysis.subjectMask` 已经提供连续主体区域，
当前主流程将它转成重要度；最终 `activeMask` 仍由等比例矩形填充生成，边界指标则衡量
缩小图像中的颜色跳变。因此，主体外形、内部色块边缘和摄影纹理共享同一种“边缘”表示。

下一代结构流程采用独立形状规划：

```text
ImageAnalysis
  -> SourceShapeModel
  -> CanvasPlan
  -> TargetScaleContourSimplifier
  -> ShapeRasterizer
  -> GridStructurePlan
  -> ValuePlan
  -> PalettePlan
  -> TopologyAwareRefiner
```

主体形状先决定格子归属。内部区域、明暗角色和材料色号随后进入已确定的主体格子。

## 当前实现中的上游原因

### 1. 主体 mask 进入采样权重

`buildSourceGuidance()` 将主体 mask 乘以置信度并写入 `importance`。这能够提高主体像素的
采样权重，同时保持了规则矩形采样窗口。

### 2. `activeMask` 表示画布 fit

`resizePixels()` 对 `CanvasFit` 内的每个格子写入 `activeMask = 1`。因此长方形图片已经保持
比例并居中，主体外部背景仍和主体共享同一组活动格子。

### 3. 边界指标表示颜色跳变

`structure.edge` 来自亮度梯度，`boundaryAgreement()` 比较相邻格的 Lab 色差与材料色号变化。
该指标适合评价内部色块边界，主体剪影需要独立的形状指标。

## 论文阅读与工程映射

| 研究 | 主要方法 | 项目采用位置 |
|---|---|---|
| Pixelated Image Abstraction | superpixel 映射与有限调色板交替优化，支持 importance constraint | 主体内部大色块、区域映射和材料色板联合优化 |
| SD-πXL | 直接优化 `H x W x n` 有限类别网格，使用 score distillation 与 Gumbel-softmax | 离线教师、候选上限和偏好数据生成 |
| Depixelizing Pixel Art | 使用更大邻域处理 2x2 对角连接歧义，保护单像素语义特征 | 对角决策、眼睛和细线保护 |
| Potrace | 路径分解、全路径最优多边形、角点与曲线拟合 | 目标格坐标下的全局轮廓简化 |
| DiffVG | 可微矢量图栅格化 | 离线轮廓优化基础设施 |
| LIVE | 分层 Bezier 路径、误差连通分量初始化、边界损失 | 分层主体和内部语义形状基线 |
| Optimize & Reduce | 形状重要度、曲线优化和冗余形状删减 | 紧凑轮廓教师和形状复杂度控制 |
| Boundary IoU | 在固定带宽内评价预测边界与参考边界 | 目标格尺度轮廓指标 |
| Topology Cuts | 在离散优化中保持连通分量与孔洞结构 | 边界带局部更新约束 |
| SLIC | 颜色与空间联合的紧凑超像素 | 主体内部区域图与 RAG 合并 |
| Distance Transforms of Sampled Functions | 线性复杂度平方距离变换 | SDF、边界带和形状距离 |

## 开源项目复核

### 生产候选

| 项目 | 许可 | 用途 |
|---|---|---|
| BiRefNet / rembg | MIT | 自动主体 mask provider，继续沿用现有网关 |
| d3-contour | ISC | Marching Squares 与等值线提取 |
| simplify-js | BSD-2-Clause | 目标格坐标中的折线简化 |
| polygon-clipping | MIT | 多边形、孔洞和格子面积交集 |
| @thi.ng/distance-transform | Apache-2.0 | 距离场实现参考 |
| VTracer | MIT OR Apache-2.0 | 强矢量化基线、轮廓调试和离线对照 |
| bead-grid-studio | Apache-2.0 | 线稿组件 ownership、面积投影、骨架与连通性策略 |
| BeadColors | MIT | 多品牌材料色卡来源与格式参考 |

VTracer Node WASM 已完成本地 smoke test。256x192 RGBA 合成图在 polygon 与 spline 配置下
耗时约 12 至 13 ms，并生成紧凑 SVG 路径。它适合 A2 对照和调试；生产主线采用
`mask -> contour -> coverage`，便于接入锚点、孔洞和目标格拓扑。

### 研究对照

| 项目 | 许可或运行成本 | 定位 |
|---|---|---|
| AlexandreBinninger/pixelization | MIT | PIA 离线强基线 |
| SD-piXL | MIT，推荐 24GB VRAM，每图数小时 | 语义质量教师 |
| diffvg / LIVE / Optimize & Reduce | Apache-2.0 / Apache-2.0 / MIT | 离线矢量形状基线 |
| Make Your Own Sprites | 科研许可 | cell-aware 研究对照 |
| PyMaxflow | GPL | 图优化研究脚本 |
| perler-beads | AGPL-3.0 | 拼豆产品能力对照 |
| MOSAIBeads | MIT | 显著性采样、局部正则与候选排序对照 |

MOSAIBeads 的主流程采用显著性加权区域采样、CIEDE2000、局部颜色正则和候选排序，
输出格仍覆盖完整矩形。这个实现进一步说明，显著性和后处理可以改善颜色与局部整洁度，
主体轮廓质量仍依赖独立形状规划。

## 新的阶段契约

### SourceShapeModel

```ts
interface SourceShapeModel {
  width: number
  height: number
  mask: BinaryMask
  contours: readonly ShapeContour[]
  signedDistance: Float32Array
  components: readonly ShapeComponent[]
  anchors: readonly ShapeAnchor[]
  confidence: number
}
```

它保存连续主体形状、外环、孔洞、连通分量、距离场和语义锚点。

### ShapeRasterizer

```ts
interface ShapeRasterization {
  width: number
  height: number
  coverage: Float32Array
  activeMask: Uint8Array
  signedDistance: Float32Array
  boundaryBand: Uint8Array
  topology: ShapeTopology
}
```

覆盖率表示主体与每个目标格的面积交集。初始格子由覆盖率阈值生成，窄边界带中的格子
随后接受目标函数优化。

### GridStructurePlan

```ts
interface GridStructurePlan {
  rasterization: ShapeRasterization
  regionIds: readonly (string | undefined)[]
  protectedCells: ReadonlySet<number>
  landmarkAllocations: readonly LandmarkAllocation[]
  diagnostics: ShapeDiagnostics
}
```

该结构成为颜色规划和网格整理的共同输入。

## 轮廓生成算法

1. 对主体 mask 执行置信滞回、连通分量标记和孔洞分类。
2. 在源坐标计算 signed distance field。
3. 使用 `CanvasPlan` 将形状等比例映射到目标格坐标。
4. 在目标格坐标提取等值线，并按格子单位设置简化容差。
5. 锚点附近降低简化容差，耳朵、眼睛、嘴和身份标记获得最小格数。
6. 计算每格覆盖率、格心 SDF 和一格宽边界带。
7. 固定深内部与深外部格，仅优化边界带。
8. 使用连续形状和邻域语境解决 2x2 对角歧义。
9. 保持主体连通分量、孔洞和锚点约束。
10. 在主体内部运行 SLIC/RAG，形成脸、头发、衣服和阴影的大色块。

## 边界带目标函数

```text
E(x) = lambdaCoverage * sum_i |x_i - coverage_i|
     + lambdaBoundary * distance(boundary(x), sourceSdf)
     + lambdaAnchor * anchorPenalty(x)
     + lambdaTopology * topologyPenalty(x)
     + lambdaFragment * fragmentPenalty(x)
     + lambdaSpike * spikePenalty(x)
```

`x_i` 为格子归属。只有 boundary band 内的变量参与搜索，运行成本与主体周长近似成正比。

拓扑项包含：

- 连通分量数量变化；
- 孔洞数量与最小孔洞面积；
- 单格尖刺和凹口；
- 一格细桥；
- 2x2 对角连接决策；
- 锚点最小格数和对称组关系。

## A0-A5 实验

| 批次 | 方法 | 目的 |
|---|---|---|
| A0 | 当前 guided area sampling | 冻结回归基线 |
| A1 | subject mask 直接面积缩放 | 验证主体格子归属带来的增益 |
| A2 | VTracer 后目标格重栅格化 | 矢量化强基线 |
| A3 | contour + coverage rasterizer | 生产主线最小实现 |
| A4 | A3 + SDF boundary band | 提升目标格边界质量 |
| A5 | A4 + anchors + topology-preserving moves | 产品主线目标 |

### 指标

- Boundary IoU，带宽为 1 格；
- 对称 Chamfer 或 SDF 边界距离；
- 主体连通分量与孔洞变化；
- landmark recall 与最小格数满足率；
- 单格尖刺、凹口、细桥和碎片数量；
- 材料豆数与画布利用率；
- 真人 A/B 偏好。

## 实施顺序

1. 新增形状数据契约和纯函数测试。
2. 实现 mask 清理、距离场、覆盖率与边界带。
3. 将 `activeMask` 生成从 `resizePixels()` 迁移到 `ShapeRasterizer`。
4. 将关键点保护升级为锚点格数约束。
5. 接入 Boundary IoU、拓扑和形状诊断。
6. 在 Demo 增加 A0-A5 对照和主体覆盖率视图。
7. 建立人物、宠物、插画和透明背景的固定评估集。

## References

- Achanta, R., et al. (2012). SLIC superpixels compared to state-of-the-art superpixel methods. *IEEE TPAMI*. https://doi.org/10.1109/TPAMI.2012.120
- Binninger, A., & Sorkine-Hornung, O. (2024). SD-piXL: Generating low-resolution quantized imagery via score distillation. *SIGGRAPH Asia*. https://doi.org/10.1145/3680528.3687570
- Cheng, B., et al. (2021). Boundary IoU: Improving object-centric image segmentation evaluation. *CVPR*. https://doi.org/10.1109/CVPR46437.2021.01508
- Felzenszwalb, P. F., & Huttenlocher, D. P. (2012). Distance transforms of sampled functions. *Theory of Computing*.
- Gerstner, T., et al. (2013). Pixelated image abstraction with integrated user constraints. *Computers & Graphics*. https://doi.org/10.1016/j.cag.2012.12.007
- Hirschorn, O., Jevnisek, A., & Avidan, S. (2024). Optimize & Reduce: A top-down approach for image vectorization. *AAAI*. https://doi.org/10.1609/aaai.v38i3.27987
- Kopf, J., & Lischinski, D. (2011). Depixelizing pixel art. *ACM Transactions on Graphics*. https://doi.org/10.1145/1964921.1964994
- Li, T.-M., et al. (2020). Differentiable vector graphics rasterization for editing and learning. *ACM Transactions on Graphics*. https://doi.org/10.1145/3414685.3417871
- Ma, X., et al. (2022). Towards layer-wise image vectorization. *CVPR*. https://doi.org/10.1109/CVPR52688.2022.01583
- Selinger, P. (2003). Potrace: A polygon-based tracing algorithm. https://potrace.sourceforge.net/potrace.pdf
- Wu, Z., et al. (2022). Make Your Own Sprites: Aliasing-aware and cell-controllable pixelization. *ACM Transactions on Graphics*. https://doi.org/10.1145/3550454.3555482
- Zeng, Y., et al. (2008). Topology cuts. *Computer Vision and Image Understanding*. https://doi.org/10.1016/j.cviu.2008.07.008
