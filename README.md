# AI Bead Pattern

面向微信小程序的 AI 拼豆图纸生成器。

项目目标是把照片转换为兼顾主体特征、真实材料色卡和手工制作约束的网格图纸。底层围绕 `Material Palette + Grid Pattern` 设计，方便后续扩展到十字绣、钻石画、马赛克等网格手作。

## 仓库结构

```text
apps/wechat-miniapp/   微信小程序客户端
packages/pattern-core/ 平台无关的图像与图纸核心
services/ai-gateway/   AI 能力接入层
assets/palettes/       通用材料色卡资源
tests/fixtures/        后续算法评估样例
docs/                  架构、隐私与路线说明
```

当前阶段进入 v0.3.4 Mask Correction。`pattern-core` 将视觉模型提供的主体 mask 投影到目标豆格，使用连续 signed distance、覆盖率、拓扑与毛刺成本优化边界；CanvasPlanner 与候选生成共用缓存后的 ShapeRasterization，多个颜色风格共享同一结构事实。全画面铺豆模式仍使用主体形状评价构图与边界，执行占位保持全画面。自动模式同时生成全图和主体形状候选，再按构图、特征格数、轮廓质量和制作成本排序。`ImageAnalysis` 现在支持带来源、revision、用户确认状态和 provenance 的主体证据；主体 mask、landmark、语义区域和自动裁剪分别使用自己的置信度。用户确认状态提升系统对 mask 的信任度，同时保留原始 confidence。AI、透明通道、本地启发式和人工修正都有正式来源类型，融合结果经过固定优先级与 canonical 排序，输入顺序变化仍保持同一结果身份。

v0.3.3.1 Evidence Performance Hardening 使用流式数值指纹处理大型 mask 和 importance map，并在 `pattern-core` 内规范化 landmark、semantic region 与 provenance 顺序，语义相同的分析输入会生成相同 identity。

Mask Correction Engine 已加入原图归一化坐标笔迹、添加/擦除软笔刷、连续路径插值、草稿与确认分离，以及稳定 revision。`MaskEditSession` 使用完整笔迹历史和 cursor 支持撤销、重做与分支编辑。确认后的证据保留模型置信度和 provenance，并追加 `mask-editor` 人工来源。修正作用域限定为 subject occupancy，语义区域继续由独立视觉证据管理。

Demo 已加入主体修正编辑器，支持添加、擦除、三档笔刷、撤销、重做、重置和确认生成。原始主体、用户添加与用户擦除使用独立覆盖色显示；画布按原图比例 contain 显示，横图与竖图在桌面和手机宽度下保持比例。拖动阶段使用增量 Canvas 2D 预览，松手后由 Core 精确重建一次；待确认状态会提示取消操作将放弃本次修改。完整生成只在确认后触发一次，已确认笔迹在再次打开时继续保留。

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

下一批工作安排为 Mask Failure Gate，随后接入人物语义分析和 FeatureConstraint 模板搜索。

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
```

## License

[MIT](LICENSE)
