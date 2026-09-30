# 区域生成 v3：周边确认 → 肤色底图 → 局部细节

2026-09-30。按用户最终要求保留肤色底图逻辑，固定先周边、再蒙版区。此版本用于本地实验服务与 Demo，与旧 v2／模板 v1 隔离；完整定义见 [contracts.py](../services/sdxl-region-sidecar/src/sdxl_region_sidecar/contracts.py)。

## 两步请求

先将当前完整请求提交 POST /v1/regions/prepare，得到 contextSha256、周边材料、建议／指定肤色、完整模型输入与 mask。再携带该指纹提交 POST /v1/regions/generate。所有参数都参与指纹，任意变化都需重新 prepare。指纹用于顺序与过期输入检查，不是权限凭证，也不代表人工审核资格。

| 字段 | 要求 |
| --- | --- |
| schemaVersion | region-generation-v3；未知字段拒绝 |
| currentGrid | width/height 1–64；paletteId/paletteVersion；colors 最多 291，唯一 id 和 RGB；cells 行优先，-1 是空板 |
| editMask / lockedMask | 与全图同长 bool 数组；有效区为 editMask 且非 lockedMask；至少一格可写，且有效区外必须有已占用周边 |
| inputMode / fillPolicy | 固定 grid-context / all-editable；v2 的 sourceImage 不会被静默忽略 |
| skinColorId | 可选当前材料 ID；省略时按有效区外两格邻域主要色建议，无邻域时用全图可见主要色；自动值不是肤色语义识别 |
| contextSha256 | prepare 返回的指纹；generate 必填且必须匹配当前规范化请求 |
| task | detail-repair 或 harmonize；前者排除明显无结构的填充，后者允许纯色协调 |
| maxAttempts | 1–3，默认 3；seed、seed+1、seed+2 顺序，uint32 回绕；首个通过检查的候选返回 |
| harmonyStrength | 0–1，默认 0.35；颜色漂移修正和周边材料偏好的强度 |
| prompt / negativePrompt | 各最多 1500 字符；结果另记录实际添加风格指令后的 effectivePrompt |
| workingSize / steps | 512、768、1024；2–50 步 |
| strength / guidanceScale / seed | 0.1–0.99，默认 0.99；1–12，默认 8；uint32，默认 42 |
| maximumColors / adapter | 全图最多 1–48 色，输入不得已超预算；none 或服务器配置的 configured |

蒙版内原为空格且锁定时直接报冲突。请求最大 25 MiB；类型／索引／尺寸错误不隐式转换。原有已用颜色优先保留，局部不能重新配全图颜色。

## 神经输入与格级填充

完整当前格图以整数倍最近邻渲染并居中 padding。有效蒙版内统一预铺选定肤色，不保留旧眼睛，也不留灰色／透明孔洞；锁定区域不覆盖。返回 transform 中的 conditioning=full-grid-with-skin-prefill 和实际 skinColorId。SDXL 标准 masked-image latent 分支仍另外处理 mask，不能把这个内部步骤误说成给 image 输入灰色孔洞。

每个有效格都从生成图的中央一半区域取 RGB 中位数，包括原来的空板。先从可见周边对应位置估计生成色调漂移，中位数 Lab 修正逐通道限制在 ±12，再乘 harmonyStrength；量化距离对周边已有材料给予有界软偏好。此策略旨在减小局部色调脱节，真实主观协调性仍需对照评价。

有效区外格、锁定格原样复制；已有珠子不能被删除。新增珠子仅允许在有效区。最终每格必须是合法材料索引，空白不能通过跳过循环留在候选中。

## 检查、失败与回放

- 任何编辑区透明残留或完全无变化均拒绝。detail-repair 还检查每个四邻接区域：4 格以上若单色或 Lab 最大对比不足 12 则拒绝；任一区域完全未变化也拒绝。合法白珠不被当成孔洞。这是结构启发式，不是眼睛／表情识别。
- candidate 才返回 grid 和 changedCells；rejected 返回 grid=null、changedCells=[]，并记录每次 seed、原始生成预览、diagnostics 和拒绝原因，不允许前端接受。
- diagnostics 包含 unfilledCells、filledCells、newlyOccupiedCells、deletedCells、outsideChanged、lockedChanged、colorCount、transparentCells、flatDetailComponents、unchangedComponents。通过候选必须无未填格、无越界／锁定变化和删除。
- 前端接受前独立检查格域、版本、色卡、指纹、全部有效格已填、差异清单与色数。修改任意输入使确认和候选失效；拒绝和失败不修改当前图。
- 导出图纸重新统计材料；可改区仍为空时按钮禁用。撤销可能恢复带孔洞的草稿，因此恢复后也禁止导出完成图；审阅回放仍可导出。
- region-generation-review-v3 保留先确认周边、后生成、接受／拒绝／撤销及失败事件；humanGold 和 trainingEligible 仍为 false，独立来源和使用资格尚待审定。

错误：422 参数／过期周边指纹，409 忙，503 模型／资源失败。没有承诺模型一定画出正确五官；所有尝试失败时保留原图并明确无合格候选。
