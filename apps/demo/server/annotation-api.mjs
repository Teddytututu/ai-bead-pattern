import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile, rename, unlink } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { validateAnnotation } from '../annotation-state.mjs'
import { createAnnotationDataset } from './annotation-dataset.mjs'

const LIMIT = 3 * 1024 * 1024
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function createAnnotationApiHandler({ directory = process.env.REGION_ANNOTATION_DIR ?? resolve('output/region-annotations'), packetPath } = {}) {
  const dataset = createAnnotationDataset({ packetPath })
  const locks = new Set()
  const read = async id => {
    try { return JSON.parse(await readFile(join(directory, id + '.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  return async (request, response) => {
    const url = new URL(request.url, 'http://localhost'), path = url.pathname
    if (path !== '/api/annotation-dataset' && path !== '/api/annotations' && !path.startsWith('/api/annotations/')) return false
    const send = (code, value) => {
      response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(value))
    }
    if (request.headers.origin && request.headers.origin !== 'http://' + request.headers.host) {
      send(403, { detail: '禁止跨站访问标注记录' }); return true
    }
    if (path === '/api/annotation-dataset') {
      if (request.method !== 'GET') { send(405, { detail: '图库仅支持读取' }); return true }
      try {
        const offset = url.searchParams.get('offset') ?? '0'
        if (!/^(0|[1-9][0-9]{0,8})$/.test(offset)) throw new Error('批次偏移无效')
        const batch = await dataset(Number(offset), url.searchParams.get('snapshot') ?? '')
        for (const item of batch.items) if (item.id) {
          const existing = await read(item.id)
          if (existing) item.record = existing
        }
        send(200, batch)
      } catch (error) { send(error.status ?? 400, { detail: error.message }) }
      return true
    }
    const id = path === '/api/annotations' ? null : path.slice('/api/annotations/'.length)
    if (id !== null && !uuid.test(id)) { send(400, { detail: '标注 ID 无效' }); return true }
    try {
      if (request.method === 'GET') {
        if (id) {
          const record = await read(id)
          send(record ? 200 : 404, record ?? { detail: '没有这条标注' })
        } else {
          let names = []
          try { names = await readdir(directory) } catch (error) { if (error.code !== 'ENOENT') throw error }
          const records = []
          for (const name of names.filter(n => uuid.test(n.replace(/\.json$/, '')) && n.endsWith('.json'))) {
            const record = await read(name.slice(0, -5))
            if (record) records.push({ id: record.annotation.id, title: record.annotation.title,
              reviewer: record.annotation.reviewer, confirmed: record.annotation.review.targetConfirmed,
              version: record.version, updatedAt: record.updatedAt })
          }
          send(200, { records: records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) })
        }
        return true
      }
      if (request.method !== 'POST' || id !== null) { send(405, { detail: '不支持该操作' }); return true }
      if (!request.headers['content-type']?.startsWith('application/json')) { send(415, { detail: '需要 JSON' }); return true }
      if (Number(request.headers['content-length']) > LIMIT) { send(413, { detail: '标注文件超过 3 MiB' }); return true }
      let bytes = 0; const parts = []
      for await (const part of request) {
        bytes += part.length
        if (bytes > LIMIT) { send(413, { detail: '标注文件超过 3 MiB' }); return true }
        parts.push(part)
      }
      let body, annotation
      try {
        body = JSON.parse(Buffer.concat(parts).toString('utf8'))
        annotation = validateAnnotation(body.annotation)
        if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) throw new Error('缺少有效保存版本')
      } catch (error) { send(422, { detail: error.message }); return true }
      const key = annotation.id
      if (locks.has(key)) { send(409, { detail: '该标注正在保存，请稍后重试' }); return true }
      locks.add(key)
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const prior = await read(key)
        if ((prior?.version ?? 0) !== body.expectedVersion) {
          send(409, { detail: '远端已有更新；请先导出当前草稿，再载入远端记录', currentVersion: prior?.version ?? 0 }); return true
        }
        const sourceSha256 = sha(annotation.currentGrid)
        const priorInput = prior?.annotation.inputReview, nextInput = annotation.inputReview
        if (prior && (Boolean(priorInput) !== Boolean(nextInput) || (priorInput &&
          (sha({ ...priorInput, occupancy: [], confirmed: false }) !== sha({ ...nextInput, occupancy: [], confirmed: false }) ||
           (priorInput.confirmed && !nextInput.confirmed))))) {
          send(422, { detail: '不能替换输入来源或撤销已保存的输入确认' }); return true
        }
        const preparingInput = priorInput && nextInput && !priorInput.confirmed && !prior.annotation.review.contextConfirmed
        if (prior && prior.sourceSha256 !== sourceSha256 && !preparingInput) {
          send(422, { detail: '同一标注不能替换原始输入，请创建新标注' }); return true
        }
        const record = { version: body.expectedVersion + 1, updatedAt: new Date().toISOString(),
          sourceSha256, annotationSha256: sha(annotation), annotation }
        const temporary = join(directory, '.' + key + '-' + randomUUID() + '.tmp')
        try {
          await writeFile(temporary, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 })
          if (annotation.review.targetConfirmed) {
            await mkdir(join(directory, 'reviewed'), { recursive: true, mode: 0o700 })
            await writeFile(join(directory, 'reviewed', key + '-v' + record.version + '.json'),
              JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 })
          }
          await rename(temporary, join(directory, key + '.json'))
        } finally { await unlink(temporary).catch(() => {}) }
        send(200, record)
      } finally { locks.delete(key) }
    } catch (error) {
      send(500, { detail: error.code === 'EDQUOT' || error.code === 'ENOSPC'
        ? '远端存储空间不足，草稿仍在浏览器；请立即导出备份'
        : '远端读写失败；浏览器草稿仍保留，请导出备份' })
    }
    return true
  }
}
