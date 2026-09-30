import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createAnnotation, validateAnnotation } from '../annotation-state.mjs'

export const BATCH_SIZE = 20
const DEFAULT_PACKET = resolve('output/template-learning/ft1-preannotation-v1/pilot/review/packet.json')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export function datasetAnnotationId(task) {
  const namespace = Buffer.from('9668f57c40444ce09d731c623a991d04', 'hex')
  const bytes = createHash('sha1').update(namespace).update(task.sampleId + ':' + task.gridSha256).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80
  const hex = bytes.toString('hex')
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-')
}
export function annotationFromDatasetTask(task, datasetId) {
  const source = task.grid, n = source.width * source.height
  if (!Array.isArray(source.rgb) || source.rgb.length !== n || !Array.isArray(source.occupancy) || source.occupancy.length !== n) throw new Error('读格 JSON 不完整')
  const colors = [], indices = new Map()
  const cells = source.rgb.map(rgb => {
    if (!Array.isArray(rgb) || rgb.length !== 3 || rgb.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error('逐格 RGB 无效')
    const key = rgb.join(',')
    if (!indices.has(key)) {
      indices.set(key, colors.length)
      colors.push({ id: 'rgb-' + rgb.map(v => v.toString(16).padStart(2,'0')).join(''), rgb })
    }
    return indices.get(key)
  })
  const sampledGrid = { width: source.width, height: source.height, paletteId: 'sampled-' + task.gridSha256.slice(0,16), paletteVersion: '1', colors, cells }
  const annotation = createAnnotation(sampledGrid, { id: datasetAnnotationId(task), title: String(task.title).slice(0,200), sourceKind: 'dataset', sourceName: task.sampleId })
  annotation.inputReview = {
    datasetId, sampleId: task.sampleId, gridSha256: task.gridSha256,
    sampledGrid, occupancy: [...source.occupancy], confirmed: false,
  }
  annotation.currentGrid.cells = cells.map((c,i) => source.occupancy[i] === 0 ? -1 : c)
  annotation.targetGrid = structuredClone(annotation.currentGrid)
  annotation.prompt = 'Repair the selected facial detail to match the surrounding bead pattern, colors and expression.'
  return validateAnnotation(annotation)
}
export function createAnnotationDataset({ packetPath = process.env.REGION_ANNOTATION_PACKET ?? DEFAULT_PACKET } = {}) {
  let cached = null, stamp = null
  async function load() {
    if (!packetPath) return null
    let metadata
    try { metadata = await stat(packetPath) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    const nextStamp = metadata.mtimeMs + ':' + metadata.size
    if (stamp !== nextStamp) {
      const bytes = await readFile(packetPath)
      const packet = JSON.parse(bytes.toString('utf8'))
      if (!Array.isArray(packet.tasks) || packet.tasks.some(t => typeof t.sampleId !== 'string' || !/^[a-f0-9]{64}$/.test(t.gridSha256))) throw new Error('图库 JSON 索引无效')
      if (new Set(packet.tasks.map(t => t.sampleId)).size !== packet.tasks.length) throw new Error('图库索引有重复样本')
      cached = { datasetId: digest(bytes), tasks: packet.tasks }; stamp = nextStamp
    }
    return cached
  }
  return async function getBatch(offset = 0, snapshot = '') {
    if (!Number.isInteger(offset) || offset < 0 || offset % BATCH_SIZE !== 0) throw new Error('批次偏移必须是 20 的非负整数倍')
    const dataset = await load()
    if (!dataset) return { available: false, datasetId: null, offset: 0, batchSize: BATCH_SIZE, total: 0, items: [], hasNext: false }
    if (snapshot && snapshot !== dataset.datasetId) {
      const error = new Error('图库索引已更新，请重新载入首批；已有标注不会被覆盖')
      error.status = 409; throw error
    }
    if (offset >= dataset.tasks.length && offset !== 0) throw new Error('已到图库末尾')
    const items = dataset.tasks.slice(offset, offset + BATCH_SIZE).map(task => {
      try { return { id: datasetAnnotationId(task), sampleId: task.sampleId, title: task.title, annotation: annotationFromDatasetTask(task, dataset.datasetId) } }
      catch (error) { return { sampleId: task.sampleId, title: task.title, error: error.message } }
    })
    return { available: true, datasetId: dataset.datasetId, offset, batchSize: BATCH_SIZE, total: dataset.tasks.length,
      items, hasNext: offset + BATCH_SIZE < dataset.tasks.length, source: '已提取格图 JSON；未提取的图库图片不在队列中' }
  }
}
