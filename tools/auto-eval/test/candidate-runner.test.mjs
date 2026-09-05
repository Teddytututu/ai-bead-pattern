import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'

import {
  composeAutoEvalCandidateEvaluation,
  createCandidateOpenClipViewPlan,
  generateCandidateBatch,
  mergeAnalysis,
  planAutoEvalCandidateInputs,
  resolvePetSampleAnalysis,
} from '../src/candidate-runner.mjs'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const palettePath = join(repositoryRoot, 'assets', 'palettes', 'generic-24.json')
const sampleImagePath = join(repositoryRoot, 'apps', 'demo', 'assets', 'sample-cat.png')
const sampleMaskPath = join(repositoryRoot, 'apps', 'demo', 'assets', 'sample-cat-mask.png')

const openClipModel = {
  providerId: 'openclip-vit-b32-pair-local',
  modelId: 'mlfoundations/open_clip/ViT-B-32/laion2b_s34b_b79k',
  modelVersion: 'open_clip_torch-3.3.0',
  sourceRevision: '30573618fc375b12f094ef64cb3a1391cf611c45',
  weightSource: 'https://huggingface.co/laion/CLIP-ViT-B-32-laion2B-s34B-b79K/tree/1a25a446712ba5ee05982a381eed697ef9b435cf',
  weightRevision: 'hf:1a25a446712ba5ee05982a381eed697ef9b435cf',
  license: {
    spdx: 'MIT',
    name: 'MIT License',
    url: 'https://github.com/mlfoundations/open_clip/blob/v3.3.0/LICENSE',
  },
}

const scoredViewsByCandidate = new Map()
const scoredFramesByCandidate = new Map()

const fixedOpenClipScorer = {
  async scorePair(request) {
    assert.ok(request.referenceImage.width > 0)
    assert.ok(request.candidateImage.width >= request.targetGrid.width)
    const scoredViews = scoredViewsByCandidate.get(request.candidateId) ?? []
    scoredViews.push(request.viewId)
    scoredViewsByCandidate.set(request.candidateId, scoredViews)
    const scoredFrames = scoredFramesByCandidate.get(request.candidateId) ?? []
    scoredFrames.push({
      id: request.viewId,
      reference: [request.referenceImage.width, request.referenceImage.height],
      candidate: [request.candidateImage.width, request.candidateImage.height],
    })
    scoredFramesByCandidate.set(request.candidateId, scoredFrames)
    const preferred = request.candidateId.startsWith('B-identity')
    const values = preferred ? [0.94, 0.92, 0.8] : [0.18, 0.22, -0.75]
    return {
      providerId: openClipModel.providerId,
      model: openClipModel,
      capabilities: ['embedding', 'preference-scoring'],
      confidence: 0.95,
      elapsedMs: 7,
      preferenceFeatures: {
        modelId: openClipModel.modelId,
        names: ['semanticRetention', 'classDistributionRetention', 'petBirdMargin'],
        values: Float32Array.from(values),
        confidence: 0.95,
        scope: 'pair',
        candidateId: request.candidateId,
      },
    }
  },
}

const dinoV2Model = {
  providerId: 'dinov2-vits14-pair-local',
  modelId: 'facebook/dinov2-small',
  modelVersion: 'transformers-5.16.1+dinov2-vits14',
  sourceRevision: '7764ea0f912e53c92e82eb78a2a1631e92725fc8',
  weightSource: 'https://huggingface.co/facebook/dinov2-small/tree/ed25f3a31f01632728cabb09d1542f84ab7b0056',
  weightRevision: 'hf:ed25f3a31f01632728cabb09d1542f84ab7b0056',
  license: {
    spdx: 'Apache-2.0',
    name: 'Apache License 2.0',
    url: 'https://github.com/facebookresearch/dinov2/blob/7764ea0f912e53c92e82eb78a2a1631e92725fc8/LICENSE',
  },
}

const dinoFeatureNames = ['global', 'subject', 'head', 'critical-local'].flatMap((view) => [
  `${view}.identitySimilarity`,
  `${view}.patchCorrespondence`,
  `${view}.criticalPatchRetention`,
  `${view}.regionalCoverage`,
])

