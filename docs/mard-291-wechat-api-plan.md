# MARD 291 色实装与微信小程序接口实施计划

日期：2026-09-26。状态：已按 M1 → M2 → M3 推进实现，正在完成本地验收。用户已明确先交付本地版本，真实微信环境与真机联调后续接入。原计划保留在下方，实际结果见[本地交付记录](local-delivery-2026-09-26.md)与[性能报告](palette-benchmark-2026-09-26.md)。

目标：让用户使用完整 MARD 291 色库生成带真实材料色号的图纸，并通过微信小程序完成上传、生成、查询、预览及下载。复用现有 `pattern-core` 和 AI Provider，优先打通可验证的产品流程。

## 1. 计划制定时的项目现状

| 位置 | 现状 | 本次需要补齐 |
| --- | --- | --- |
| `assets/palettes/mard-291.json` | 已有 291 条颜色、15 个分组；本次检查无重复 ID，RGB/HEX 一致，`id === code`；没有实测 Lab | 运行时接入、严格校验、版本与来源追踪 |
| `packages/pattern-core/src/pipeline.ts` | `maxPaletteColors = 128`，会拒绝完整 291 色；`maxSelectedColors = 48` | 分开管理材料库容量和作品用色数，扩大前者 |
| `packages/pattern-core/src/color.ts` | 已支持 Lab 和 CIEDE2000；缺少 Lab 时从 RGB 推导 | 复用现有计算，保留屏幕参考和实体测量的区别 |
| `packages/pattern-core/src/types.ts` | 材料色只有基础字段；`PatternMetadata` 没有色卡 ID/版本 | 补齐材料来源及结果身份 |
| `apps/demo/index.html` | 固定加载 `generic-24.json`，用色滑块最高 24；已有预览、材料统计和 PNG 下载 | 默认使用 MARD 291，切换色卡，展示/导出色号 |
| `apps/demo/preference-workbench.mjs` | 读取尚未由核心写入的 `metadata.paletteId/paletteVersion`，目前会回退为 unknown | 使生成、偏好记录、导出的色卡身份一致 |
| `scripts/demo-ai-api.mjs` | 提供健康检查、AI 分析和提案；传输 RGBA Base64 | 新增面向客户端的图片上传和完整图纸生成 API |
| `services/ai-gateway` | 是可复用的模型适配库 | 保持此职责，由产品 API 调用 |
| `apps/wechat-miniapp` | 只有 README | 增加调用层、配置及最小联调页面 |

目前的色卡数量检查不等于算法已经支持 291 色，也不构成实体颜色校准或性能验收。

## 2. 本期范围与默认决策

1. “291 色实装”指完整 291 色参与材料匹配，结果只引用色库内的真实色号。单张图纸默认最多 20 色，首期可选范围为 1–48 色；不把单张用色上限同步改成 291。
2. 核心材料库容量从 128 提升至 512，并保留明确的资源限制。291 色全部传入规划流程，不截取前 128 色，也不预先替换为通用色板。
3. “小程序接口”交付 HTTP API、共享 TypeScript 契约、微信调用 SDK 和原生小程序最小示例。示例覆盖选图到结果下载；完整图纸编辑器、历史作品中心、支付和分享社区留待后续。
4. 服务端负责图片解码、算法计算和可选 AI 分析，小程序负责选图、适量压缩、上传、参数、进度和展示。
5. 第一条闭环采用确定性生成，不依赖 GPU。随后接入现有 `neural-analysis`；学习型像素化、生成式提案和偏好训练不列为本期交付条件。
6. 默认单实例自部署：持久任务记录、本地私有文件目录、有限数量的计算 Worker。存储和任务调度保留替换接口，后续扩容时再引入对象存储和分布式队列。

## 3. M1：色卡与算法正式接入

### 3.1 单一数据来源与版本

