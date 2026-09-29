# AI Bead Pattern

面向微信小程序的拼豆图纸生成器，将照片转换为使用真实材料色号的网格图纸，支持 PNG、CSV 和 JSON 导出。

## 当前状态

- 已接入通用 24、MARD 291、Perler 123；Perler 登记 123 个 SKU，其中 118 色参与自动配色。单张图纸最多 48 色，通用色卡最多 24 色。
- 已实现主体轮廓、35 个五官规则模板、姿态保持、手动点选校正、蒙版补擦与撤销重做，以及保色和细节保护。
- 自动主体／部件分析固定使用 GroundingDINO Tiny + SAM 2.1 Small。产品 API、微信 SDK 和原生小程序示例可本地运行；真实微信环境与 HTTPS 部署仍待接入。
- 已下载 2,435 张拼豆参考图纸。完整逐格编辑、画布编辑、模板模型训练及多场景质量验收仍按[当前计划](docs/plans/README.md)推进；全图 ≤64×64 格、自主学习模板宽高的新方案尚未实施。

## 本地运行

要求 Node 24.13+、pnpm 11.19。在仓库根目录执行：

```powershell
pnpm install
pnpm demo
```

打开终端打印的 `/apps/demo/` 地址。默认端口 4173，被占用时尝试 4174–4192。可通过 `$env:PORT='4180'` 指定端口；显式指定的端口被占用时退出。已有最新构建可用 `pnpm demo:quick`，修改核心 TypeScript 后须重新构建。

启用自动分图（首次先安装依赖；启动前保持构建最新）：

```powershell
pnpm sam2:setup
pnpm build
pnpm demo:net
```

模型配置、权重版本及故障处理见 [SAM2 服务说明](services/sam2-sidecar/README.md)。侧栏的“五官定位与模板”支持原图点选、模板选择、隐藏与锁定；应用校正后重新生成。外／内轮廓独立开关，两眼保留原图高差与大小关系。`node scripts/render-contours-features-demo.mjs` 可生成模板总览和合成对照。

另开终端启动产品 API：

```powershell
Copy-Item services/pattern-api/.env.example services/pattern-api/.env
pnpm api:dev
```

已有 `.env` 时保留自己的配置。API 默认监听 `http://127.0.0.1:7105`，本地使用模拟身份。执行 `pnpm wechat:build` 后，将 `apps/wechat-miniapp` 导入微信开发者工具。接口与部署见 [API 说明](services/pattern-api/README.md)和[小程序说明](apps/wechat-miniapp/README.md)。

## 仓库结构

| 目录 | 职责 |
| --- | --- |
| `apps/demo` | 浏览器生成、分析编辑与内部评测入口 |
| `apps/wechat-miniapp` | 原生小程序客户端 |
| `packages/pattern-core` | 画布、结构、模板、材料配色、精修与导出 |
| `packages/material-palettes` | 291／123／24 色卡注册和校验 |
| `packages/pattern-api-contracts`、`packages/wechat-client` | 共享协议与微信 SDK |
| `services/pattern-api` | HTTP API、Worker 与 SQLite |
| `services/ai-gateway`、各 `*-sidecar` | 模型接入、分割、可选提案和视觉评分 |
| `tools`、`tests` | 数据集工具、质量门禁与回归测试 |
| `assets/palettes` | 色卡、来源和许可 |
| `docs/plans` | 当前产品计划及五官模板专项 |
| `output`、`work` | 本地生成结果、数据集和评测数据；不提交 Git |

## 验证

```powershell
pnpm test
pnpm typecheck
pnpm test:e2e
pnpm benchmark:palette
```

算法行为与边界见[架构文档](docs/architecture.md)。评测协议：[蒙版](docs/mask-failure-gate.md)、[人像视觉](docs/vision-gate.md)、[五官模板](docs/feature-planning-gate.md)。协议夹具通过不等于真实模型质量验收。

## 文档与数据

- [当前计划与待办](docs/plans/README.md)
- [系统架构与当前行为](docs/architecture.md)
- [核心使用接口](packages/pattern-core/README.md)
- [Perler 123 数据来源与材质边界](docs/perler-123.md)
- [拼豆数据集与采集工具](tools/bead-dataset/README.md)
- [像素画参考资料与来源索引](docs/pixel-art-research/README.md)
- [隐私设计](docs/privacy.md)

维护现有功能时更新对应 README、架构或计划状态；一次性运行日志留在忽略目录，不另建按日期命名的完成报告。历史改动可从 Git 查询。

## License

[MIT](LICENSE)
