import { createPatternApi } from './server.js'
const api = await createPatternApi({
  dataDir: process.env.PATTERN_DATA_DIR ?? './data', production: process.env.NODE_ENV === 'production', devAuth: process.env.PATTERN_DEV_AUTH === '1',
  ...(process.env.WECHAT_APP_ID ? { appId: process.env.WECHAT_APP_ID } : {}),
  ...(process.env.WECHAT_APP_SECRET ? { appSecret: process.env.WECHAT_APP_SECRET } : {}),
  ...(process.env.REMBG_ENDPOINT ? { rembgEndpoint: process.env.REMBG_ENDPOINT } : {}),
  ...(process.env.REMOTE_ANALYSIS_LABEL ? { remoteAnalysisLabel: process.env.REMOTE_ANALYSIS_LABEL } : {}),
})
const port = Number(process.env.PORT ?? 7105), host = process.env.HOST ?? '127.0.0.1'
api.server.listen(port, host, () => console.log(`Pattern API: http://${host}:${port}`))
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void api.close().then(() => process.exit(0)) })
