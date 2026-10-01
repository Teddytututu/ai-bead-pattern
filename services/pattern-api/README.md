# Pattern API v1

Node HTTP、Worker 和 SQLite 组成的异步图纸服务。确定性生成不需要 GPU；neural-analysis 可接入主体分析模型。它与浏览器 Demo 的模型代理是独立入口。

## 启动

在远端仓库根目录：

~~~bash
source scripts/dev/remote-env.sh
cp services/pattern-api/.env.example services/pattern-api/.env
pnpm api:dev
~~~

只在尚无个人 .env 时复制示例。默认端口 7105，默认数据目录 services/pattern-api/data。生产部署关闭 PATTERN_DEV_AUTH，配置 NODE_ENV=production、WECHAT_APP_ID 和 WECHAT_APP_SECRET，并使用 HTTPS 与持久数据卷。

[OpenAPI](openapi.json)和[共享契约](../../packages/pattern-api-contracts/src/index.ts)定义请求。响应使用 data/requestId 或 error/requestId 信封。

## 调用流程

1. /v1/auth/dev 提供开发身份；真实客户端经 wx.login 后调用 /v1/auth/wechat。
2. /v1/capabilities 查询能力，/v1/palettes 选择色卡及版本。
3. POST /v1/images，以 multipart 的 file 上传，使用 Bearer token。
4. POST /v1/pattern-jobs，使用唯一 Idempotency-Key；相同操作重试复用该键。
5. 轮询 /v1/pattern-jobs/{jobId}；成功后读取其 /result。
6. 选择候选，访问 /exports/{candidateId}?format=png|csv|json。

~~~json
{
  "imageId": "上传返回的 imageId",
  "paletteId": "mard-291",
  "route": "deterministic",
  "options": {
    "canvas": { "mode": "fixed", "size": { "width": 64, "height": 64 } },
    "styles": ["faithful"],
    "maxColors": 24,
    "maxCandidates": 3,
    "structure": {
      "valueMode": "preserve",
      "valueStrength": 0,
      "contours": { "external": true, "internal": false }
    }
  }
}
~~~

固定格数支持 32／48／64／96，单图最多 48 色、3 个候选。省略色卡版本时冻结当前版本，未知版本会被拒绝。

## 结果与参数

- task state 表示执行状态；generationStatus 表示图纸质量，两者不能混为一谈。
- best-effort 必须经用户检查并使用 acceptBestEffort=true 才能导出不合格候选；无候选时没有图纸。
- 网格 -1 是空板，其他索引引用 colors，材料统计只计算占用格。
- valueMode 支持 preserve／adaptive／stylized；valueStrength 为 0–1。零强度不改变明暗，不代表材料量化零色差。
- contours 的 external／internal 分别控制外／内轮廓，可指定合规 colorId。MARD 的 H7 填色排除和统一深色描边不套用到 Perler。
- 不接受 featureOverrides，不返回 featurePlacements，也没有模板修正能力。

## 模型与手机

设置 SAM2_ENDPOINT 可启用 Grounded-SAM-2；只设置 REMBG_ENDPOINT 时只有主体抠图证据。严格模式在分析失败时报错，best-effort 降级会返回警告和实际路线。

远程分析端点需配置 REMOTE_ANALYSIS_LABEL，客户端取得同意后传 consentToRemoteAnalysis。客户端不能自行指定模型 URL。手机接入见 [小程序说明](../../apps/wechat-miniapp/README.md)。

## 持久化和限制

上传支持 JPEG／PNG／WebP，最多 5 MiB、2000 万像素，拒绝动画并规范化至最长边 1024，保留透明度。默认保存 24 小时；运行任务引用的图片不会提前清理。

默认单实例、一个计算 Worker、20 个排队槽位；每用户最多 3 个活动任务、100 个有效任务和 10 张图片。断网不取消任务，可凭 jobId 恢复。显式取消终止任务，重启后原运行任务标记 SERVICE_RESTARTED；旧算法排队任务不能伪装成新版本完成。

精确配额、超时和错误以 [server.ts](src/server.ts)为准。当前不支持多个实例同时调度同一个数据库。真实微信登录、域名与真机权限仍需部署验收。

验证使用 pnpm test:api 和 pnpm typecheck。修改接口后运行 node scripts/maintenance/generate-pattern-openapi.mjs 更新规范。
