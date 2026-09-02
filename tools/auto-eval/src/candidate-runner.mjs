import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import {
  createPatternAlgorithm,
  inferPetAnalysis,
} from '@ai-bead-pattern/pattern-core'
import sharp from 'sharp'

import { preferenceCandidateFromPattern } from './candidate-features.mjs'
import { toGenerationOptions } from './iteration.mjs'
import { renderBatchSheet, renderPattern, renderSampleSheet } from './render.mjs'

function subjectKind(category) {
  if (category === 'portrait') return 'person'
  if (category === 'pet') return 'pet'
  if (category === 'landscape' || category === 'scene') return 'scene'
  return 'object'
}

function imageType(category) {
  if (category === 'portrait') return 'portrait'
  if (category === 'pet') return 'pet'
  if (category === 'illustration') return 'illustration'
  if (category === 'landscape' || category === 'scene') return 'landscape'
  return 'general'
}

async function rgbaImage(path) {
  const { data, info } = await sharp(path).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) }
}

async function maskImage(path, width, height) {
  const { data, info } = await sharp(path).resize(width, height, { fit: 'fill' }).greyscale().raw()
    .toBuffer({ resolveWithObject: true })
  if (info.width !== width || info.height !== height) throw new RangeError('Mask dimensions must match the source image')
  return { width, height, values: Float32Array.from(data, (value) => value / 255) }
}

function baseOptions(category) {
  return {
    canvas: { mode: 'fixed', size: { width: 48, height: 48 } },
    maxColors: 12,
    maxCandidates: 1,
    imageType: imageType(category),
    resizeMethod: 'cell-aware',
    colorDistanceMethod: 'delta-e-2000',
    baseline: 'mvp',
    structure: {
      importanceStrength: 1,
      edgeStrength: 1,
      valueOrderStrength: 1,
      valueLevels: 3,
      occupancyMode: 'subject-shape',
      shapeRefinementIterations: 2,
    },
    optimization: {
      minRegionSize: 2,
      isolatedPixelPenalty: 1,
      edgeProtection: 0.72,
      stripePenalty: 1,
      paletteCoherence: 1.1,
      localSearchIterations: 3,
      aliasPenalty: 1,
      refinementMode: 'quality',
    },
  }
}

function recipes(category, learnedModel) {
  const baseline = baseOptions(category)
  const adaptive = learnedModel === undefined ? {
    ...structuredClone(baseline),
    structure: { ...baseline.structure, importanceStrength: 1.55, edgeStrength: 1.5 },
    optimization: { ...baseline.optimization, edgeProtection: 0.9 },
  } : toGenerationOptions(learnedModel, baseline)
  return [
    { id: 'A-baseline', options: { ...structuredClone(baseline), styles: ['faithful'] } },
    { id: learnedModel === undefined ? 'B-identity' : 'B-learned', options: { ...adaptive, styles: ['faithful'] } },
    { id: 'C-clean', options: {
      ...structuredClone(baseline), styles: ['simple'], maxColors: 9,
      optimization: {
        ...baseline.optimization, isolatedPixelPenalty: 1.65, stripePenalty: 1.55,
        paletteCoherence: 1.35, localSearchIterations: 6,
      },
    } },
    { id: 'D-contrast', options: {
      ...structuredClone(baseline), styles: ['high-contrast'], maxColors: 10,
      structure: { ...baseline.structure, importanceStrength: 1.3, edgeStrength: 1.4 },
    } },
  ]
}

function mergeAnalysis(image, mask, metadata, category) {
  const evidence = {
    mask,
    confidence: metadata.evidence.confidence,
    source: metadata.evidence.source,
    revision: metadata.evidence.revision,
    provenance: metadata.evidence.provenance,
  }
  const pet = category === 'pet' ? inferPetAnalysis(image, mask) : undefined
  const semanticRegions = [{
    id: 'subject',
    label: 'subject',
    mask,
    confidence: metadata.evidence.confidence,
    importance: 0.9,
    provenance: metadata.evidence.provenance,
  }, ...(pet === undefined ? [] : [{
    id: 'pet-face',
    label: 'pet face',
    mask: pet.faceMask,
    confidence: pet.confidence,
    importance: 1,
    provenance: [{ origin: 'heuristic', provider: 'pet-geometry', version: 'pet-face-v1' }],
  }])]
  return {
    subjectMask: mask,
    subjectMaskEvidence: evidence,
    ...(pet === undefined ? {} : {
      landmarks: pet.landmarks,
      suggestedCrop: pet.suggestedCrop,
      suggestedCropConfidence: pet.suggestedCropConfidence,
      suggestedCropSource: 'automatic',
    }),
    semanticRegions,
    imageType: imageType(category),
    confidence: pet?.confidence ?? metadata.evidence.confidence,
    modelVersions: {
      ...(metadata.modelVersions ?? {}),
      ...(pet === undefined ? {} : { petAnalysis: 'pattern-core/pet-analysis-v1' }),
    },
    provenance: metadata.evidence.provenance,
  }
}

