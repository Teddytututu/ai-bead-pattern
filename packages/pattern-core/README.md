# Pattern Core

纯 TypeScript 图纸核心。输入已解码的 RGBA、实体色卡、生成选项及可选 ImageAnalysis，输出候选网格、材料统计、评分和诊断。核心不读取文件、不调用模型，也不处理登录或上传。

## 当前职责

- 32／48／64／96 等画布规划、主体占位与源图映射。
- A0/A1 采样对照，以及 MVP 结构、轮廓、明暗、配色和精修路线。
- 保护源图关键点、部件边界、细线和锁定格。
- 区分空板与白珠，处理材料数量及可自动匹配颜色。
- 返回 recommended、bestEffort 或无有效候选，导出 SVG／材料 CSV 等核心格式。
- adapt 对已有图纸的固定格与材料变化进行适配。

算法版本为 0.11.0-source-features。规则五官模板、模板搜索与补色已删除；不再接收 featureOverrides 或返回 featurePlacements。

## 调用

~~~ts
import { createPatternAlgorithm } from '@ai-bead-pattern/pattern-core'

const result = await createPatternAlgorithm().generate({
  image,       // width、height、RGBA data
  palette,     // MaterialPalette
  analysis,    // 可省略的主体、部件和关键点证据
  options: {
    canvas: { mode: 'fixed', size: { width: 64, height: 64 } },
    styles: ['faithful'],
    maxColors: 24,
    maxCandidates: 1,
    structure: { valueMode: 'preserve', valueStrength: 0 },
  },
})
const candidate = result.recommended ?? result.bestEffort
~~~

调用方负责解析图片和明确处理 best-effort。完整类型以 [types.ts](src/types.ts)及[index.ts](src/index.ts)为准，实验规划接口位于 [experimental.ts](src/experimental.ts)。

## 开发与边界

在仓库根目录运行 pnpm --filter @ai-bead-pattern/pattern-core test 或 typecheck。新增修改应验证真实行为，不只验证类型或快照。

核心可作为 256 卡通图到低分辨率网格的基线与后处理，但当前不是训练好的网格神经网络。下一步的配对输入、目标与评测见 [训练路线](../../docs/training.md)。
