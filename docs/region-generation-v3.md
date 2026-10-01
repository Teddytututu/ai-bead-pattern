# 区域生成 v3

本协议用于完整拼豆格图上的局部 SDXL 修复，定义见 [contracts.py](../services/sdxl-region-sidecar/src/sdxl_region_sidecar/contracts.py)。它不是原图到卡通图协议，也不是第二阶段全图网格预测协议。

## 请求与顺序

先 POST /v1/regions/prepare，再携带返回的 contextSha256 调用 /v1/regions/generate。指纹绑定当前规范化请求；图纸、蒙版、参数或颜色改变后必须重新 prepare。指纹不是认证凭证或人工审核标签。

| 字段 | 含义 |
| --- | --- |
| schemaVersion | region-generation-v3 |
| currentGrid | 宽高各 1–64，色卡 ID／版本，颜色及行优先 cells；-1 是空板 |
| editMask／lockedMask | 全图 bool 数组；可写区为编辑且非锁定格 |
| inputMode／fillPolicy | grid-context／all-editable |
| skinColorId | 当前材料 ID；省略时从可见周边建议，不属于肤色语义识别 |
| task | detail-repair 或 harmonize |
| prompt／negativePrompt | 各最多 1500 字符 |
| workingSize | 512、768 或 1024 工作像素，最终格数不变 |
| steps／strength／guidanceScale | 2–50／0.1–0.99／1–12 |
| maxAttempts／seed | 1–3 次，使用顺序 seed 并记录每次结果 |
| maximumColors／adapter | 全图 1–48 色；none 或服务端 configured |

颜色库最多 291 项，输入不得已超过用色预算。有效区外必须有已占用周边；蒙版内空板且锁定是冲突。旧 sourceImage 字段和未知字段会被拒绝，不静默升级旧请求。

## 图像与格图转换

完整格图整数倍渲染并居中补边。有效编辑区预铺肤色作为条件底图，锁定格不覆盖。SDXL 的内部 masked latent 处理与这张条件图是两个步骤。

候选从每个有效格的中央区域取色，进行有界周边色调修正和材料量化。有效区全部填入合法珠色，包括原先空板；范围外和锁定格逐格保持，不能删除原有珠子。

## 结果与回放

candidate 返回 grid 和 changedCells；rejected 的 grid 为 null、差异为空，不能被前端接受。无变化、透明残留和明显无结构的 detail-repair 结果会被拒绝。检查不等同于眼睛识别或身份保持评测。

前端独立验证尺寸、色卡版本、指纹、范围、填充、差异和色数。接受前不改当前图，拒绝／失败保持原图；接受后可撤销。导出完成图要求可改区已填满，回放可保存未完成状态。

region-generation-review-v3 记录准备、生成、接受／拒绝、撤销和失败；产品回放标为 region-guidance，不直接具有训练资格。错误为 422 参数或上下文问题、409 忙、503 模型／资源问题。

启动与 adapter 配置见 [SDXL 服务](../services/sdxl-region-sidecar/README.md)，人工目标保存见 [独立标注](region-annotation-guide.md)。
