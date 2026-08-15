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

当前阶段完成仓库骨架。功能开发将在后续里程碑启动。

## 方向

- 原生微信小程序 + TypeScript
- 平台无关的 `pattern-core`
- Provider-agnostic AI 接口
- 本地优先的图片处理与隐私设计
- 面向真实制作的图纸、色号与材料统计

## License

[MIT](LICENSE)