- 保留 `assets/palettes/mard-291.json` 作为唯一人工维护的数据源。新增 `packages/material-palettes`，提供注册表、加载/校验和可用于浏览器与服务端的构建产物，不维护另一份手抄色值。
- 注册表同时包含 `mard-291` 和 `generic-24`。加载失败明确报错，不能悄悄切回 24 色。
- 校验 schema、声明数量、唯一 ID/code、分组数量、RGB 范围、HEX 一致性和可选 Lab 的三元有限数值。
- `paletteVersion` 使用规范化内容摘要；保留现有 upstream revision、来源和许可。输入顺序、色号、RGB、实测值等影响配色的内容变更必须可追踪。
- `MaterialColor` 增加可选的 `code/group`；`MaterialPalette` 增加可选的品牌、版本、参考色性质和来源字段。旧的内联测试色板继续可用。
- 已有实测 Lab 优先参与匹配；没有实测值时沿用 RGB 推导。推导值不写成“实测色值”，不按分组字母猜测材质。

### 3.2 算法、结果与缓存

- 集中导出资源限制：材料库最多 512 色、作品最多 48 色，以及现有输入/网格/候选数量上限。API 从这些限制派生自己的更小产品上限。
- 检查全链路的颜色索引和中间数组，避免 256 以上索引发生截断。扩容同时更新当前拒绝 129 色的测试，新边界验证 512/513。
- 在生成结果 metadata 中写入 `paletteId`、`paletteVersion`，保持候选、材料清单、偏好记录和导出一致。自定义旧色板没有显式版本时从规范化颜色内容生成版本。
- 修改色卡、最大用色数或可用颜色集合后，失效所有依赖它们的结果/缓存；旧任务继续引用提交时的色卡快照。
- 先测量 24 色与 291 色的成本，再按热点优化颜色准备、距离计算和候选搜索。缓存必须包含色卡版本及距离算法，保持结果确定性。

### 3.3 Demo 与可制作输出

- Demo 默认 MARD 291，提供色卡选择；用色控制上限为 `min(48, 当前色卡颜色数)`，切换时同步约束参数。
- 页面分开展示“材料库 291 色”和“本张使用 N 色”。材料清单显示 MARD 色号、色块和颗数，可按色号自然顺序或用量排序。
- 渲染优先读取候选自带的色卡快照，避免用户切换色卡后旧候选被错误重着色。
- 提供图纸 JSON、材料 CSV、带坐标和色号图例的 PNG。CSV 包含品牌、色卡版本、色号、HEX、数量；JSON 保存版本及空白格语义。
- 空白格保持未放豆状态，不自动计入白色材料。多候选切换时，预览、统计和导出使用同一候选。

M1 验收：真实 MARD 291 输入可生成；所有输出色号属于该版本色库；材料颗数之和等于占用格数量；24 色基线仍通过；291 色性能报告完成后再进入服务端集成。

## 4. M2：可由微信调用的产品 API

### 4.1 模块边界

新增 `services/pattern-api`，负责 HTTP、身份、上传、任务、资源及导出；新增 `packages/pattern-api-contracts`，定义经过运行时校验的请求/响应，供服务端和 SDK 共用。后者不依赖 Node、DOM 或微信运行时。

调用顺序：

```text
微信小程序 / 联调客户端
    → Pattern API（身份、图片、异步任务、结果与导出）
        → material-palettes（固定版本色卡）
        → ai-gateway（可选视觉分析）
        → pattern-core（规划、配色、网格与材料统计）
```

现有 Demo HTTP 入口继续服务本地开发。产品 API 独立启动，不将整个仓库作为静态目录对外提供；复用库层逻辑，不复制 HTML 中的完整生成流程。

### 4.2 v1 接口草案

