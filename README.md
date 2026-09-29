# AI Bead Pattern

面向微信小程序的 AI 拼豆图纸生成器。

项目目标是把照片转换为兼顾主体特征、真实材料色卡和手工制作约束的网格图纸。底层围绕 `Material Palette + Grid Pattern` 设计，方便后续扩展到十字绣、钻石画、马赛克等网格手作。

MARD 291、Perler 123 和通用 24 已接入生成、预览和 PNG/CSV/JSON 导出，单张图纸最多使用 48 色（通用色卡最多 24 色）。Perler 完整登记 123 个官方 SKU，照片自动配色使用 118 个普通颜色，5 个特殊材质色保留登记；色值为屏幕参考值，见[来源与接入说明](docs/perler-123.md)。产品 API、微信 TypeScript SDK 和原生小程序示例已落地，当前交付范围为本地运行与自动化验证。真实微信账号、HTTPS 部署和真机联调在后续接入。

当前进度、执行顺序和计划归档统一从 [docs/plans](docs/plans/README.md) 进入。总计划维护 P0–P10 交付，五官专项细化图纸提取与模板学习；近期准备小样本分图试验，并行补齐配色质量门禁。Perler 123、35 个规则模板和现成主体／部件分析已接入，2,435 张参考图纸已下载，分图与模板训练尚未实施。用户于 2026-09-26 确认的历史验收范围保留在[历史交付基线](docs/roadmap.md)。

## 本地使用

要求 Node 24.13+、pnpm 11.19。在仓库根目录执行：

```powershell
pnpm install
pnpm demo
```

浏览器打开终端打印的 `/apps/demo/` 地址，可直接使用默认 MARD 291 色卡。Demo 默认使用 4173 端口；被占用时自动尝试 4174–4192，以终端打印的地址为准。也可在 PowerShell 中执行 `$env:PORT='4180'` 指定端口；显式指定的端口被占用时会提示退出，执行 `Remove-Item Env:PORT` 可恢复自动选择。

自动识别主体、眼睛和其他部件蒙版：首次执行 `pnpm sam2:setup`，之后用 `pnpm demo:net` 同时启动现成 Grounded-SAM-2 模型和 Demo。眼睛蒙版可在“分析图层”查看，定位结果进入模板选择；缺失部件不再由几何规则补画。见[模型来源、运行说明与验证](docs/neural-masks-2026-09-27.md)。

MARD 291 已更新为从 12 个深色高饱和色号中选一个统一描边色，自动填色排除 H7，并保护身体纹理与局部形状；24 色保持兼容。见[规则与修改前后对比](docs/mard-ink-fill-2026-09-27.md)。

结构版新增“颜色策略”与“明暗强度”：还原风格默认保色，可显式选择保色、适度增强或风格化。强度 0 旁路明暗调整；描边另行开关，色卡量化仍会有色差。已有最新构建时可用 `pnpm demo:quick` 跳过构建并快速启动；首次运行或修改核心 TypeScript 代码后请用 `pnpm demo` 重新构建并启动。

结构版默认开启外/内轮廓，可独立关闭；“五官定位与模板”支持原图点选、坐标修改、35 个部件模板、隐藏和锁定。两眼保留原图高差及大小关系，不强制等高或使用相同模板。详见[实现与演示说明](docs/contours-features-2026-09-27.md)；`node scripts/render-contours-features-demo.mjs` 可生成模板总览及姿态/轮廓合成对照。

另一个终端启动供小程序调用的 API：

```powershell
Copy-Item services/pattern-api/.env.example services/pattern-api/.env
pnpm api:dev
```

已有 `.env` 时保留自己的配置。服务默认监听 `http://127.0.0.1:7105`，使用显式启用的本地模拟身份。运行 `pnpm wechat:build` 后，将 `apps/wechat-miniapp` 导入微信开发者工具；本地示例已配置 `local-demo` 身份。详见 [API 说明](services/pattern-api/README.md)、[OpenAPI](services/pattern-api/openapi.json)和[小程序说明](apps/wechat-miniapp/README.md)。

