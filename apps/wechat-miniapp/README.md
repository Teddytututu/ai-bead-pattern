# 微信小程序示例

客户端负责选图、上传、创建异步任务、候选预览、材料清单和 PNG／CSV／JSON 下载。生成在 Pattern API 服务端执行，手机端不加载 SDXL 或网格神经网络。

## 接入

1. 在远端启动 [Pattern API](../../services/pattern-api/README.md)。
2. 修改 config.ts 的 apiBaseUrl。开发配置的 127.0.0.1 只适用于当前设备，不能让手机访问电脑。
3. 在远端运行 pnpm wechat:build，得到 SDK 和页面 JavaScript；按远程开发流程同步构建产物后，在微信开发者工具导入本目录。
4. 真实登录清空 devUserId，配置自己的 AppID 和 HTTPS API；AppSecret 只放服务端。
5. 配置 request／uploadFile／downloadFile 域名，在 Android／iOS 验证登录、后台恢复、下载和相册权限。

页面从 API 加载 MARD、Perler、通用色卡，支持尺寸、用色、明暗强度以及内外轮廓。模板五官参数已删除。

## SDK

[wechat-client](../../packages/wechat-client/)通过可注入 wx 适配器运行，提供 ESM／CommonJS 构建。

~~~ts
const client = new WechatPatternClient({ baseUrl: 'https://你的API域名', wx })
await client.login()
const image = await client.uploadImage(tempFilePath)
const job = await client.createPatternJob({ imageId: image.imageId }, requestKey)
const waiting = client.waitForPatternJob(job.jobId, { onUpdate: showStatus })
const terminal = await waiting.promise
if (terminal.state === 'succeeded') {
  const result = await client.getResult(job.jobId)
}
~~~

同一次请求重试复用 requestKey。退后台停止轮询，回前台用 jobId 恢复；停止轮询不等于取消服务端任务。SDK 的 cancelJob 才提交取消。

图片上传前展示处理及保留说明。PNG 经用户操作保存到相册，CSV／JSON 可由用户选择分享。编译和 HTTP 测试不代替真实微信环境验收。