| 方法与路径 | 用途与主要返回 |
| --- | --- |
| `GET /healthz` | API 存活；不暴露内部路径、密钥或模型服务地址 |
| `GET /v1/capabilities` | 可用生成路线、默认色卡、输入限制、网格及用色范围 |
| `POST /v1/auth/wechat` | `{ code }` 换业务会话 token 与过期时间 |
| `GET /v1/palettes` | 色卡摘要、版本、颜色数量、品牌 |
| `GET /v1/palettes/{paletteId}?version=...` | 指定版本完整色卡；支持 ETag 缓存 |
| `POST /v1/images` | multipart 单图片上传，字段名 `file`；返回 `imageId`、规范化尺寸、`expiresAt` |
| `DELETE /v1/images/{imageId}` | 删除原图；若仍被排队/运行任务引用，返回明确冲突 |
| `POST /v1/pattern-jobs` | 校验后持久化并返回 HTTP 202、`jobId`、查询地址与建议轮询间隔 |
| `GET /v1/pattern-jobs/{jobId}` | 状态、处理阶段、耗时、过期时间及结果地址 |
| `GET /v1/pattern-jobs/{jobId}/result` | 生成质量状态、推荐/备选、网格、材料统计、必要提示 |
| `POST /v1/pattern-jobs/{jobId}/cancel` | 幂等取消排队/运行任务；已终态时返回现有状态 |
| `GET /v1/pattern-jobs/{jobId}/exports/{candidateId}?format=png\|csv\|json` | 下载指定候选的文件；保持候选所属关系和权限校验 |

创建任务示例：

```json
{
  "imageId": "img_example",
  "paletteId": "mard-291",
  "paletteVersion": "sha256:<从色卡接口取得的版本>",
  "route": "deterministic",
  "options": {
    "canvas": { "mode": "fixed", "size": { "width": 48, "height": 48 } },
    "maxColors": 20,
    "maxCandidates": 3,
    "styles": ["faithful", "simple", "high-contrast"]
  }
}
```

客户端同时发送 `Idempotency-Key`。服务端按用户、键及规范化请求摘要保存 24 小时；相同请求返回同一任务，键相同但参数不同返回 409。省略色卡版本时解析当前版本并冻结，响应明确返回实际版本；未知或已不可用的显式版本必须报错。

### 4.3 数据与质量语义

- 成功 JSON 使用 `{ data, requestId }`；错误使用 `{ error: { code, message, retryable, details? }, requestId }`。导出接口成功返回对应文件类型，失败仍返回错误 JSON。
- 任务执行状态为 `queued/running/succeeded/failed/cancelled`；算法质量状态为 `success/best-effort/no-valid-candidate`。任务计算结束不代表一定有合格图纸。
- `best-effort` 返回候选及原因，不能伪装成合格推荐；用户明确接受后才导出，可用查询参数 `acceptBestEffort=true` 表达。`no-valid-candidate` 不返回可下载图纸。
- 网格采用行优先的整数索引数组，`-1` 表示空白，其他值引用本候选自带的 `colors[]`。数组长度必须等于宽×高；SDK 不用 8 位数组存颜色索引。
- 每个候选携带 `paletteId/paletteVersion`、使用颜色快照、色号计数和必要评分。服务端重算材料统计，不信任客户端提交的计数。
- 完整蒙版、RGBA、内部语义图和大量调试指标不进入默认结果。保持现有核心类型与公网 DTO 的明确转换，单独测试序列化往返。
- 约定 400 格式错误、401 会话失效、404 资源不可见/不存在、409 状态冲突、410 已过期、413 文件超限、415 格式不支持、422 参数无效、429 限流及 503 能力暂不可用。

### 4.4 上传与异步执行

- 初始产品限制：JPEG/PNG/WebP 单文件不超过 5 MiB，解码前限制源图不超过 2000 万像素；方向校正、转换 sRGB 后缩至最长边 1024，保留 PNG 透明度，去除不必要的 EXIF。以上为本项目初始配置，不是微信平台限制。
- 同时验证内容类型和实际解码结果，采用有上限的 multipart 解析，拒绝动画/多帧和畸形数据；客户端压缩仅是优化，服务端仍独立校验。
- 首期公开网格为 32/48/64/96 正方形，自动尺寸只搜索 32/48/64；最多返回 3 个候选。其余底层选项经白名单适配，禁止透传任意 Provider URL 或任意选项对象。
- 任务状态和资源元数据持久化到 SQLite，图片/结果存私有数据目录；数据库及文件不进入 Git。任务记录冻结用户、输入、色卡版本、选项及算法版本。
- CPU 核心在 Worker 中执行，首期默认计算并发 1、排队总量 20，参数可配置；排队上限返回 429。HTTP 查询不能被同步计算阻塞。
- 初始执行截止时间为确定性 60 秒、神经分析路线 180 秒；排队截止时间 5 分钟。均为待基准验证的服务配置，超时终止 Worker/上游请求并写入终态。
- 进度只报告真实阶段：排队、解码、分析、生成、导出；没有可靠总工作量时不编造百分比。
- SDK 退后台、断网或查询超时不自动取消任务；显式取消需阻止后到结果覆盖 `cancelled` 状态。
- 重启后恢复排队任务；原来运行中的任务标记为 `failed/SERVICE_RESTARTED`，由客户端提示重试，避免悄悄重复昂贵推理。
- 资源默认保留 24 小时；运行中的资源有引用保护，终态后重新计算清理时间。执行定时清理，并保留短期过期记录使接口能返回 410。

