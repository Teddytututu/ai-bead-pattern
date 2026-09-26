# Architecture

## 模块关系

```text
WeChat Mini App
      |
      v
WeChat SDK + API Contracts
      |
      v
Pattern API ---- SQLite + private images/results
      |
      v
Worker ---- AI Gateway (optional)
      |
      v
Pattern Core <---- Material Palettes (MARD 291 / generic 24)
```

`pattern-api` 负责会话、上传校正、资源归属、幂等任务、取消/恢复和导出。默认单实例、一个计算 Worker，确定性路线可完全在本地运行；算法只接收规范化图片与冻结的色卡版本。微信客户端通过 SDK 上传文件并查询任务，无需在端侧执行算法。具体契约见 [Pattern API](../services/pattern-api/README.md)。

`pattern-core` 保持平台无关，微信小程序负责界面和平台适配，AI Gateway 负责外部视觉能力接入。当前 gateway 通过 rembg HTTP 服务调用 BiRefNet，并把主体掩码、边界重要度、建议裁剪和模型版本写入 `ImageAnalysis`。主体 mask 使用独立的 `subjectMaskEvidence`，记录 confidence、source、revision、用户确认状态与 provenance；landmark、语义区域和自动裁剪各自保留局部置信度。用户确认生成独立 trust，规划使用 trust，原始 confidence 继续用于记录。Gateway 的融合接口覆盖 AI、透明通道、本地启发式和人工修正，并用固定优先级与 canonical 排序生成稳定结果。

## Pattern Core 0.2

```text
RGBA + Palette + Options + ImageAnalysis
                  |
                  v
          Input Validation
                  |
                  v
     Crop / Source Guidance Fusion
                  |
                  v
 Importance-guided Sampling + Value Design
                  |
                  v
 Lab Palette Plan + Joint Label Search
                  |
                  v
 Landmark Lock + Alias-aware Grid Cleanup
                  |
                  v
       Candidate Score + Ranking
                  |
                  v
Pattern + Alternatives + Material Counts
```

核心包只处理内存中的标准 RGBA 数据。图片解码、方向修正、人物与宠物模型推理位于调用侧或 AI Gateway，结果通过 `ImageAnalysis` 注入。

制作过程自适应通过 `PatternAlgorithm.adapt()` 进入核心包。调用侧提交目标图纸、已制作格的实际颜色和剩余区域掩码，核心包锁定成品区域并重排邻近格子。
