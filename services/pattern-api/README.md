# Pattern API v1

将 MARD 291 色匹配、图纸生成和导出提供给微信小程序。API 使用 Node HTTP、计算 Worker 和 SQLite，默认只监听本机。确定性生成不依赖模型或 GPU；AI 分析复用现有 ai-gateway。

## 本地启动

要求 Node 24.13+、pnpm 11.19。`node:sqlite` 在 Node 24 中为实验功能，部署时应固定经过验证的 Node 小版本。

在仓库根目录执行：

```powershell
pnpm install
Copy-Item services/pattern-api/.env.example services/pattern-api/.env
pnpm api:dev
```

`.env` 默认启用本地模拟身份，监听 `http://127.0.0.1:7105`。规范化图片、任务和结果保存在 `services/pattern-api/data/`，默认保留 24 小时，均已加入 Git 忽略规则。不要将此目录作为 Web 静态目录公开。

规范见 [openapi.json](openapi.json)。时间戳均为 Unix 毫秒；JSON 响应为 `{ data, requestId }` 或 `{ error: { code, message, retryable }, requestId }`。

## 调用流程

1. 本地使用 `POST /v1/auth/dev` 和 `{ "userId": "local-demo" }` 取得 token。真实小程序通过 `wx.login` 获得 code，再调用 `POST /v1/auth/wechat`。
2. `GET /v1/palettes/mard-291` 读取版本，`GET /v1/capabilities` 查询限制及已配置路线。
3. `POST /v1/images` 使用 multipart 字段 `file` 上传，带 `Authorization: Bearer <token>`。支持 JPEG/PNG/WebP，最多 5 MiB、2000 万像素；拒绝动画和伪装类型，校正方向和 sRGB、最长边缩至 1024，保留透明度。
4. `POST /v1/pattern-jobs`，带授权头及唯一 `Idempotency-Key`。重试同一业务操作时保持该键不变。
5. 查询 `/v1/pattern-jobs/{jobId}`，`succeeded` 后读取 `/result`，选择候选后访问 `/exports/{candidateId}?format=png|csv|json`。

```json
{
  "imageId": "img_从上传返回",
  "paletteId": "mard-291",
  "route": "deterministic",
  "options": {
    "canvas": { "mode": "fixed", "size": { "width": 48, "height": 48 } },
    "maxColors": 20,
    "maxCandidates": 3,
    "styles": ["faithful", "simple", "high-contrast"]
  }
}
```

省略 `paletteVersion` 会冻结当前版本；显式指定未知版本返回 404。作品最多 48 色，完整材料库参与搜索；自动网格为 32/48/64，固定网格还支持 96。

颜色策略通过 `options.structure` 传入，微信 SDK 的 `createPatternJob` 使用相同字段：

```json
{ "valueMode": "preserve", "valueStrength": 0, "valueLevels": 3, "outlineMode": "off" }
```

`valueMode` 支持 `preserve / adaptive / stylized`；省略时还原风格为 preserve、简洁为 adaptive、其余为 stylized。`valueStrength` 范围 0–1，默认 1；preserve 实际强度固定为 0。零强度不改变明暗，描边独立；适度增强/风格化的非描边格在量化前最多分别改变 6/12 个 L* 单位和 ΔE00，按强度缩放。色卡、几何映射、五官与精修造成的最终误差另行评估，不能把量化前上限解释为成品色差保证。返回图纸 `metadata` 记录生效策略、强度和算法版本。

任务执行状态与 `result.generationStatus` 分开。`best-effort` 需要用户检查并接受后加 `acceptBestEffort=true` 才能导出不合格候选；`no-valid-candidate` 没有图纸。网格索引 `-1` 表示空白，其余值引用候选的 `colors`；材料数量只统计占用格。

## 恢复与限额

