# Architecture

## 模块关系

```text
WeChat Mini App
      |
      v
Pattern Core <---- Material Palettes
      |
      v
AI Gateway
```

`pattern-core` 保持平台无关，微信小程序负责界面和平台适配，AI Gateway 负责外部视觉能力接入。

## Pattern Core MVP

```text
RGBA + Palette + Options + ImageAnalysis
                  |
                  v
          Input Validation
                  |
                  v
     Crop / Resize / Style Variants
                  |
                  v
       Lab Conversion + Palette Plan
                  |
                  v
      Landmark Lock + Grid Cleanup
                  |
                  v
       Candidate Score + Ranking
                  |
                  v
 Pattern + Alternatives + Material Counts
```

核心包只处理内存中的标准 RGBA 数据。图片解码、方向修正、人物与宠物模型推理位于调用侧或 AI Gateway，结果通过 `ImageAnalysis` 注入。