export async function generateCandidateBatch(options) {
  const manifestPath = resolve(options.manifestPath)
  const sidecarDirectory = resolve(options.sidecarDirectory)
  const outputDirectory = resolve(options.outputDirectory)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const palette = JSON.parse(await readFile(resolve(options.palettePath), 'utf8'))
  const learnedModel = options.modelPath === undefined
    ? undefined
    : JSON.parse(await readFile(resolve(options.modelPath), 'utf8'))
  const selected = manifest.samples
    .filter((sample) => options.category === undefined || sample.category === options.category)
    .slice(0, options.limit ?? manifest.samples.length)
  const algorithm = createPatternAlgorithm()
  const generations = []
  const sheetsByCategory = new Map()
  await mkdir(outputDirectory, { recursive: true })
  for (const sample of selected) {
    const metadataPath = join(sidecarDirectory, `${sample.imageId}.analysis.json`)
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    const sourcePath = join(sidecarDirectory, metadata.source.path)
    const maskPath = join(sidecarDirectory, metadata.mask.path)
    const image = await rgbaImage(sourcePath)
    const mask = await maskImage(maskPath, image.width, image.height)
    const analysis = mergeAnalysis(image, mask, metadata, sample.category)
    const sampleDirectory = join(outputDirectory, sample.imageId)
    await mkdir(sampleDirectory, { recursive: true })
    const candidateEntries = []
    for (const recipe of recipes(sample.category, learnedModel)) {
      const result = await algorithm.generate({ image, palette, analysis, options: recipe.options })
      const candidate = result.recommended ?? result.bestEffort
      if (candidate === undefined) throw new Error(`Generation produced no candidate for ${sample.imageId}/${recipe.id}`)
      const imagePath = join(sampleDirectory, `${recipe.id}.png`)
      const outlinePath = join(sampleDirectory, `${recipe.id}.outline.png`)
      await renderPattern(candidate, imagePath)
      await renderPattern(candidate, outlinePath, { outline: true })
      candidateEntries.push({
        ...preferenceCandidateFromPattern(recipe.id, candidate),
        algorithmCandidateId: candidate.id,
        imagePath,
        outlinePath,
        score: candidate.score,
        metrics: candidate.metrics,
        options: recipe.options,
      })
    }
    const sheetPath = join(sampleDirectory, 'comparison.png')
    await renderSampleSheet({ sourcePath, imageId: sample.imageId, candidates: candidateEntries, outputPath: sheetPath })
    const categorySheets = sheetsByCategory.get(sample.category) ?? []
    categorySheets.push(sheetPath)
    sheetsByCategory.set(sample.category, categorySheets)
    generations.push({
      generationId: `auto-eval:${manifest.datasetId}:${sample.imageId}`,
      datasetId: manifest.datasetId,
      source: {
        id: sample.imageId,
        groupId: sample.imageId,
        subjectKind: subjectKind(sample.category),
        category: sample.category,
        cohort: sample.cohort,
        failureTags: sample.failureTags,
        imagePath: sourcePath,
      },
      candidates: candidateEntries,
      comparisonSheetPath: sheetPath,
    })
  }
  const batchSheets = {}
  for (const [category, paths] of sheetsByCategory) {
    const outputPath = join(outputDirectory, `${category}-comparisons.png`)
    await renderBatchSheet(paths, outputPath)
    batchSheets[category] = outputPath
  }
  const index = {
    schemaVersion: 'auto-eval-candidates-v1',
    datasetId: manifest.datasetId,
    generatedAt: new Date().toISOString(),
    sourceManifest: manifestPath,
    sourceSidecars: sidecarDirectory,
    learnedModelVersion: learnedModel?.version,
    generations,
    batchSheets,
  }
  const indexPath = join(outputDirectory, 'candidate-index.json')
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`)
  return { indexPath, index }
}
