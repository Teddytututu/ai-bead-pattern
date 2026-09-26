# MARD 291 与小程序接口：本地交付记录

用户选择先完成本地交付，之后再接入真机环境。本记录区分代码及自动化验证与微信环境验证。

状态：本地交付完成；正式微信环境和真机验收待后续接入。

## 已落地

- 完整 MARD 291 注册、严格校验、内容摘要版本；核心材料库容量 512，作品用色 1–48。数据唯一维护源仍为 `assets/palettes/mard-291.json`。
- Demo 默认 291、可切回 24；候选自带色卡快照，材料按色号或数量排序。PNG 有坐标、每格色号与图例；CSV/JSON 保留色卡身份、颗数和空白格语义。
- 产品 API 提供登录、色卡、上传、异步任务、查询、取消、结果及导出。SQLite 与私有文件保留 24 小时，Worker 默认并发 1；包含归属校验、幂等键、限流、上传校正、超时、重启及过期处理。
- 可选神经分析复用 ai-gateway；确定性路线不依赖模型。远程分析须在服务端配置位置说明，客户端明确同意；降级时返回实际路线与提示。
- 共享 TypeScript 契约、OpenAPI、微信 ESM/CommonJS SDK、原生小程序单页及本地模拟身份配置。

## 本地复现

```powershell
pnpm install
pnpm test
pnpm typecheck
pnpm wechat:build
pnpm test:e2e
```

浏览器体验：`pnpm demo`，访问终端打印的 `/apps/demo/` 地址。

API：首次从 `services/pattern-api/.env.example` 复制 `.env`，然后 `pnpm api:dev`。已有配置无需覆盖。本次本地 `.env` 已准备，未跟踪入 Git。默认地址 `http://127.0.0.1:7105`，开发身份 `local-demo`。API 请求流程见 [README](../services/pattern-api/README.md)，完整规范见 [OpenAPI](../services/pattern-api/openapi.json)。

小程序：`pnpm wechat:build` 生成原生页面 JS 和 `vendor/sdk.js`，将 `apps/wechat-miniapp` 导入开发者工具。默认使用本地 API 和模拟身份；说明见[小程序 README](../apps/wechat-miniapp/README.md)。

## 验证记录

| 验证 | 本机结果 |
| --- | --- |
| `pnpm test` | 702 项全部通过；含核心 396、API 7、SDK 4、色卡 6、契约 1 及既有 Gateway/评测/Demo 测试 |
| `pnpm typecheck` | 通过，包含小程序源码 |
| `pnpm wechat:build` | 通过，包含全部 workspace 构建及小程序 JS；最后的页面生命周期修正已重新编译 |
| 浏览器 Playwright | 全部 17 项通过；最终版本分两组执行，10 项蒙版/分析流程与 7 项模型路线/色卡导出/工作台流程均通过 |
| OpenAPI | 3.1.0 JSON 可解析，13 个路径、158 个 schema 引用可解析 |
| `git diff --check` | 通过 |

已验证的重点包括 291 颜色匹配与大于 255 的索引、512/513 边界、用色预算、空白格统计、浏览器 PNG/JSON、HTTP 实际上传和 Worker 生成、质量导出条件、跨用户隔离、幂等冲突、取消/重启/过期、EXIF 方向与透明图、SDK 重试和会话失效。

配色规划增加了单次规划内的角色/材料距离复用，改变色值或距离方法时重新计算；保留完整搜索范围及旧测试时限。浏览器 PNG 导出和蒙版载入统一使用图片元素解码，修正 Chromium 中 SVG 与小尺寸 PNG 的兼容问题。评测路径测试同时去除了对仓库目录名的硬编码。

性能矩阵共 288 次运行，MARD 291 最大耗时 6,801 ms；另有 6 个独立进程的内存测量，最大峰值 271 MiB。原始数据和方法见[性能报告](palette-benchmark-2026-09-26.md)。本机截图与导出样例位于 `output/demo-mard-291.png` 和 `output/mard-291-pattern.png`；最终测试日志为 `output/final-tests.log`、`output/regression-e2e.log`、`output/final-e2e-remaining.log`。`output/` 不提交 Git，之前的失败日志仅保留作排错记录。

## 后续微信环境验证

尚未声称通过开发者工具实际交互、Android/iOS、真实微信登录、相册权限和弱网前后台联调。这些在本次本地交付之后，用可用 AppID、服务端环境变量中的 AppSecret、HTTPS 域名与微信网络配置开展。正式运行必须关闭模拟身份。当前 API 是单实例本地存储方案，不支持多实例同时调度同一数据库。

Node `node:sqlite` 仍会输出实验特性提示；本机验证使用 v25.5.0，项目 CI 配置 Node 24。部署时应在目标 Node 小版本重复验收。
