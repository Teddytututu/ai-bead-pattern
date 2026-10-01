# 微信小程序联调示例

原生 TypeScript 单页提供选图、291/24 色卡、用色/尺寸设置、上传、异步生成、Canvas 候选预览、材料清单及 PNG/CSV/JSON 下载。退后台暂停轮询，回到前台使用保存的 jobId 恢复，任务继续在服务端执行。

新增颜色策略与明暗强度：支持随风格、保色、适度增强、风格化；零强度保留原始明暗。字段经微信 SDK 的 `options.structure` 传递，语义与 [API](../../services/pattern-api/README.md) 一致。保色模式下滑块禁用，切换参数会清除待重试请求，避免复用旧参数。

## 使用

外/内轮廓提供独立开关，默认开启；候选下方显示实际轮廓格数、对比不足和证据缺失提示。五官规则模板及手动模板校正参数已移除，轮廓配置见 [API 说明](../../services/pattern-api/README.md#轮廓参数)。

1. 按 [Pattern API 说明](../../services/pattern-api/README.md)启动服务。
2. `config.ts` 已使用本机调试配置 `apiBaseUrl: http://127.0.0.1:7105` 和 `devUserId: local-demo`；真实微信登录时清空 `devUserId` 并改为 HTTPS API 地址。
3. 仓库根目录运行 `pnpm wechat:build`，生成 SDK 和页面 JS，构建产物已被忽略。
4. 微信开发者工具导入本目录。游客 AppID 只用于本地示例，请替换自己的 AppID 后测试真实登录。
5. 本机 HTTP 调试可按开发者工具设置临时关闭域名校验；上线恢复校验，配置 HTTPS API 和 request/uploadFile/downloadFile 合法域名。手机不能用 `127.0.0.1` 访问电脑服务。

上传前页面显示处理及保留说明。PNG 由用户点击后保存到相册；CSV/JSON 下载后打开微信文件分享菜单，不会自动发送给任何人。AppSecret 只配置在服务端环境变量中。

已提供 TypeScript 编译和 SDK/HTTP 自动化测试；开发者工具、Android/iOS、真实微信登录及相册权限需在对应环境验证。

## SDK 单独接入

SDK 源码及 ESM/CommonJS 输出位于 [packages/wechat-client](../../packages/wechat-client/)。通过可注入的 wx 适配器工作，不依赖 Node、DOM 或 fetch。

```ts
const client = new WechatPatternClient({ baseUrl: 'https://你的API域名', wx })
await client.login()
const image = await client.uploadImage(tempFilePath)
const job = await client.createPatternJob({ imageId: image.imageId }, requestKey)
const waiting = client.waitForPatternJob(job.jobId, { onUpdate: showStatus })
const terminal = await waiting.promise
if (terminal.state === 'succeeded') {
  const result = await client.getResult(job.jobId)
}
// 退后台：waiting.stop()；取消服务端计算：client.cancelJob(job.jobId)
```

同一次创建操作重试时复用 requestKey。SDK 同时检查 HTTP 状态和业务响应，并解析上传回调的字符串 JSON。会话失效通过 `onSessionExpired` 通知调用者。
