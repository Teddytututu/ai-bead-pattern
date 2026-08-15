# Pattern Core

平台无关的拼豆图纸算法契约。当前阶段只定义稳定输入与输出，具体算法将在后续讨论后实现。

## Public API

```ts
import type {
  PatternAlgorithm,
  PatternGenerationRequest,
  PatternGenerationResult,
} from './src'

declare const algorithm: PatternAlgorithm
declare const request: PatternGenerationRequest

const result: PatternGenerationResult = await algorithm.generate(request)
```

主入口接收标准 RGBA 像素、材料色卡和生成参数，返回结构化图纸、材料统计与运行指标。
