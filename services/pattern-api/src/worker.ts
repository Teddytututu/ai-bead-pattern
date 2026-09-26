import { parentPort, workerData } from 'node:worker_threads'
import sharp from 'sharp'
import { createPatternAlgorithm, createPatternDocument, type ImageAnalysis } from '@ai-bead-pattern/pattern-core'
import { AIProviderRegistry, CompositeImageAnalyzer, RembgVisionProvider, RembgHttpSegmentationProvider, HttpVisionProvider, modelManifest, type AICapability } from '@ai-bead-pattern/ai-gateway'
import type { JobRecord, SavedResult } from './store.js'

const { job, imagePath, rembgEndpoint, sam2Endpoint } = workerData as { job: JobRecord; imagePath: string; rembgEndpoint?: string; sam2Endpoint?: string }
const stage = (value: string) => parentPort!.postMessage({ type: 'stage', stage: value })
try {
  stage('decoding')
  const decoded = await sharp(imagePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const image = { width: decoded.info.width, height: decoded.info.height, data: new Uint8ClampedArray(decoded.data) }
  let analysis: ImageAnalysis | undefined
  if (image.data.some((value, index) => index % 4 === 3 && value < 255)) {
    const values = Float32Array.from({ length: image.width * image.height }, (_, i) => image.data[i * 4 + 3]! / 255)
    const mask = { width: image.width, height: image.height, values }
    analysis = { confidence: 1, subjectMask: mask, subjectMaskEvidence: { mask, confidence: 1, source: 'alpha', revision: 'source-alpha-v1' } }
  }
  let actualRoute: 'deterministic' | 'neural-analysis' = 'deterministic'
  const warnings: string[] = []
  if (job.request.route === 'neural-analysis') {
    stage('analyzing')
    try {
      if (!rembgEndpoint && !sam2Endpoint) throw new Error('AI_NOT_CONFIGURED')
      const registry = new AIProviderRegistry()
      const capabilities: AICapability[] = ['subject-segmentation', 'edge-thin-structure']
      if (sam2Endpoint) {
        registry.register(new HttpVisionProvider({ manifest: modelManifest('grounded-sam2-local'), endpoint: sam2Endpoint, healthPath: '/health/grounded', timeoutMs: 180_000 }))
        capabilities.push('semantic-parsing', 'keypoints')
      } else {
        registry.register(new RembgVisionProvider({ segmentation: new RembgHttpSegmentationProvider({ endpoint: rembgEndpoint!, defaultModel: 'birefnet-general-lite', timeoutMs: 60_000 }) }))
        warnings.push('当前仅配置主体分割模型，未启用部件蒙版识别。')
      }
      const result = await new CompositeImageAnalyzer(registry).analyze({ image, route: 'neural-analysis', capabilities, failureMode: 'strict', timeoutMs: 180_000 })
      warnings.push(...(result.warnings ?? []))
      analysis = result.analysis; actualRoute = 'neural-analysis'
    } catch {
      if (job.request.failureMode === 'strict') throw new Error('AI_UNAVAILABLE')
      warnings.push('AI 分析不可用，已使用确定性生成。')
    }
  }
  stage('generating')
  const result = await createPatternAlgorithm().generate({ image, palette: job.palette, options: job.request.options, ...(analysis ? { analysis } : {}) })
  const primary = result.recommended ?? result.bestEffort
  const candidates = primary ? [primary, ...result.alternatives].slice(0, job.request.options.maxCandidates ?? 3) : []
  const saved: SavedResult = {
    view: {
      generationId: result.generationId, generationStatus: result.status, actualRoute, warnings,
      ...(result.recommended ? { recommendedId: result.recommended.id } : {}),
      ...(result.bestEffort ? { bestEffortId: result.bestEffort.id } : {}),
      candidates: candidates.map(c => ({ id: c.id, style: c.style, valid: c.valid, score: c.score.total, reasons: c.rejectionReasons, pattern: createPatternDocument(c.pattern),
        contourPlan: c.contourPlan, featurePlacements: c.featurePlacements })),
    },
    patterns: Object.fromEntries(candidates.map(c => [c.id, c.pattern])),
  }
  stage('exporting')
  parentPort!.postMessage({ type: 'result', result: saved })
} catch (error) {
  const code = error instanceof Error && error.message === 'AI_UNAVAILABLE' ? 'AI_UNAVAILABLE' : 'GENERATION_FAILED'
  parentPort!.postMessage({ type: 'failure', error: { code, message: code === 'AI_UNAVAILABLE' ? 'AI 分析服务暂不可用' : '生成失败，请调整参数后重试', retryable: true } })
}