新增 `options.structure.contours: { external, internal, colorId? }` 及 `options.featureOverrides`，微信 SDK 原样传递。五官坐标使用上传返回的规范化图片宽高，支持不等高、不同模板、隐藏和锁定。候选结果返回 `contourPlan` 与 `featurePlacements`；参数示例与限制见[轮廓与五官说明](../../docs/contours-features-2026-09-27.md)。

MARD 291 现默认使用单色深描边，候选为 B22、B23、C12、C18、D4、D10、D15、D22、F7、F11、G8、R22；内外轮廓共用一色，显式指定不合规色号返回 `422 INVALID_CONTOUR_COLOR`。自动填色排除 H7，保留源纹理；24 色兼容旧规则。见[单色描边与填色说明](../../docs/mard-ink-fill-2026-09-27.md)。

- 图片、色卡快照、任务、算法版本、幂等键、会话持久化。断网/退后台不取消任务；恢复后查询原 jobId。升级后无法按原算法执行的排队任务返回 `ALGORITHM_VERSION_CHANGED`，由用户重新生成。
- 显式取消可停止排队/运行任务，迟到结果不能覆盖取消状态。重启恢复排队任务，原运行任务返回 `SERVICE_RESTARTED`；成功结果继续可读。
- 单实例、默认一个 Worker、20 个排队槽位；每用户最多 3 个活动任务、100 个有效任务、10 张图片。上传最多同时两个用户、每用户一个；规范化图片按用户去重。
- 确定性执行超时 60 秒，仅 REMBG 的 AI 路线 180 秒，配置 SAM2 后 AI 路线 300 秒；排队超时 5 分钟。每个来源 IP 每分钟最多 120 请求；超过限额返回 429，转发头不作为认证依据。
- 每 30 秒清理过期文件，运行任务引用的图片受保护。过期元数据短期保留用于 410，然后清除。会话有效期 24 小时。
- 用户只能操作自己的图片/任务/结果；不可见资源返回 404。生产模式禁止模拟身份，AppSecret/session_key 只留在服务端。

## 可选分析与部署

启动 `pnpm sam2:start`，在 API 环境设置 `SAM2_ENDPOINT=http://127.0.0.1:7103`，请求 `route: neural-analysis`，即可使用 Grounded-SAM-2 主体及部件蒙版、独立五官定位和已有模板系统。首次安装执行 `pnpm sam2:setup`，模型来源与验证边界见[自动蒙版说明](../../docs/neural-masks-2026-09-27.md)。

仅设置 `REMBG_ENDPOINT=http://127.0.0.1:7000` 时提供主体蒙版，返回部件识别未启用的提示；同时配置时优先 SAM2。strict 模式在分析失败时报错；best-effort 降级时明确返回警告与 `actualRoute: deterministic`。

非本机模型地址必须配置 `REMOTE_ANALYSIS_LABEL`。客户端先展示能力接口返回的处理位置、取得单独同意，再发送 `consentToRemoteAnalysis: true`。能力接口报告配置，不代替模型健康保证。客户端不能传入模型 URL。

正式环境设置 `NODE_ENV=production`、`PATTERN_DEV_AUTH=0`、`WECHAT_APP_ID`、`WECHAT_APP_SECRET`，以单实例运行并挂载持久数据卷。用 HTTPS 反向代理提供服务，代理上传上限至少容纳 5 MiB 文件及 multipart 开销；微信后台配置 request/uploadFile/downloadFile 域名。不要将凭据写入客户端、响应或日志。

当前不支持多实例同时调度同一个数据库。域名、微信账号绑定、体验版和真机验收需部署方配置，本地自动化不代表这些步骤已完成。

验证：`pnpm test:api`、`pnpm typecheck`、`pnpm test:e2e`。OpenAPI 在根目录运行 `node scripts/generate-pattern-openapi.mjs` 生成。SQLite 参考 [Node v24.13 官方文档](https://github.com/nodejs/node/blob/v24.13.0/doc/api/sqlite.md)。