## 仓库结构

```text
apps/demo/            浏览器工作台与内部评测入口
apps/wechat-miniapp/   微信小程序客户端
packages/pattern-core/ 平台无关的图像与图纸核心
packages/material-palettes/ 291/123/24 色卡注册表与校验
packages/pattern-api-contracts/ HTTP 请求校验与共享类型
packages/wechat-client/ 微信 API 调用 SDK
services/pattern-api/  产品 HTTP API、任务 Worker、SQLite 持久化
services/ai-gateway/   AI 能力接入层
services/pixel-proposal-sidecar/ 本地 Pixel Art + LCM 提案服务
services/sam2-sidecar/ 本地 SAM 2.1 粗圈提示分割服务
services/mmpose-sidecar/ 可选宠物姿态服务
services/openclip-sidecar/ 可选视觉偏好评分服务
services/dinov2-sidecar/ 可选身份相似度评分服务
tools/                离线候选评测与质量门禁
assets/palettes/       通用材料色卡资源
tests/fixtures/        后续算法评估样例
docs/                  架构、隐私与路线说明
```

当前算法版本为 `0.10.0-mard-ink-fill`。生成流程包含 CanvasPlan、FeaturePlacement、StructurePlan、ValuePlan、PalettePlan、蒙版轮廓、Unified Grid Refinement 和 Preference Aggregation。五官先确定离散格位，保留原图姿态；颜色按格匹配真实材料，轮廓与五官在后续精修中受保护。A/B/Tie 记录可进入 Bradley–Terry 聚合，输出候选效用分数和排序。

v0.3.3.1 Evidence Performance Hardening 使用流式数值指纹处理大型 mask 和 importance map，并在 `pattern-core` 内规范化 landmark、semantic region 与 provenance 顺序，语义相同的分析输入会生成相同 identity。

Mask Correction Engine 已加入粗略圈选、连通主体选择、空蒙版实心填充、添加/擦除软笔刷、草稿与确认分离，以及稳定 revision。`MaskEditSession` 使用完整操作历史和 cursor 支持撤销、重做与分支编辑。确认后的证据保留模型置信度和 provenance，并追加 `mask-editor` 人工来源。修正作用域限定为 subject occupancy，语义区域继续由独立视觉证据管理。

Demo 配置 Grounded-SAM-2 后优先取得模型主体与部件蒙版；BiRefNet 保留为主体分割来源。沿主体外侧粗略圈选作为 SAM2 网络提示，失败时保留当前蒙版；补充和擦除用于手工微调。识别结果、局部补充、局部擦除和圈选范围使用独立覆盖色显示；画布按原图比例 contain 显示，横图与竖图在桌面和手机宽度下保持比例。完整生成只在确认后触发一次，已确认操作在再次打开时继续保留。

标准页面展示 Structure / Value / Palette / Grid Refinement 诊断、材料统计和候选结果。偏好标注工具收进内部入口 `?internal=1`，供自动评测与开发回放使用；偏好记录保存在浏览器本地，可对当前候选运行 Bradley–Terry 排序。

## 文档

- [当前计划、优先级与历史方案入口](docs/plans/README.md)
- [历史交付与验收基线](docs/roadmap.md)
- [选色色差排查记录](docs/color-fidelity-triage-2026-09-28.md)
- [拼豆图纸数据集：2,435 张参考与采集工具](tools/bead-dataset/README.md)
- [本地交付与验证记录](docs/local-delivery-2026-09-26.md)
- [24/291 色性能对照](docs/palette-benchmark-2026-09-26.md)
- [从绘画过程到拼豆图纸：生成方法论](docs/drawing-to-bead-method.md)
- [拼豆生成算法完整调研](docs/algorithm-research.md)
- [可采用方法与 GitHub 项目复核](docs/methods-and-github-review.md)
- [主体轮廓与目标格结构重构研究](docs/contour-reconstruction-research.md)
- [系统架构](docs/architecture.md)
- [当前实现梳理与剪枝检查](docs/implementation-pruning-2026-09-28.md)
- [隐私设计](docs/privacy.md)

