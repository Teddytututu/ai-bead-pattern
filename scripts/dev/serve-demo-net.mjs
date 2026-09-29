import { spawnSam2 } from './sam2-command.mjs'

const endpoint = process.env.SAM2_ENDPOINT ?? 'http://127.0.0.1:7103'
async function available() {
  try {
    const response = await fetch(`${endpoint}/health/grounded`, { signal: AbortSignal.timeout(3000) })
    const health = await response.json()
    return response.ok && ['ready', 'degraded'].includes(health.status)
      && health.model?.modelId === 'IDEA-Research/grounding-dino-tiny+facebook/sam2.1-hiera-small'
  } catch { return false }
}
let child
function stop() { if (child && child.exitCode === null) child.kill() }
process.once('exit', stop)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stop(); process.exit(0) })

try {
  if (!await available()) {
    if (endpoint !== 'http://127.0.0.1:7103') throw new Error('指定的 SAM2 服务不可用')
    console.log('启动 Grounded-SAM-2 自动分割服务…')
    child = spawnSam2(['-m', 'sam2_sidecar'])
    let launchError
    child.once('error', error => { launchError = error })
    const deadline = Date.now() + 120_000
    while (!await available()) {
      if (launchError) throw launchError
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('分割服务未就绪；请先运行 pnpm sam2:setup')
      await new Promise(resolveWait => setTimeout(resolveWait, 1000))
    }
  }
  process.env.SAM2_ENDPOINT = endpoint
  await import('../../apps/demo/server/serve.mjs')
} catch (error) {
  stop()
  console.error(`神经分割 Demo 启动失败：${error.message}`)
  process.exitCode = 1
}