### 4.5 微信身份与可选 AI

- 微信端通过登录 code 请求业务会话，服务端完成微信登录交换；AppSecret、session_key 仅留在服务端，使用独立的有期限业务 token。
- 图片、任务、结果、导出均绑定业务用户；跨用户 ID 访问返回不可见。开发环境提供显式启用的模拟身份，生产模式禁止该入口。
- `neural-analysis` 通过已有 `ai-gateway` 调用服务端配置的 Provider，复用分析证据后进入相同生成流程。
- 客户端可选择 `failureMode: strict | best-effort`；strict 报错，best-effort 降级时返回 `actualRoute` 和提示。确定性路线不触发 AI 请求。
- 复用 `docs/privacy.md` 的自有环境处理原则：上传前说明处理位置；启用外部模型服务时单独表达授权，令牌和图片内容不进入请求日志。

M2 验收：使用 HTTP 客户端可完成登录模拟、上传、创建、查询、取结果、导出、取消；服务重启行为明确；不同用户不能交叉读取；未配置模型时确定性闭环可运行。

## 5. M3：微信 SDK 与最小联调页面

- 新增 `packages/wechat-client`，通过可注入的 `wx` 适配器封装登录、`wx.request`、`wx.uploadFile`、`wx.downloadFile`。输出微信可用的构建产物及类型，不要求 Node、DOM、fetch 或浏览器 Worker。
- 提供 `login/getCapabilities/listPalettes/getPalette/uploadImage/createPatternJob/getPatternJob/waitForPatternJob/getResult/cancelJob/downloadExport`，返回统一业务错误。
- 上传回调先检查 HTTP 状态，再解析字符串 JSON；请求成功回调不直接等同于业务成功。此类型行为已由[微信官方 API 类型定义](https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.api.d.ts)核对。
- 查询使用有抖动的退避和总时限；仅对可重试错误重试。创建任务重试复用原幂等键；登录 code 失效重新登录，不能无限重放。上传以文件摘要在用户范围去重，失败后可重新上传。
- 保存活动 `jobId` 和请求信息，`onHide` 暂停轮询、`onShow` 恢复查询；解除本地等待与服务端取消分别提供操作。生命周期依据[微信官方 App 类型定义](https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.app.d.ts)。
- 在 `apps/wechat-miniapp` 增加原生 TypeScript 工程、环境配置和单页流程：选图 → MARD 291/用色/尺寸设置 → 上传与生成 → 候选预览 → 色号清单 → 下载 PNG/CSV/JSON。
- 预览用 Canvas；网格数据保留在逻辑层，避免反复把全量网格放进 `setData`。图片保存由用户点击触发，失败和权限拒绝有可操作提示。
- 提供 SDK 构建、示例导入开发者工具、API 地址、AppID、request/uploadFile/downloadFile 域名配置说明和 `.env.example`；不提交个人配置或凭据。

M3 验收：SDK 类型检查和模拟 wx 契约测试通过；开发者工具能导入示例；具备有效账号和部署环境后，在 Android/iOS 真机验证上传、前后台恢复、弱网重试和结果保存。

## 6. M4：验证、兼容与交付

