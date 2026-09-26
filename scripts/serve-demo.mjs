import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'

import { createDemoAiApiHandler } from './demo-ai-api.mjs'

const root = resolve(process.cwd())
const hasExplicitPort = process.env.PORT !== undefined
let port = Number(process.env.PORT ?? '4173')
if (!Number.isInteger(port) || port < 0 || port > 65535 || process.env.PORT?.trim() === '') {
  console.error('Demo 启动失败：PORT 必须是 0–65535 之间的整数。')
  process.exit(1)
}
const lastPort = hasExplicitPort ? port : port + 19
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}
const aiApiHandler = process.env.AI_BEAD_E2E_FIXTURE === '1'
  ? createDemoAiApiHandler({
      service: (await import('./demo-ai-e2e-fixture.mjs')).createDemoAiE2EService(),
    })
  : createDemoAiApiHandler()

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end(body)
}

const server = createServer(async (request, response) => {
  if (await aiApiHandler(request, response)) return
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (requestUrl.pathname === '/') {
    response.writeHead(302, { Location: '/apps/demo/' })
    response.end()
    return
  }

  let pathname
  try {
    pathname = decodeURIComponent(requestUrl.pathname.endsWith('/')
      ? `${requestUrl.pathname}index.html`
      : requestUrl.pathname)
  } catch {
    sendText(response, 400, 'Bad request')
    return
  }

  const filePath = resolve(root, `.${pathname}`)
  if (filePath !== root && filePath.startsWith(`${root}${sep}`) === false) {
    sendText(response, 403, 'Forbidden')
    return
  }

  try {
    const file = statSync(filePath)
    if (file.isFile() === false) throw new Error('File expected')
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    createReadStream(filePath).pipe(response)
  } catch {
    sendText(response, 404, 'Not found')
  }
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && port < lastPort) {
    console.warn(`Demo 端口 ${port} 已被占用，尝试 ${port + 1}…`)
    port += 1
    server.listen(port, '127.0.0.1')
    return
  }

  if (error.code === 'EADDRINUSE') {
    console.error(hasExplicitPort
      ? `Demo 启动失败：指定端口 ${port} 已被占用。请修改 PORT，或清除 PORT 后自动选择端口。`
      : `Demo 启动失败：4173–${lastPort} 均已被占用。请通过 PORT 指定其他端口。`)
  } else {
    console.error(`Demo 启动失败：${error.message}`)
  }
  process.exit(1)
})

server.once('listening', () => {
  console.log(`AI Bead Pattern demo: http://127.0.0.1:${server.address().port}/apps/demo/`)
})
server.listen(port, '127.0.0.1')
