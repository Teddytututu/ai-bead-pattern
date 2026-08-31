import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'

import { createDemoAiApiHandler } from './demo-ai-api.mjs'

const root = resolve(process.cwd())
const port = Number.parseInt(process.env.PORT ?? '4173', 10)
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}
const aiApiHandler = createDemoAiApiHandler()

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end(body)
}

createServer(async (request, response) => {
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
}).listen(port, '127.0.0.1', () => {
  console.log(`AI Bead Pattern demo: http://127.0.0.1:${port}/apps/demo/`)
})
