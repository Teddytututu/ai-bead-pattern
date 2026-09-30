# 区域生成 v2：首版运行契约

历史记录：本协议曾用于首轮装配，已由 [v3 肤色底图与两步流程](region-generation-v3.md)替代。以下字段和行为仅供重放旧报告，当前服务拒绝 v2 请求。当前运行 schema 见 [contracts.py](../services/sdxl-region-sidecar/src/sdxl_region_sidecar/contracts.py)，尚未并入产品 Pattern API、微信 SDK 或正式训练集。

## 请求

| 字段 | 格式与约束 |
| --- | --- |
| `schemaVersion` | 固定 `region-generation-v2`，未知字段拒绝 |
| `currentGrid` | `width/height` 为 1–64；`paletteId/paletteVersion`；`colors: [{id,rgb}]` 最多 291；`cells` 行优先材料索引，`-1` 为空板 |
| `editMask`, `lockedMask` | 与完整格图等长的 bool 数组；有效区为 `editMask & ~lockedMask`，至少一格 |
| `inputMode` | `grid` 或 `source`，无自动回退 |
| `sourceImage` | 仅 source 模式必填：`width/height` ≤2048，`rgbaBase64` 为完整 RGBA 字节，`mapping: contain-full-image`；grid 模式携带源图会拒绝，避免误以为已使用双参考 |
| `prompt`, `negativePrompt` | 修改指令与负面指令，分别最多 1500 字符 |
| `workingSize` | 512／768／1024 像素，不是最终格数 |
| `steps`, `strength`, `guidanceScale`, `seed` | 2–50、0.1–0.99、1–12、uint32；`int(steps*strength)` 至少为 1 |
| `maximumColors` | 全图已用材料种类上限 1–48；输入已经超预算则拒绝，不通过全图重新配色消化预算 |
| `adapter` | `none`／`configured`；由服务器配置 LoRA 文件与 manifest，客户端不传本地路径 |

旧示例保存在首轮诊断的 request.json；当前 `/v1/regions/example` 与 smoke 命令均返回 v3，不能用于重建 v2 请求。v2 当时限制请求最多 25 MiB，错误类型／形状／索引均不隐式转换。

## 全图映射与约束

令工作边长为 S、格图宽高 W/H，整数倍 `scale=floor(S/max(W,H))`。格图以 `W*scale × H*scale` 居中放置；`x/y` 是左上工作像素偏移。G 模式采用最近邻；I 模式完整源图先按比例 contain 到这个矩形，另返回 `sourceFrame`（工作像素及源图宽高）。不做独立局部裁剪、不以模板宽高预测替代区域输入。

蒙版在格域求有效区后用最近邻映射，白色重绘、黑色保留。模型可能改变全图 RGB；最终格级候选只读取有效区已有珠子的格内中央一半区域，以 RGB 中位数转 Lab，在输入材料集合中选色。保留全部原有已用材料，再在余下颜色预算内贪心添加候选材料。该量化为首版策略，尚未证明最佳。

首版冻结占用，白色珠子与空格分别表示。有效区外、锁定格、空板从原数组原样复制，保证对应索引完全不变。语义碰撞、脸部形状、孤立格和五官间隔不由当前诊断字段自动判合格；接受前人工检查。

## 响应与审核

- `decision` 为 `candidate` 或 `no-change`；`grid`、`changedCells[{index,before,after}]` 为完整候选与精确差异。
- `beforeSha256` 是规范化原格图 SHA，`requestSha256` 是完整规范化请求 SHA。服务没有可变项目库，浏览器按请求快照复核当前格图、色卡和范围后才允许接受。
- `transform` 包含整数格相位、padding 和可选 sourceFrame；`preview` 提供输入、mask、原始生成和最终格图 PNG data URL。
- `diagnostics` 为范围外／锁定／占用变更数及最终用色数，不是神经置信度或语义质量分。
- `metrics` 为加载、推理和总耗时与 PyTorch 峰值分配／保留显存，不含其他进程，也不代表系统总显存或主内存峰值。
- `provenance` 包含模型 revision、adapter manifest、prompt、种子、工作尺寸、步数、strength、CFG、卸载模式；环境版本由诊断报告另存。

Demo 的生成请求不修改图纸。接受／拒绝必须填写原因；撤销恢复此前格图和接受记录。导出 `bead-pattern-document-v1` 时重新统计材料；回放文件 `region-generation-review-v2` 保留完整请求、结果、失败及接受／拒绝／撤销事件。`humanGold=false`、`trainingEligible=false` 表示还没有独立来源、资格和正式人工真值审定，不因为点击接受而自动提升资格。回放现可导出作审阅证据；没有服务端审定／保存／导入训练功能。

## 未覆盖范围

双参考 I+G、任意裁剪／旋转映射、占用编辑、超过 64 格、自动候选排序、正式 adapter 训练器、三色卡真实质量门禁，以及 API/SDK 的持久化 revision 冲突协议均未完成。模型或适配器不匹配、OOM、请求失败时保留原格图并记录错误。
