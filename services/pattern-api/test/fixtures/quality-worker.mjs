import { parentPort, workerData } from 'node:worker_threads'
import { createPatternDocument } from '../../../../packages/pattern-core/dist/index.js'
const { job } = workerData
const bestEffort = job.request.options.imageType === 'portrait'
const color = job.palette.colors[0]
const pattern = { width: 1, height: 1, palette: [color], cells: [{ x: 0, y: 0, colorId: color.id }], metadata: { sourceWidth: 1, sourceHeight: 1, totalBeads: 1, generatedAt: 0, algorithmVersion: 'fixture', aiEnhanced: false, style: 'faithful', baseline: 'a0', paletteId: job.palette.id, paletteVersion: job.palette.version } }
const candidate = { id: 'fixture-candidate', style: 'faithful', valid: false, score: .2, reasons: ['feature-missing'], pattern: createPatternDocument(pattern) }
parentPort.postMessage({ type: 'result', result: {
  view: { generationId: 'fixture', generationStatus: bestEffort ? 'best-effort' : 'no-valid-candidate', actualRoute: 'deterministic', warnings: [], candidates: bestEffort ? [candidate] : [], ...(bestEffort ? { bestEffortId: candidate.id } : {}) },
  patterns: bestEffort ? { [candidate.id]: pattern } : {},
} })
