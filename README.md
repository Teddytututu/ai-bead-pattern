# AI Bead Pattern

面向微信小程序的拼豆图纸生成器，将照片转换为使用真实材料色号的网格图纸，支持 PNG、CSV 和 JSON 导出。

## 当前状态

- 已接入通用 24、MARD 291、Perler 123；Perler 登记 123 个 SKU，其中 118 色参与自动配色。单张图纸最多 48 色，通用色卡最多 24 色。
- 已实现主体轮廓、原图细节保护、蒙版补擦与撤销重做，以及保色和细节保护。
- 自动主体／部件分析固定使用 GroundingDINO Tiny + SAM 2.1 Small。产品 API、微信 SDK 和原生小程序示例可本地运行；真实微信环境与 HTTPS 部署仍待接入。
- 已下载 2,435 张拼豆参考图纸，[数据清点、读格与预标注审核工具](tools/template-learning/README.md)已有实现。五官新路线采用现成网络，仅训练 adapter；[SDXL Inpainting＋LoRA 实验服务](services/sdxl-region-sidecar/README.md)已本地装配，支持全图条件下的区域生成、接受／撤销和导出，并通过 512/1024 推理及 LoRA 单步／重载验证。真实效果、配对目标、独立分组及正式训练仍待完成，详见[当前计划](docs/plans/README.md)。

## 本地运行

全职 SSH 开发的安装、更新、测试与端口转发见 [远程开发说明](docs/remote-development.md)。Linux 环境可以通过 `bash scripts/dev/bootstrap-linux.sh all` 从锁文件重建。

要求 Node 24.13+、pnpm 11.19。在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm demo
```

打开终端打印的 `/apps/demo/` 地址。默认端口 4173，被占用时尝试 4174–4192。可通过 `$env:PORT='4180'` 指定端口；显式指定的端口被占用时退出。已有最新构建可用 `pnpm demo:quick`，修改核心 TypeScript 后须重新构建。

启用自动分图（首次先安装依赖；启动前保持构建最新）：

```powershell
pnpm sam2:setup
pnpm build
pnpm demo:net
```

模型配置、权重版本及故障处理见 [SAM2 服务说明](services/sam2-sidecar/README.md)。外／内轮廓独立开关；模型检测到的五官只作为原图细节保护与评估证据，不再套用规则模板补画。

启用 SDXL 局部生成实验（独立 Python 环境，首次安装下载约 6.94 GB 模型及依赖）：

```powershell
pnpm sdxl:setup
pnpm demo:sdxl
```

在工作台顶栏点击“局部生成实验”，或访问 `/apps/demo/region.html`。现有构建需保持最新。当前流程为**先确认周边与配色 → 蒙版铺肤色 → 局部生成**，要求可编辑区域全部填色。操作与 prompt 见 [SDXL 说明](services/sdxl-region-sidecar/README.md)，最新状态见[填充计划与实测](docs/plans/masked-grid-fill-plan.md)，历史资源记录见[首轮报告](docs/plans/sdxl-region-implementation-2026-09-30.md)。该入口尚未接入微信 SDK，未通过正式五官质量验收。

另开终端启动产品 API：

```powershell
Copy-Item services/pattern-api/.env.example services/pattern-api/.env
pnpm api:dev
```

已有 `.env` 时保留自己的配置。API 默认监听 `http://127.0.0.1:7105`，本地使用模拟身份。执行 `pnpm wechat:build` 后，将 `apps/wechat-miniapp` 导入微信开发者工具。接口与部署见 [API 说明](services/pattern-api/README.md)和[小程序说明](apps/wechat-miniapp/README.md)。

## 仓库结构

| 目录 | 职责 |
| --- | --- |
| `apps/demo/src` | 浏览器生成、分析编辑与偏好工作台模块 |
| `apps/demo/server` | Demo 静态服务与 AI HTTP 接口 |
| `apps/demo/tests` | `unit` 单元测试、`e2e` 浏览器测试、`fixtures` 服务替身 |
| `apps/wechat-miniapp` | 原生小程序客户端 |
| `packages/pattern-core` | 画布、结构、材料配色、精修与导出 |
| `packages/material-palettes` | 291／123／24 色卡注册和校验 |
| `packages/pattern-api-contracts`、`packages/wechat-client` | 共享协议与微信 SDK |
| `services/pattern-api` | HTTP API、Worker 与 SQLite |
| `services/ai-gateway`、各 `*-sidecar` | 模型接入、分割、可选提案和视觉评分 |
| `tools` | 数据集采集、质量门禁和离线评测；各工具独立维护 |
| `tests/fixtures` | 共享图片、数据格式和历史性能基准；模块测试留在所属包内 |
| `scripts/dev` | Demo 联合启动与本地模型命令 |
| `scripts/benchmarks`、`scripts/diagnostics` | 性能测量、颜色／结构诊断 |
| `scripts/maintenance` | 色卡导入和 OpenAPI 生成 |
| `assets/palettes` | 色卡、来源和许可 |
| `docs/plans` | 产品计划、五官区域生成专项及开源模型调研 |
| `output` | 本地产物按 `benchmarks`、`diagnostics`、`previews`、`tests`、`scratch` 分类；下载图纸仍在 `datasets` |
| `work` | 已冻结的评测会话与人工记录；不提交 Git |

根目录的 `pnpm demo`、`demo:quick`、`demo:net`、`test` 等常用命令保持可用。`apps/demo` 是独立工作区包；依赖规则见[架构](docs/architecture.md#依赖与构建边界)。模型缓存 `.tools`、各 sidecar 的 `.venv`、本地备份和已有数据集路径保持稳定。

## 验证

```powershell
pnpm test
pnpm typecheck
pnpm test:e2e
pnpm benchmark:palette
```

算法行为与边界见[架构文档](docs/architecture.md)。评测协议：[蒙版](docs/mask-failure-gate.md)、[人像视觉](docs/vision-gate.md)。协议夹具通过不等于真实模型质量验收。

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