const fixedDinoV2Scorer = {
  async scorePair(request) {
    assert.ok(request.referenceImage.width > 0)
    assert.ok(request.candidateImage.width >= request.targetGrid.width)
    const preferred = request.candidateId.startsWith('B-identity')
    const base = preferred ? 0.96 : 0.2
    const comparisons = ['global', 'subject', 'head', 'critical-local'].map((view, index) => ({
      view,
      identitySimilarity: base - index * 0.01,
      patchCorrespondence: base - 0.03 - index * 0.01,
      criticalPatchRetention: base - 0.05 - index * 0.01,
      regionalCoverage: base - 0.07 - index * 0.01,
      confidence: 0.94 - index * 0.01,
    }))
    return {
      providerId: dinoV2Model.providerId,
      model: dinoV2Model,
      capabilities: ['embedding', 'preference-scoring'],
      confidence: 0.94,
      elapsedMs: 11,
      preferenceFeatures: {
        modelId: dinoV2Model.modelId,
        names: dinoFeatureNames,
        values: Float32Array.from(comparisons.flatMap((entry) => [
          entry.identitySimilarity,
          entry.patchCorrespondence,
          entry.criticalPatchRetention,
          entry.regionalCoverage,
        ])),
        confidence: 0.93,
        scope: 'pair',
        candidateId: request.candidateId,
        regionalComparisons: comparisons,
      },
    }
  },
}

function identitiesBySize(index) {
  const result = {}
  for (const candidate of index.generations[0].candidates) {
    const size = `${candidate.grid.width}x${candidate.grid.height}`
    const identities = result[size] ?? new Set()
    identities.add(candidate.canvasPlan.id)
    result[size] = identities
  }
  return Object.fromEntries(Object.entries(result).map(([size, identities]) => [
    size,
    [...identities].sort(),
  ]))
}

function twoPetAnalysisFixture() {
  const width = 80
  const height = 40
  const data = new Uint8ClampedArray(width * height * 4)
  const values = new Float32Array(width * height)
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 174
    data[index * 4 + 1] = 126
    data[index * 4 + 2] = 86
    data[index * 4 + 3] = 255
  }
  const fill = (left, top, right, bottom) => {
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) values[y * width + x] = 1
    }
  }
  const color = (x, y, red, green, blue) => {
    const offset = (y * width + x) * 4
    data[offset] = red
    data[offset + 1] = green
    data[offset + 2] = blue
  }
  fill(5, 15, 25, 30)
  fill(10, 5, 13, 15)
  fill(19, 6, 22, 15)
  fill(48, 12, 74, 34)
  fill(53, 1, 57, 12)
  fill(66, 2, 70, 12)
  for (const [x, y] of [[12, 18], [20, 18], [58, 16], [66, 16]]) color(x, y, 20, 28, 18)
  color(16, 23, 220, 72, 82)
  color(62, 21, 220, 72, 82)
  return {
    image: { width, height, data },
    mask: { width, height, values },
    metadata: {
      evidence: {
        confidence: 0.98,
        source: 'ai',
        revision: 'two-pet-fixture-v1',
        provenance: [{ origin: 'model', provider: 'fixture', model: 'binary-mask', version: '1' }],
      },
      modelVersions: { segmentation: 'fixture/1' },
    },
  }
}

function identitySourceMapping(width, height) {
  const mapping = new Float32Array(width * height * 2)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = y * width + x
    mapping[index * 2] = x
    mapping[index * 2 + 1] = y
  }
  return mapping
}

function candidateForInstances(fixture, analysis, instanceIds, scoreByInstance = {}) {
  const activeMasks = instanceIds.map((instanceId) => analysis.semanticRegions
    .find((region) => region.id === `${instanceId}:subject`).mask)
  const activeValues = new Float32Array(fixture.image.width * fixture.image.height)
  for (const mask of activeMasks) for (let index = 0; index < activeValues.length; index += 1) {
    activeValues[index] = Math.max(activeValues[index], mask.values[index])
  }
  const cells = []
  const candidateData = new Uint8ClampedArray(fixture.image.data.length).fill(255)
  for (let index = 0; index < activeValues.length; index += 1) {
    candidateData[index * 4 + 3] = 255
    if (activeValues[index] < 0.5) continue
    const x = index % fixture.image.width
    const y = Math.floor(index / fixture.image.width)
    cells.push({ x, y, colorId: 'body' })
    candidateData.set(fixture.image.data.subarray(index * 4, index * 4 + 4), index * 4)
  }
  const featurePlacements = (analysis.landmarks ?? []).flatMap((landmark) => {
    const instanceId = instanceIds.find((id) => landmark.id.startsWith(`${id}:`))
    if (instanceId === undefined) return []
    return [{
      featureId: landmark.id,
      kind: landmark.kind,
      center: [landmark.x, landmark.y],
      occupiedCells: [Math.round(landmark.y) * fixture.image.width + Math.round(landmark.x)],
      score: scoreByInstance[instanceId] ?? landmark.confidence,
    }]
  })
  return {
    candidateImage: { width: fixture.image.width, height: fixture.image.height, data: candidateData },
    candidate: {
      pattern: { width: fixture.image.width, height: fixture.image.height, cells },
      canvasPlan: {
        crop: { x: 0, y: 0, width: fixture.image.width, height: fixture.image.height },
      },
      structurePlan: { sourceMapping: identitySourceMapping(fixture.image.width, fixture.image.height) },
      featurePlacements,
      metrics: { featureVisibilityConfidence: 0.9 },
    },
  }
}

