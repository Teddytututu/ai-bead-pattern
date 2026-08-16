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

当前阶段已完成算法 MVP。`pattern-core` 可以从标准 RGBA 像素生成固定或自动尺寸的拼豆候选，并输出材料统计、局部整理记录与规则评分。

## 文档

- [从绘画过程到拼豆图纸：生成方法论](docs/drawing-to-bead-method.md)
- [拼豆生成算法完整调研](docs/algorithm-research.md)
- [拼豆生成算法实现规划](docs/algorithm-implementation-plan.md)
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
- 关键点锁定与网格工艺整理
- 推荐项、备选项、评分和材料统计

浏览器体验页：`apps/demo/index.html`

运行验证：

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @ai-bead-pattern/pattern-core example
pnpm demo
```

## License

[MIT](LICENSE)
