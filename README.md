# AI Bead Pattern

面向微信小程序的 AI 拼豆图纸生成器。

项目目标是把照片转换为兼顾主体特征、真实材料色卡和手工制作约束的网格图纸。底层围绕 `Material Palette + Grid Pattern` 设计，方便后续扩展到十字绣、钻石画、马赛克等网格手作。

## 仓库结构

```text
apps/wechat-miniapp/   微信小程序客户端
packages/pattern-core/ 平台无关的图像与图纸核心
services/ai-gateway/   AI 能力接入层
services/pixel-proposal-sidecar/ 本地 Pixel Art + LCM 提案服务
services/sam2-sidecar/ 本地 SAM 2.1 粗圈提示分割服务
assets/palettes/       通用材料色卡资源
tests/fixtures/        后续算法评估样例
docs/                  架构、隐私与路线说明
```

当前主线已到 `pattern-core v0.7.0`。生成顺序已经落成 CanvasPlan、FeaturePlacement、StructurePlan、ValuePlan、PalettePlan、Unified Grid Refinement 和 Preference Aggregation。人物五官先确定离散格位，语义区域再合并和重映射，区域明暗角色随后映射到真实材料色号，最后通过 Fast / Quality 两档统一能量整理孤立格、细条、棋盘锯齿与双眼对称。A/B/Tie 记录可以直接进入 Bradley–Terry 聚合，输出稳定的候选效用分数和排序。

v0.3.3.1 Evidence Performance Hardening 使用流式数值指纹处理大型 mask 和 importance map，并在 `pattern-core` 内规范化 landmark、semantic region 与 provenance 顺序，语义相同的分析输入会生成相同 identity。

Mask Correction Engine 已加入粗略圈选、连通主体选择、空蒙版实心填充、添加/擦除软笔刷、草稿与确认分离，以及稳定 revision。`MaskEditSession` 使用完整操作历史和 cursor 支持撤销、重做与分支编辑。确认后的证据保留模型置信度和 provenance，并追加 `mask-editor` 人工来源。修正作用域限定为 subject occupancy，语义区域继续由独立视觉证据管理。

Demo 的主体流程以“沿主体外侧粗略圈一圈”为默认操作。页面先调用 BiRefNet 获取基础主体，再用圈选区域选择完整连通组件并显示实心蒙版；补充和擦除保留为局部微调。识别结果、局部补充、局部擦除和圈选范围使用独立覆盖色显示；画布按原图比例 contain 显示，横图与竖图在桌面和手机宽度下保持比例。完整生成只在确认后触发一次，已确认操作在再次打开时继续保留。

标准页面展示 Structure / Value / Palette / Grid Refinement 诊断、材料统计和候选结果。偏好标注工具收进内部入口 `?internal=1`，供自动评测与开发回放使用；偏好记录保存在浏览器本地，可对当前候选运行 Bradley–Terry 排序。

## 文档

- [从绘画过程到拼豆图纸：生成方法论](docs/drawing-to-bead-method.md)
- [拼豆生成算法完整调研](docs/algorithm-research.md)
- [可采用方法与 GitHub 项目复核](docs/methods-and-github-review.md)
- [拼豆生成算法实现规划](docs/algorithm-implementation-plan.md)
- [V2 算法升级方案](docs/algorithm-upgrade-v2.md)
- [主体轮廓与目标格结构重构研究](docs/contour-reconstruction-research.md)
- [系统架构](docs/architecture.md)
- [产品路线](docs/roadmap.md)
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