describe('OpenCLIP candidate view planning', () => {
  it('keeps a vanished pet planned without borrowing pixels from another pet', () => {
    const fixture = twoPetAnalysisFixture()
    const analysis = mergeAnalysis(fixture.image, fixture.mask, fixture.metadata, 'pet')
    const { candidate, candidateImage } = candidateForInstances(fixture, analysis, ['pet-01'])
    const plan = createCandidateOpenClipViewPlan({
      referenceImage: fixture.image,
      candidateImage,
      analysis,
      candidate,
    })
    const selected = plan.views.map((view) => view.id)

    assert.ok(plan.plannedViewIds.includes('pet-02:subject-mask'))
    assert.ok(plan.plannedViewIds.includes('pet-02:face-mask'))
    assert.equal(selected.includes('pet-02:subject-mask'), false)
    assert.equal(selected.includes('pet-02:face-mask'), false)
  })

  it('uses the authoritative subject evidence mask for the subject view', () => {
    const fixture = twoPetAnalysisFixture()
    const complete = mergeAnalysis(fixture.image, fixture.mask, fixture.metadata, 'pet')
    const { subjectMask: compatibilityMask, ...analysis } = complete
    assert.ok(compatibilityMask)
    const { candidate, candidateImage } = candidateForInstances(
      fixture,
      complete,
      ['pet-01', 'pet-02'],
    )
    const plan = createCandidateOpenClipViewPlan({
      referenceImage: fixture.image,
      candidateImage,
      analysis,
      candidate,
    })

    assert.ok(plan.views.some((view) => view.id === 'subject-mask'))
    assert.ok(plan.plannedViewIds.includes('subject-mask'))
  })

  it('derives each pet face confidence from placements in the same instance', () => {
    const fixture = twoPetAnalysisFixture()
    const base = mergeAnalysis(fixture.image, fixture.mask, fixture.metadata, 'pet')
    const analysis = {
      ...base,
      semanticRegions: base.semanticRegions.map((region) => ({ ...region, confidence: 1 })),
    }
    const { candidate, candidateImage } = candidateForInstances(
      fixture,
      analysis,
      ['pet-01', 'pet-02'],
      { 'pet-01': 0.25, 'pet-02': 0.85 },
    )
    const plan = createCandidateOpenClipViewPlan({
      referenceImage: fixture.image,
      candidateImage,
      analysis,
      candidate,
    })
    const first = plan.views.find((view) => view.id === 'pet-01:face-mask')
    const second = plan.views.find((view) => view.id === 'pet-02:face-mask')

    assert.ok(first)
    assert.ok(second)
    assert.ok(Math.abs(first.evidenceConfidence - 0.25) < 1e-12)
    assert.ok(Math.abs(second.evidenceConfidence - 0.85) < 1e-12)
  })

  it('leaves a single-point pet head out of the scoring plan', () => {
    const fixture = twoPetAnalysisFixture()
    const base = mergeAnalysis(fixture.image, fixture.mask, fixture.metadata, 'pet')
    const loneLandmark = base.landmarks.find((landmark) => landmark.id.startsWith('pet-01:'))
    assert.ok(loneLandmark)
    const analysis = { ...base, landmarks: [loneLandmark] }
    const { candidate, candidateImage } = candidateForInstances(
      fixture,
      analysis,
      ['pet-01', 'pet-02'],
    )
    const plan = createCandidateOpenClipViewPlan({
      referenceImage: fixture.image,
      candidateImage,
      analysis,
      candidate,
    })

    assert.equal(plan.views.some((view) => view.id === 'pet-01:head-landmarks'), false)
    assert.equal(plan.plannedViewIds.includes('pet-01:head-landmarks'), false)
  })
})

