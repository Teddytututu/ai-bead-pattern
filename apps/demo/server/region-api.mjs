// Experimental, versioned API; it is separate from the production pattern SDK.
const LIMIT = 25 * 1024 * 1024
export function createRegionApiHandler({ endpoint = process.env.SDXL_REGION_ENDPOINT ?? 'http://127.0.0.1:7117', fetchImpl = fetch } = {}) {
  const base = new URL(endpoint)
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
    throw new Error('SDXL_REGION_ENDPOINT must be a local HTTP service')
  }
  return async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    if (!path.startsWith('/api/ai/region/')) return false
    const send = (code, value) => {
      response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(value))
    }
    const routes = { '/api/ai/region/health': ['GET', '/health'], '/api/ai/region/example': ['GET', '/v1/regions/example'], '/api/ai/region/prepare': ['POST', '/v1/regions/prepare'], '/api/ai/region/generate': ['POST', '/v1/regions/generate'] }
    const route = routes[path]
    if (!route) { send(404, { detail: 'Unknown region endpoint' }); return true }
    if (request.method !== route[0]) { send(405, { detail: 'Method not allowed' }); return true }
    if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
      send(403, { detail: 'Cross-origin region requests are disabled' }); return true
    }
    if (request.method === 'POST' && !request.headers['content-type']?.startsWith('application/json')) {
      send(415, { detail: 'Expected application/json' }); return true
    }
    if (Number(request.headers['content-length']) > LIMIT) { send(413, { detail: 'Request exceeds 25 MiB' }); return true }
    try {
      let body
      if (request.method === 'POST') {
        const parts = []; let size = 0
        for await (const part of request) {
          size += part.length
          if (size > LIMIT) { send(413, { detail: 'Request exceeds 25 MiB' }); return true }
          parts.push(part)
        }
        body = Buffer.concat(parts)
        try { JSON.parse(body.toString('utf8')) } catch { send(400, { detail: 'Malformed JSON' }); return true }
      }
      const upstream = await fetchImpl(new URL(route[1], base), {
        method: route[0], headers: body ? { 'Content-Type': 'application/json' } : {}, body,
        signal: AbortSignal.timeout(10 * 60 * 1000),
      })
      const data = await upstream.json()
      send(upstream.status, data)
    } catch (error) {
      send(error.name === 'TimeoutError' ? 504 : 503, { detail: `SDXL service unavailable: ${error.message}. Run pnpm sdxl:start.` })
    }
    return true
  }
}