## 方向

- 原生微信小程序 + TypeScript
- 平台无关的 `pattern-core`
- Provider-agnostic AI 接口
- 服务端算法主流程与端侧轻量预处理
- 面向真实制作的图纸、色号与材料统计

## 算法 MVP

- A0/A1 对照基线
- Lab 与 CIEDE2000 材料配色
- 自动尺寸和五种风格候选
- 长方形图片等比缩放、居中留白
- 主体 mask 驱动的目标格形状重构
- 连通块、孔洞、边界与关键点保护
- 关键点锁定与网格工艺整理
- 推荐项、备选项、评分和材料统计

## 可信结构基线

- 独立使用边缘引导图，并融合主体、语义区域、关键点和外部重要度图
- 重要度引导的自适应采样与长宽比保持
- 语义区域二至四档明暗归纳
- 真实有限色卡内的邻域联合标签优化
- 最终网格特征可见度与置信度驱动的自动画布排序
- 生成前的 CanvasPlan 和 FeatureBudget，检查双眼碰撞与特征格数可行性
- 原图保真与设计目标一致性分项评分
- 原图像素半径和网格半径分离的硬特征锁定
- 数值化孤立点、细条和局部拓扑惩罚
- 毛刺、细条、碎片与阶梯边缘整理
- 已制作格锁定与剩余图案自适应重排
- 结构版、面积缩放、最近邻三路浏览器对照
- rembg + BiRefNet 主体分割适配器
- 主体边界重要度、自动裁剪与分析版本追踪
- 多来源视觉证据、独立置信度与 provenance 追踪
- 用户确认的修正 mask 优先融合合同
- 原图坐标 Mask Correction Engine、Session 撤销重做与确定性人工确认 revision
- 线性轮廓追踪、面积覆盖栅格化与 Signed Distance Field
- 全图与主体形状占位候选搜索
- 语义区域图、区域合并、边界简化与 PIA-lite sourceMapping
- 眼睛、嘴和鼻子的模板搜索、联合放置与材料色角色解析
- 区域级 light / base / shadow / outline 明暗规划
- 全局真实材料色子集与角色分配
- Fast / Quality 统一网格精修、能量单调检查与对称质量指标
- A/B/Tie 本地采集与 Bradley–Terry 偏好聚合

内部评测使用独立图片、视觉模型标签和开发回放记录建立偏好集，按来源图片切分训练与评测，并扩展宠物关键点和身份花纹规划。

浏览器体验页：`apps/demo/index.html`

运行验证：

```bash
pnpm install
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm build
pnpm --filter @ai-bead-pattern/pattern-core example
pnpm benchmark
pnpm benchmark:shape
pnpm demo
pnpm pixel-proposal:setup
pnpm demo:ai
pnpm openclip:setup
pnpm openclip:start
pnpm sam2:setup
pnpm sam2:test
pnpm sam2:start
pnpm sam2:smoke
pnpm auto-eval:generate -- --category pet --limit 3 --openclip-endpoint http://127.0.0.1:7102
```

`pnpm demo:ai` 会同时启动本地 Pixel Art + LCM 提案服务与浏览器工作台。模型菜单包含确定性基线、BiRefNet 神经分析、学习像素化和生成式提案；学习结果继续经过主体与宠物关键点分析、实体色板映射、连通性整理和制作成本评分。

`auto-eval` 可选连接本地 OpenCLIP sidecar。每个候选保存固定模型身份、配对特征和贡献分，宠物类别额外使用宠物/鸟类边际；服务故障会记录短警告并继续输出纯规则排序。

`sam2-local` 接收粗圈、外接框和正负点，返回选中实例的紧凑 RLE 蒙版、自动裁剪、predicted IoU 和稳定度。启动 sidecar 后设置 `SAM2_ENDPOINT=http://127.0.0.1:7103`，Demo 的显式 `providerIds: ['sam2-local']` 请求会直接使用提示分割结果覆盖主体证据。

## License

[MIT](LICENSE)
