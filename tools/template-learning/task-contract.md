# FT0 离线契约 v1

> 本文件描述现有 `template-learning-v1`，用于保留旧实验的可复现性。2026-09-30 的[区域生成计划](../../docs/plans/bead-facial-template-learning-plan.md)已替代其模型目标；可变尺寸角色输出不是新 adapter 的输出要求。新 `region-generation-v2` 尚待实现，禁止混用 schema 或自动升级旧人工记录。

版本：`template-learning-v1`。可执行定义在 `contracts.py`；`prepare` 生成输入、输出、监督的 JSON Schema，Pydantic 校验器补充跨字段检查。JSON Schema 本身不能代替矩阵长度、实例归属、放置约束等检查。此协议服务离线实验，尚未接入产品 API。

- 单位为拼豆格。完整图案为 W×H，W/H 各 1–64；x 向右、y 向下，原点在左上，行优先。框使用 `[x,x+width)×[y,y+height)`，点和锚点是整数格索引。>64 的原设计记录范围外，不裁局部或缩图冒充全图。
- wire 存储完整未 padding 的 RGB 和占用数组，长度均为 W×H；`validGridMask` 全 true。空白格仍有效，occupancy 为 0；白珠为 1；不确定为 null。`tensorize` 才向右/下补齐 64×64，padding valid=false，occupancy=-1。局部部件 mask 不删除全图上下文。
- `segmentationEvidence` 仅存预测证据，mask 和框已映射至全图格坐标，实例父子关系及查询归属必须一致。`origin=predicted`；人工框输入模式另建协议，不混入本版主评测。
- A 为成品图纸重建，`inputStage=decoded-pattern`；B 为真实转换，`inputStage=before-template-application`。监督保存在独立 Target 文件。输入及所有嵌套对象拒绝未知字段；正确尺寸、目标矩阵、人工审定 mask 不属于输入。
- 输出每查询 1–4 个候选，或带原因的 `no_template`。每个候选有独立宽高、长度 width×height 的角色矩阵、局部 anchor、全图 placementAnchor、置信和版本。1–8 格只是统计桶，没有 8 格硬上限。不改变模型输出宽高来通过校验。
- `preserve-base` 表示保持原底色，不是白珠、空洞或 padding；输出不允许 unknown。监督可有 unknown（训练屏蔽），并保留人工审核记录。漏检／未知不能自动标成不存在。
- 放置左上角为 placementAnchor−anchor。`validate_output` 校验画布、占格、角色、保护／锁定与邻居距离。邻居间隔使用 Chebyshev 格距离，0 表示禁止重叠，1 表示至少隔一格。保留底色格不覆盖任何原格。
- maximumColors 为材料颜色预算，角色数不等于 SKU 数；必须在 FT5 材料解析后检查。本阶段不声称已完成色卡、姿态或精修后合法性。
- 原图到格图的浮点变换、原图 SHA、读格版本和校正状态保存在 `pilot/views.jsonl`；外部证据先按此变换投影。读格候选不自动变为输入或真值。

源资格、题材审核、布局／逐格审核、部件真值、来源分组各自独立。prepare 导出的训练清单始终为空；后续 FT2 必须同时验证来源允许、人工目标、分组隔离后才能建立训练配对。

运行使用新目录，所有写入拒绝覆盖；原图、已保存预测和人工校正不可静默替换。配置、代码、来源和初始产物都有 SHA-256。runtime、pilot 后续阶段各自记录输入和配置哈希；现阶段不实现自动缓存复用。
