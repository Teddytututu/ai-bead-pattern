# Pattern Core

平台无关的拼豆图纸算法 MVP。输入标准 RGBA 像素、材料色板和生成选项，输出推荐图纸、备选候选、材料统计、质量分数和局部整理记录。

## 已实现能力

- 固定画布与自动画布候选
- A0 最近邻/RGB 基线与 A1 面积缩放/Lab 基线
- sRGB 到 CIELAB、ΔE76 与 CIEDE2000
- 全图有限色板选择和合法色号映射
- 带来源和置信度的建议裁剪、重要性地图与硬关键点锁定
- 主体 mask 的面积覆盖栅格化、连通块与孔洞保持
- 连续 SDF、覆盖率、拓扑和毛刺成本驱动的目标格边界优化
- CanvasPlanner 与候选生成共用缓存后的 ShapeRasterization
- 全画面占位继续使用主体形状评价构图与边界
- 轮廓锚点与内部五官分层保护
- 画布尺寸的主体占用、轮廓、构图、豆数成本联合规划
- 五官与身份特征的最小/理想/最大格数预算和成对特征可行性检查
- 小连通域、孤立豆和细条纹整理
- 五种风格参数与规则候选排序
- 自动占位模式同时比较全图与主体形状候选
- 原图归一化坐标的 mask 添加/擦除软笔刷与连续路径插值
- mask 修正 Session、撤销重做、草稿确认、确定性 revision 和 provenance 追踪
- 材料数量、颜色误差和工艺指标
- 旧版 `width`、`height` 与结果字段兼容

## 使用

```ts
import { createPatternAlgorithm } from '@ai-bead-pattern/pattern-core'

const algorithm = createPatternAlgorithm()
const result = await algorithm.generate({
  image: rgbaImage,
  palette,
  options: {
    canvas: {
      mode: 'auto',
      candidates: [
        { width: 32, height: 32 },
        { width: 48, height: 48 },
        { width: 64, height: 64 },
      ],
    },
    maxColors: 24,
    styles: ['faithful', 'simple', 'high-contrast'],
    structure: {
      occupancyMode: 'auto',
      shapeRefinementIterations: 2,
    },
  },
  analysis: {
    suggestedCrop,
    suggestedCropSource: 'automatic',
    suggestedCropConfidence: 0.9,
    importanceMap,
    subjectMask,
    landmarks,
  },
})

if (result.status === 'success') {
  console.log(result.recommended.pattern)
} else {
  console.log(result.status, result.bestEffort?.rejectionReasons)
}
console.log(result.alternatives)
```

外部人物、宠物和分割模型通过 `ImageAnalysis` 注入主体掩码、语义区域、关键点、裁剪和重要性地图。核心包保持纯 TypeScript 与平台无关。

主体 mask 的结构阈值固定为 `0.5`，让 SourceShapeModel、SDF、CanvasPlan 与最终候选使用同一语义。

生成结果的 `timing` 提供核心总耗时与 shape model、shape planning、canvas planning、candidate generation 分段耗时；候选 `metrics.processingTimeMs` 表示共享规划完成后的单候选处理耗时。

V2 规划能力从 `@ai-bead-pattern/pattern-core/experimental` 导出。`planCanvases()` 可独立比较多个画布尺寸；每个生成候选也会携带经过校验的 `canvasPlan`，供服务端记录和界面解释自动选型。

Mask Correction 使用原图归一化坐标保存笔迹。编辑阶段维护草稿，用户确认后再生成权威主体证据：

```ts
import {
  appendMaskEditStroke,
  confirmMaskEditSession,
  createMaskEditSession,
  undoMaskEdit,
} from '@ai-bead-pattern/pattern-core'

let session = createMaskEditSession(aiSubjectMaskEvidence.revision)
session = appendMaskEditStroke(session, {
  id: 'stroke-1',
  mode: 'add',
  points: [{ x: 0.2, y: 0.3 }, { x: 0.28, y: 0.35 }],
  radiusNormalized: 0.02,
})
session = undoMaskEdit(session)
const confirmedEvidence = confirmMaskEditSession(aiSubjectMaskEvidence, session)
```

Session 保留完整 stroke log，`cursor` 决定当前生效范围；撤销后新增笔迹会形成新的历史分支。Mask Correction 只生成新的 `SubjectMaskEvidence`，semantic regions 与 landmarks 保持独立证据。

## 验证

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @ai-bead-pattern/pattern-core example
pnpm --filter @ai-bead-pattern/pattern-core benchmark
pnpm --filter @ai-bead-pattern/pattern-core benchmark:shape
```