describe('automatic candidate evaluation provider fallback', () => {
  it('keeps OpenCLIP ranking evidence active when every DINOv2 request fails', () => {
    const candidates = [
      {
        id: 'rule-winner', valid: true, score: { total: 0.8 },
        openClipEvaluation: {
          model: { modelId: openClipModel.modelId }, confidence: 0.9, elapsedMs: 8,
        },
        preferenceFeatures: [{
          providerId: openClipModel.providerId,
          modelId: openClipModel.modelId,
          candidateId: 'rule-winner',
          names: ['semanticRetention'], values: [0.2], confidence: 0.9,
        }],
      },
      {
        id: 'identity-winner', valid: true, score: { total: 0.72 },
        openClipEvaluation: {
          model: { modelId: openClipModel.modelId }, confidence: 0.9, elapsedMs: 8,
        },
        preferenceFeatures: [{
          providerId: openClipModel.providerId,
          modelId: openClipModel.modelId,
          candidateId: 'identity-winner',
          names: ['semanticRetention'], values: [0.96], confidence: 0.9,
        }],
      },
    ]
    const evaluation = composeAutoEvalCandidateEvaluation(candidates, [{
      providerId: dinoV2Model.providerId,
      candidateId: 'rule-winner',
      elapsedMs: 120_000,
      message: 'Vision provider request timed out',
    }])

    assert.deepEqual(evaluation.providerContributions.map((entry) => [entry.providerId, entry.status]), [
      ['dinov2-vits14-pair-local', 'failed'],
      ['openclip-vit-b32-pair-local', 'used'],
    ])
    assert.deepEqual(evaluation.finalRankedCandidateIds, ['identity-winner', 'rule-winner'])
    assert.deepEqual(evaluation.appliedSourceWeights, {
      rule: 0.4,
      neural: 0.6,
      humanPreference: 0,
    })
  })
})

