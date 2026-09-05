import {
  AIProviderRegistry,
  modelManifest,
} from '../services/ai-gateway/dist/index.js'

import { createDemoAiService } from './demo-ai-api.mjs'

export function createDemoAiE2EService() {
  const manifest = modelManifest('rembg-birefnet-general-lite')
  const samManifest = modelManifest('sam2-local')
  const groundedManifest = modelManifest('grounded-sam2-local')
  const poseManifest = modelManifest('mmpose-animal-local')
  const registry = new AIProviderRegistry()
  registry.register({
    manifest,
    async probe() {
      return { status: 'ready', checkedAt: Date.now(), latencyMs: 1, model: manifest }
    },
    async analyze(request) {
      const length = request.image.width * request.image.height
      const values = Float32Array.from({ length }, (_, index) => {
        const x = index % request.image.width
        const y = Math.floor(index / request.image.width)
        const marginX = Math.max(1, Math.floor(request.image.width * 0.08))
        const marginY = Math.max(1, Math.floor(request.image.height * 0.08))
        return x >= marginX && x < request.image.width - marginX
          && y >= marginY && y < request.image.height - marginY
          ? 1
          : 0
      })
      const mask = { width: request.image.width, height: request.image.height, values }
      return {
        providerId: manifest.providerId,
        model: manifest,
        capabilities: request.capabilities,
        confidence: 0.9,
        elapsedMs: 1,
        analysis: {
          subjectMask: mask,
          subjectMaskEvidence: {
            mask,
            confidence: 0.9,
            source: 'ai',
            revision: 'e2e:subject-mask:v1',
          },
          importanceMap: {
            width: request.image.width,
            height: request.image.height,
            weights: Float32Array.from(values, (value) => value * 0.8),
          },
          confidence: 0.9,
          modelVersions: { segmentation: manifest.modelId },
        },
      }
    },
  }, 100)
  registry.register({
    manifest: groundedManifest,
    async probe() {
      return { status: 'ready', checkedAt: Date.now(), latencyMs: 1, model: groundedManifest }
    },
    async analyze(request) {
      const length = request.image.width * request.image.height
      return {
        providerId: groundedManifest.providerId,
        model: groundedManifest,
        capabilities: request.capabilities,
        confidence: 0.93,
        elapsedMs: 2,
        instanceProposals: [{
          id: 'pet-01:cat',
          instanceId: 'pet-01',
          label: 'cat',
          bbox: { x: 0.12, y: 0.06, width: 0.76, height: 0.9 },
          maskRle: { size: [request.image.height, request.image.width], counts: [0, length] },
          confidence: 0.93,
          detectionScore: 0.92,
          predictedIoU: 0.95,
          stabilityScore: 0.97,
          promptAgreement: 1,
          selected: true,
          diagnostics: {
            promptSource: 'text+box',
            positivePointCount: 0,
            negativePointCount: 0,
            maskAreaRatio: 1,
            lassoContainment: 1,
            inferenceMs: 2,
            device: 'fixture',
          },
        }],
      }
    },
  }, 94)
  registry.register({
    manifest: poseManifest,
    async probe() {
      return { status: 'ready', checkedAt: Date.now(), latencyMs: 1, model: poseManifest }
    },
    async analyze(request) {
      const prompt = request.instancePrompts?.[0]
      if (prompt?.selectedInstanceId === undefined) {
        throw new RangeError('RTMPose fixture requires one detected pet instance')
      }
      return {
        providerId: poseManifest.providerId,
        model: poseManifest,
        capabilities: request.capabilities,
        confidence: 0.9,
        elapsedMs: 2,
        analysis: {
          imageType: 'pet',
          landmarks: [{
            id: `${prompt.selectedInstanceId}:nose-tip`,
            kind: 'nose',
            structuralRole: 'nose-tip',
            observationState: 'observed',
            x: request.image.width * 0.5,
            y: request.image.height * 0.38,
            confidence: 0.9,
            priority: 'hard',
          }],
          modelVersions: { petKeypoints: poseManifest.modelId },
        },
      }
    },
  }, 93)
  registry.register({
    manifest: samManifest,
    async probe() {
      return { status: 'ready', checkedAt: Date.now(), latencyMs: 1, model: samManifest }
    },
    async analyze(request) {
      if (request.instancePrompt?.lasso === undefined) {
        throw new RangeError('SAM 2 fixture requires a rough lasso')
      }
      const length = request.image.width * request.image.height
      const values = Float32Array.from({ length }, (_, index) => {
        const x = index % request.image.width
        const y = Math.floor(index / request.image.width)
        return x >= request.image.width * 0.2 && x < request.image.width * 0.8
          && y >= request.image.height * 0.15 && y < request.image.height * 0.85
          ? 1
          : 0
      })
      const mask = { width: request.image.width, height: request.image.height, values }
      return {
        providerId: samManifest.providerId,
        model: samManifest,
        capabilities: request.capabilities,
        confidence: 0.94,
        elapsedMs: 2,
        analysis: {
          subjectMask: mask,
          subjectMaskEvidence: {
            mask,
            confidence: 0.94,
            source: 'ai',
            revision: 'e2e:sam2-lasso:v1',
            provenance: [{
              origin: 'model',
              provider: samManifest.providerId,
              model: samManifest.modelId,
              version: samManifest.weightRevision,
            }],
          },
          confidence: 0.94,
          modelVersions: { segmentation: samManifest.modelId },
        },
      }
    },
  }, 110)
  return createDemoAiService({ registry })
}