| 验证层 | 关键检查 |
| --- | --- |
| 色卡 | 完整 291 条、分组/编码/HEX、规范化版本、非法数据拒绝、来源保留 |
| 核心 | 291 输入可用；首/中/末尾色号可被映射；1/20/48 用色预算；512/513 边界；空白格；确定性；库存约束和 adapt 路径不回退 |
| 结果身份 | 色卡变化使生成身份变化；旧图纸保留原版本；偏好记录不再出现无理由的 unknown palette |
| Demo | 默认 291、切换 24/291、参数收敛、旧候选颜色、材料数量、PNG/CSV/JSON 内容一致 |
| API | DTO 校验、EXIF 方向、透明图、畸形图片、超限、鉴权与资源归属、幂等冲突、取消竞态、过期、重启 |
| 质量状态 | success、best-effort、no-valid-candidate 三种响应及导出条件 |
| SDK | HTTP 非 2xx、上传字符串解析、401、429、断网恢复、同键重试、页面销毁清理计时器 |
| 微信联调 | 正式 HTTPS 地址、三类网络域名、真机前后台切换、下载和保存 |

性能验证固定输入、算法选项和运行环境，对比 24/291 色，在 32/48/64/96 网格、fast/quality、单/多候选下记录耗时、峰值内存和材料色数。包含渐变、照片、透明主体和复杂边缘，不仅跑纯色样例。

保留现有代表性测试的 10 秒/256 MiB 与多候选 30 秒/512 MiB 门槛。新增 291 色基准先以相同代表性负载作为目标，记录预热后的多次统计；不能通过静默减少色库或放宽老测试来“通过”。96 网格与可选 AI 的预算独立实测，报告 CPU、运行时、输入尺寸及候选数。

扩展根目录 workspace 脚本和 CI，覆盖新增包，执行 `pnpm test`、`pnpm typecheck`、`pnpm build` 和相关 `pnpm test:e2e`。新增 `pnpm api:dev`、`pnpm test:api`、`pnpm wechat:build`、`pnpm benchmark:palette` 等入口，具体脚本名随包落地固定到 README。

交付物包括色卡接入、Demo 更新、API 服务、OpenAPI 文档、请求/响应示例、微信 SDK、可导入示例、性能报告和部署说明。验收记录明确区分自动化通过、开发者工具通过、真机通过，不能以 mock 测试代替真实微信验证。

## 7. 执行顺序与外部依赖

1. **M1a：色卡注册与核心扩容。** 先完成颜色数据校验、512 容量、版本、真实 291 回归及性能基准，形成独立可审查提交。
2. **M1b：Demo 与导出。** 用户可直接体验 291 色，核对色号、材料颗数和文件输出。
3. **M2：API 闭环。** 先固定契约与确定性任务，再加入身份、持久化、取消/恢复、导出及可选 AI。
4. **M3：微信适配。** SDK 和原生最小页面接入同一 v1 契约，完成模拟与开发者工具联调。
5. **M4：部署与真机验收。** 补齐环境配置，检查弱网、前后台、下载及资源到期行为，发布验证记录。

开发阶段可使用现有色卡和本地模拟身份直接推进。实际微信登录、体验版和真机联网需要可用小程序 AppID、服务端 AppSecret、可访问的 HTTPS 部署地址及对应域名配置；这些是最终联调的外部依赖，不要求先提供凭据才开始写代码。凭据通过本地环境配置提供。

当前色值来自仓库已保存的第三方屏幕参考数据；实体 Lab 测量可在后续按新色卡版本加入，不阻塞首期产品闭环。用户可见说明保持简短，说明色号来源及屏幕与实物可能存在差异。

本次尝试读取[微信网络说明](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)、[上传接口](https://developers.weixin.qq.com/miniprogram/dev/api/network/upload/wx.uploadFile.html)和[登录交换接口](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html)时官方文档站无法访问；客户端字段及生命周期已用上述官方类型仓库核对。实施联调时重新核实平台域名、基础库和登录接口要求，本计划不沿用旧研究文档中的平台超时/并发数作为当前事实。