describe('automatic candidate batch persistence', () => {
  let temporaryDirectory
  let manifestPath
  let sidecarDirectory
  let firstBatch
  let secondBatch
  let modelBatch
  let petAnalyzerCalls = 0
  const petAnalyzerRequests = []

  it('keeps significant pet instances isolated in analysis, landmarks, and the shared crop', () => {
    const fixture = twoPetAnalysisFixture()
    const analysis = mergeAnalysis(fixture.image, fixture.mask, fixture.metadata, 'pet')

    assert.equal(analysis.modelVersions.petInstances, '2')
    assert.ok(analysis.suggestedCrop.x <= 5)
    assert.ok(analysis.suggestedCrop.x + analysis.suggestedCrop.width >= 75)
    assert.ok(analysis.semanticRegions.some((region) => region.id === 'pet-01:subject'))
    assert.ok(analysis.semanticRegions.some((region) => region.id === 'pet-02:subject'))
    assert.ok(analysis.landmarks.some((landmark) => landmark.id.startsWith('pet-01:')))
    assert.ok(analysis.landmarks.some((landmark) => landmark.id.startsWith('pet-02:')))
    assert.equal(new Set(analysis.landmarks.map((landmark) => landmark.id)).size, analysis.landmarks.length)
  })

  it('expands multi-pet inputs into group recipes and identity-focused 48/64 recipes', () => {
    const fixture = twoPetAnalysisFixture()
    const analysis = mergeAnalysis(fixture.image, fixture.mask, fixture.metadata, 'pet')
    const inputs = planAutoEvalCandidateInputs({
      category: 'pet',
      image: fixture.image,
      analysis,
    })

    const group = inputs.filter((input) => input.composition.id === 'pet-group')
    const firstFocus = inputs.filter((input) => input.composition.id === 'pet-focus-pet-01')
    const secondFocus = inputs.filter((input) => input.composition.id === 'pet-focus-pet-02')
    assert.equal(group.length, 12)
    assert.deepEqual(firstFocus.map((input) => input.id), [
      'B-identity-48--pet-focus-pet-01',
      'B-identity-64--pet-focus-pet-01',
    ])
    assert.deepEqual(secondFocus.map((input) => input.id), [
      'B-identity-48--pet-focus-pet-02',
      'B-identity-64--pet-focus-pet-02',
    ])
    assert.ok(group.every((input) => input.id.endsWith('--pet-group')))
    assert.ok(firstFocus.every((input) => input.composition.relativeScaleGain > 1))
    assert.ok(secondFocus.every((input) => input.composition.relativeScaleGain > 1))
    assert.deepEqual(
      firstFocus[0].analysis.semanticRegions
        .filter((region) => /^pet-\d+:subject$/.test(region.id))
        .map((region) => region.id),
      ['pet-01:subject'],
    )
    assert.deepEqual(
      secondFocus[0].analysis.semanticRegions
        .filter((region) => /^pet-\d+:subject$/.test(region.id))
        .map((region) => region.id),
      ['pet-02:subject'],
    )
    assert.deepEqual(firstFocus[0].analysis.suggestedCrop, firstFocus[0].composition.crop)
    assert.deepEqual(secondFocus[0].analysis.suggestedCrop, secondFocus[0].composition.crop)
  })

  it('builds independent OpenCLIP identity views for every detected pet', () => {
    const fixture = twoPetAnalysisFixture()
    const analysis = mergeAnalysis(fixture.image, fixture.mask, fixture.metadata, 'pet')
    const cells = []
    const sourceMapping = new Float32Array(fixture.image.width * fixture.image.height * 2)
    for (let y = 0; y < fixture.image.height; y += 1) for (let x = 0; x < fixture.image.width; x += 1) {
      const index = y * fixture.image.width + x
      sourceMapping[index * 2] = x
      sourceMapping[index * 2 + 1] = y
      if (fixture.mask.values[index] >= 0.5) cells.push({ x, y, colorId: 'body' })
    }
    const candidate = {
      pattern: { width: fixture.image.width, height: fixture.image.height, cells },
      canvasPlan: { crop: { x: 0, y: 0, width: fixture.image.width, height: fixture.image.height } },
      structurePlan: { sourceMapping },
      featurePlacements: analysis.landmarks.map((landmark) => ({
        featureId: landmark.id,
        kind: landmark.kind,
        center: [landmark.x, landmark.y],
        occupiedCells: [Math.round(landmark.y) * fixture.image.width + Math.round(landmark.x)],
        score: landmark.confidence,
      })),
      metrics: { featureVisibilityConfidence: 0.9 },
    }

    const plan = createCandidateOpenClipViewPlan({
      referenceImage: fixture.image,
      candidateImage: fixture.image,
      analysis,
      candidate,
    })

    assert.deepEqual(plan.views.map((view) => view.id), [
      'global',
      'subject-mask',
      'pet-01:subject-mask',
      'pet-01:face-mask',
      'pet-01:head-landmarks',
      'pet-02:subject-mask',
      'pet-02:face-mask',
      'pet-02:head-landmarks',
    ])
    assert.deepEqual(plan.plannedViewIds, plan.views.map((view) => view.id))
  })

  before(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'ai-bead-pattern-auto-eval-'))
    sidecarDirectory = join(temporaryDirectory, 'sidecars')
    await mkdir(sidecarDirectory, { recursive: true })
    await Promise.all([
      copyFile(sampleImagePath, join(sidecarDirectory, 'cat.png')),
      copyFile(sampleMaskPath, join(sidecarDirectory, 'cat-mask.png')),
    ])

    manifestPath = join(temporaryDirectory, 'manifest.json')
    await writeFile(manifestPath, JSON.stringify({
      datasetId: 'candidate-runner-contract',
      samples: [{
        imageId: 'cat-source',
        category: 'pet',
        cohort: 'contract-fixture',
        failureTags: ['ear-tip', 'facial-feature-loss'],
      }],
    }))
    await writeFile(join(sidecarDirectory, 'cat-source.analysis.json'), JSON.stringify({
      source: { path: 'cat.png' },
      mask: { path: 'cat-mask.png' },
      evidence: {
        confidence: 0.98,
        source: 'ai',
        revision: 'candidate-runner-contract-v1',
        provenance: [{
          origin: 'model',
          provider: 'test-fixture',
          model: 'sample-cat-mask',
          version: '1',
        }],
      },
      modelVersions: { segmentation: 'sample-cat-mask/1' },
    }))

    firstBatch = await generateCandidateBatch({
      manifestPath,
      sidecarDirectory,
      palettePath,
      outputDirectory: join(temporaryDirectory, 'first'),
    })
    secondBatch = await generateCandidateBatch({
      manifestPath,
      sidecarDirectory,
      palettePath,
      outputDirectory: join(temporaryDirectory, 'second'),
      openClipScorer: fixedOpenClipScorer,
      dinoV2Scorer: fixedDinoV2Scorer,
    })
    modelBatch = await generateCandidateBatch({
      manifestPath,
      sidecarDirectory,
      palettePath,
      outputDirectory: join(temporaryDirectory, 'model-analysis'),
      petAnalyzer: {
        async analyze(request) {
          petAnalyzerCalls += 1
          petAnalyzerRequests.push(request)
          const width = request.image.width
          const height = request.image.height
          const values = new Float32Array(width * height)
          const crop = {
            x: Math.floor(width * 0.18),
            y: Math.floor(height * 0.08),
            width: Math.ceil(width * 0.64),
            height: Math.ceil(height * 0.82),
          }
          for (let y = crop.y; y < crop.y + crop.height; y += 1) {
            for (let x = crop.x; x < crop.x + crop.width; x += 1) values[y * width + x] = 1
          }
          const mask = { width, height, values }
          const provenance = [{
            origin: 'model',
            provider: 'grounded-sam2-local',
            model: 'grounded-sam2-test',
            version: '1',
          }]
          return {
            route: 'neural-analysis',
            analysis: {
              subjectMask: mask,
              subjectMaskEvidence: {
                mask,
                confidence: 0.99,
                source: 'ai',
                revision: 'grounded-sam2-test-v1',
                provenance,
              },
              semanticRegions: [{
                id: 'pet-01:subject',
                label: 'cat',
                mask,
                confidence: 0.99,
                importance: 1,
                provenance,
              }],
              landmarks: [
                {
                  id: 'pet-01:left-eye-center', kind: 'eye', structuralRole: 'eye-center',
                  x: crop.x + crop.width * 0.34, y: crop.y + crop.height * 0.28,
                  confidence: 0.98, priority: 'hard', observationState: 'observed',
                  symmetryGroup: 'pet-01:eyes', provenance,
                },
                {
                  id: 'pet-01:right-eye-center', kind: 'eye', structuralRole: 'eye-center',
                  x: crop.x + crop.width * 0.66, y: crop.y + crop.height * 0.28,
                  confidence: 0.98, priority: 'hard', observationState: 'observed',
                  symmetryGroup: 'pet-01:eyes', provenance,
                },
                {
                  id: 'pet-01:nose-tip', kind: 'nose', structuralRole: 'nose-tip',
                  x: crop.x + crop.width * 0.5, y: crop.y + crop.height * 0.45,
                  confidence: 0.97, priority: 'hard', observationState: 'observed', provenance,
                },
              ],
              suggestedCrop: crop,
              suggestedCropConfidence: 0.99,
              suggestedCropSource: 'automatic',
              imageType: 'pet',
              confidence: 0.98,
              modelVersions: {
                'subject-segmentation': 'grounded-sam2-test/1',
                keypoints: 'mmpose-test/1',
              },
              provenance,
            },
            instanceProposals: [{ instanceId: 'pet-01' }],
            learnedProposals: [],
            preferenceFeatures: [],
            contributions: [
              {
                providerId: 'grounded-sam2-local', modelId: 'grounded-sam2-test',
                capabilities: ['subject-segmentation', 'edge-thin-structure'],
                status: 'used', confidence: 0.99, elapsedMs: 12,
              },
              {
                providerId: 'mmpose-animal-local', modelId: 'mmpose-test',
                capabilities: ['keypoints'], status: 'used', confidence: 0.97, elapsedMs: 8,
              },
            ],
            uncoveredCapabilities: [],
          }
        },
      },
    })
  })

  after(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  it('persists candidate validity, rejection reasons, and structural-unit budgets', () => {
    const candidates = firstBatch.index.generations[0].candidates
    assert.ok(candidates.length > 0)
    for (const candidate of candidates) {
      assert.equal(typeof candidate.valid, 'boolean')
      assert.ok(Array.isArray(candidate.rejectionReasons))
      assert.equal(typeof candidate.canvasPlan.id, 'string')
      assert.deepEqual(candidate.canvasPlan.size, candidate.grid)
      assert.ok(Array.isArray(candidate.canvasPlan.structuralUnitBudgets))
    }
    assert.deepEqual(
      firstBatch.index.generations[0].evaluation.candidateValidity,
      Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate.valid])),
    )
    const ranked = firstBatch.index.generations[0].evaluation.finalRankedCandidateIds
    const firstRejected = ranked.findIndex((candidateId) =>
      firstBatch.index.generations[0].evaluation.candidateValidity[candidateId] === false)
    if (firstRejected >= 0) {
      assert.ok(ranked.slice(firstRejected).every((candidateId) =>
        firstBatch.index.generations[0].evaluation.candidateValidity[candidateId] === false))
    }
  })

  it('keeps deterministic and distinct 32, 48, and 64 canvas identities for one source', () => {
    const firstIdentities = identitiesBySize(firstBatch.index)
    const secondIdentities = identitiesBySize(secondBatch.index)
    const firstCandidateIds = firstBatch.index.generations[0].candidates.map((candidate) => candidate.id)
    const secondCandidateIds = secondBatch.index.generations[0].candidates.map((candidate) => candidate.id)

    assert.deepEqual(Object.keys(firstIdentities).sort(), ['32x32', '48x48', '64x64'])
    assert.deepEqual(secondIdentities, firstIdentities)
    const identities = Object.values(firstIdentities).flat()
    assert.equal(new Set(identities).size, identities.length)
    assert.equal(new Set(firstCandidateIds).size, firstCandidateIds.length)
    assert.deepEqual(secondCandidateIds, firstCandidateIds)
  })

  it('persists both visual-model feature sets and lets them change the final candidate ranking', () => {
    const generation = secondBatch.index.generations[0]
    assert.equal(generation.evaluation.neuralPreferenceFeatures.length, generation.candidates.length * 2)
    assert.deepEqual(generation.evaluation.providerContributions.map((entry) => [entry.providerId, entry.status]), [
      ['dinov2-vits14-pair-local', 'used'],
      ['openclip-vit-b32-pair-local', 'used'],
    ])
    assert.deepEqual(generation.evaluation.sourceWeights, {
      rule: 0.4,
      neural: 0.6,
      humanPreference: 0,
    })
    assert.match(generation.evaluation.finalRankedCandidateIds[0], /^B-identity-/)
    for (const candidate of generation.candidates) {
      assert.equal(candidate.openClipEvaluation.scope, 'pair')
      assert.equal(candidate.openClipEvaluation.candidateId, candidate.id)
      assert.equal(candidate.dinoV2Evaluation.scope, 'pair')
      assert.equal(candidate.dinoV2Evaluation.candidateId, candidate.id)
      assert.equal(candidate.preferenceFeatures.length, 2)
      assert.deepEqual(candidate.preferenceFeatures.map((entry) => entry.providerId), [
        'dinov2-vits14-pair-local',
        'openclip-vit-b32-pair-local',
      ])
      assert.equal(candidate.neuralPreferenceFeatures.candidateId, candidate.id)
      assert.deepEqual(scoredViewsByCandidate.get(candidate.id), [
        'global',
        'subject-mask',
        'face-mask',
        'head-landmarks',
      ])
      assert.deepEqual(Object.keys(candidate.openClipEvaluation.views), [
        'global',
        'subject-mask',
        'face-mask',
        'head-landmarks',
      ])
      const globalFrame = scoredFramesByCandidate.get(candidate.id).find((view) => view.id === 'global')
      assert.deepEqual(globalFrame.reference, [candidate.canvasPlan.crop.width, candidate.canvasPlan.crop.height])
      assert.deepEqual(globalFrame.candidate, [candidate.grid.width * 10, candidate.grid.height * 10])
      assert.ok(candidate.openClipEvaluation.views['subject-mask'].geometry.areaScaleRatio < 2)
      assert.ok(candidate.openClipEvaluation.views['subject-mask'].geometry.centerOffset < 0.3)
      assert.ok(candidate.openClipEvaluation.views['face-mask'].weight
        > candidate.openClipEvaluation.views['subject-mask'].weight)
      assert.ok(candidate.openClipEvaluation.views['head-landmarks'].weight
        > candidate.openClipEvaluation.views['face-mask'].weight)
    }
  })

  it('keeps the service-free batch on the deterministic ranking', () => {
    const generation = firstBatch.index.generations[0]
    assert.deepEqual(generation.evaluation.finalRankedCandidateIds, generation.evaluation.ruleRankedCandidateIds)
    assert.equal(generation.evaluation.neuralPreferenceFeatures.length, 0)
    assert.equal(generation.evaluation.appliedSourceWeights.rule, 1)
    assert.equal(generation.evaluation.appliedSourceWeights.neural, 0)
    assert.equal(generation.candidates.some((candidate) => candidate.openClipEvaluation !== undefined), false)
    assert.equal(generation.candidates.some((candidate) => candidate.dinoV2Evaluation !== undefined), false)
  })

  it('runs one ordered composite pet analysis per sample and applies model geometry before generation', () => {
    assert.equal(petAnalyzerCalls, 1)
    assert.deepEqual(petAnalyzerRequests[0].providerIds, [
      'grounded-sam2-local',
      'mmpose-animal-local',
    ])
    assert.deepEqual(petAnalyzerRequests[0].capabilities, [
      'subject-segmentation',
      'edge-thin-structure',
      'keypoints',
    ])
    const generation = modelBatch.index.generations[0]
    assert.deepEqual(
      generation.diagnostics.analysis.providerContributions.map((entry) => [entry.providerId, entry.status]),
      [['grounded-sam2-local', 'used'], ['mmpose-animal-local', 'used']],
    )
    assert.deepEqual(
      generation.evaluation.providerContributions.map((entry) => [entry.providerId, entry.status]),
      [['grounded-sam2-local', 'used'], ['mmpose-animal-local', 'used']],
    )
    assert.deepEqual(
      generation.diagnostics.analysis.providerContributions.map((entry) => ({
        providerId: entry.providerId,
        sourceRevision: entry.manifest.sourceRevision,
        license: entry.manifest.license.spdx,
      })),
      [
        {
          providerId: 'grounded-sam2-local',
          sourceRevision: 'dd4c5141b75e4838dd486c64f773c43b4db3a07b',
          license: 'Apache-2.0',
        },
        {
          providerId: 'mmpose-animal-local',
          sourceRevision: '5408bc76f5b848cf925a0d1857899011d8c5b497',
          license: 'Apache-2.0',
        },
      ],
    )
    assert.deepEqual(generation.diagnostics.analysis.modelVersions, {
      keypoints: 'mmpose-test/1',
      petAnalysis: 'pattern-core/pet-analysis-v3-ap10k',
      petHeadPose: 'frontal',
      petInstances: '1',
      segmentation: 'sample-cat-mask/1',
      'subject-segmentation': 'grounded-sam2-test/1',
    })
    assert.ok(generation.diagnostics.analysis.landmarkIds.includes('pet-01:left-eye-center'))
    assert.ok(generation.diagnostics.analysis.semanticRegionIds.includes('pet-01:subject'))
    for (const candidate of generation.candidates) {
      assert.deepEqual(candidate.canvasPlan.crop, generation.diagnostics.analysis.suggestedCrop)
    }
    const baselineFeatures = new Map(firstBatch.index.generations[0].candidates
      .map((candidate) => [candidate.id, candidate.features]))
    assert.ok(generation.candidates.some((candidate) =>
      JSON.stringify(candidate.features) !== JSON.stringify(baselineFeatures.get(candidate.id))))
  })

  it('continues the BiRefNet baseline when composite pet analysis fails', async () => {
    const fixture = twoPetAnalysisFixture()
    const baselineAnalysis = mergeAnalysis(fixture.image, fixture.mask, fixture.metadata, 'pet')
    const resolved = await resolvePetSampleAnalysis({
      image: fixture.image,
      baselineAnalysis,
      sourceId: 'two-pet-fixture',
      analyzer: {
        async analyze() {
          throw new Error('pet model fixture unavailable')
        },
      },
    })

    assert.equal(resolved.analysis, baselineAnalysis)
    assert.deepEqual(
      resolved.diagnostics.providerContributions.map((entry) => [entry.providerId, entry.status]),
      [['grounded-sam2-local', 'failed'], ['mmpose-animal-local', 'failed']],
    )
    assert.match(resolved.diagnostics.providerContributions[0].message, /fixture unavailable/i)
  })
})
