# Pattern Core

平台无关的拼豆图纸算法 MVP。输入标准 RGBA 像素、材料色板和生成选项，输出推荐图纸、备选候选、材料统计、质量分数和局部整理记录。

## 已实现能力

- 固定画布与自动画布候选
- A0 最近邻/RGB 基线与 A1 面积缩放/Lab 基线
- sRGB 到 CIELAB、ΔE76 与 CIEDE2000
- 全图有限色板选择和合法色号映射
- 带来源和置信度的建议裁剪、重要性地图与硬关键点锁定
- 小连通域、孤立豆和细条纹整理
- 五种风格参数与规则候选排序
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
  },
  analysis: {
    suggestedCrop,
    suggestedCropSource: 'automatic',
    suggestedCropConfidence: 0.9,
    importanceMap,
    landmarks,
  },
})

console.log(result.recommended.pattern)
console.log(result.alternatives)
```

外部人物、宠物和分割模型通过 `ImageAnalysis` 注入主体掩码、语义区域、关键点、裁剪和重要性地图。核心包保持纯 TypeScript 与平台无关。

V2 规划合同从 `@ai-bead-pattern/pattern-core/experimental` 导出，并配有 CanvasPlan 与 StructurePlan 校验器。

## 验证

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @ai-bead-pattern/pattern-core example
pnpm --filter @ai-bead-pattern/pattern-core benchmark
```
