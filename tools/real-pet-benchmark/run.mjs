#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import sharp from 'sharp'
import { createPatternAlgorithm } from '@ai-bead-pattern/pattern-core'
import { preferenceCandidateFromPattern } from '../auto-eval/src/candidate-features.mjs'
import { renderPattern } from '../auto-eval/src/render.mjs'
import { BASELINE_SCHEMA_VERSION, baselineStatus, optionsForBaseline, resolveBaselineIds } from './src/baselines.mjs'

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const value = process.argv[i]; if (!value.startsWith('--')) continue
  const key = value.slice(2); const next = process.argv[i + 1]
  if (next === undefined || next.startsWith('--')) args[key] = true
  else { args[key] = next; i += 1 }
}
const root = resolve(new URL('../..', import.meta.url).pathname)
const manifestPath = resolve(args.manifest ?? join(root, 'work/real-pet-benchmark/manifest.json'))
const output = resolve(args.output ?? join(root, 'work/real-pet-benchmark/results'))
const sizes = String(args.sizes ?? '24,32,48,64,80').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0)
const modes = String(args.modes ?? 'baseline').split(',').map((value) => value.trim()).filter(Boolean)
const baselineIds = resolveBaselineIds(args.baselines ?? 'mvp,area,nearest,pixeloe,myos')
const split = args.split === undefined ? undefined : String(args.split)
const limit = Number(args.limit ?? Infinity)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const palette = JSON.parse(await readFile(join(root, 'assets/palettes/generic-24.json'), 'utf8'))
const filtered = manifest.samples.filter((sample) => split === undefined || sample.split === split)
const selected = Number.isFinite(limit) ? filtered.slice(0, limit) : filtered
const pathFromManifest = (value) => isAbsolute(value) ? value : resolve(dirname(manifestPath), value)
if (selected.length === 0) throw new Error('No samples selected; run fetch-oxford-pet.mjs first')
const algorithm = createPatternAlgorithm()
const rows = []; const preferences = []
const statuses = Object.fromEntries(baselineIds.map((id) => [id, baselineStatus(id)]))
await mkdir(output, { recursive: true })
await writeFile(join(output, 'baseline-registry.json'), JSON.stringify({ schemaVersion: BASELINE_SCHEMA_VERSION, baselines: statuses }, null, 2) + '\n')
async function imageWithMask(sample) {
  const imagePath = pathFromManifest(sample.localPath)
  const { data, info } = await sharp(imagePath).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let mask = new Float32Array(info.width * info.height).fill(1)
  if (sample.trimapPath) {
    const trimap = await sharp(pathFromManifest(sample.trimapPath)).resize(info.width, info.height, { fit: 'fill', kernel: 'nearest' }).greyscale().raw().toBuffer()
    mask = Float32Array.from(trimap, (value) => value >= 128 || value === 1 ? 1 : value === 3 ? 0.5 : 0)
  }
  return { image: { width: info.width, height: info.height, data: new Uint8ClampedArray(data) }, mask }
}
for (const sample of selected) {
  const { image, mask } = await imageWithMask(sample)
  const sampleOutput = join(output, sample.imageId)
  await mkdir(sampleOutput, { recursive: true })
  for (const size of sizes) for (const baselineId of baselineIds) for (const mode of modes) {
    const baseline = statuses[baselineId]
    const occupancyMode = mode === 'ablation-no-shape' ? 'full-frame' : 'subject-shape'
    const id = `${size}-${baselineId}-${mode}`
    if (baseline.runStatus === 'skipped') {
      rows.push({ datasetId: manifest.datasetId, sampleId: sample.sampleId, imageId: sample.imageId, sourceGroup: sample.sourceGroup, split: sample.split, breedGroup: sample.breedGroup, size, baseline: baselineId, baselineLabel: baseline.label, implementationStatus: baseline.implementationStatus, paperReproduction: baseline.paperReproduction, mode, status: 'skipped', skipReason: baseline.skipReason, outputPath: null, score: null, metrics: null, timing: null })
      continue
    }
    const analysis = {
      imageType: 'pet', confidence: 1,
      subjectMask: { width: image.width, height: image.height, values: mask },
      subjectMaskEvidence: { mask: { width: image.width, height: image.height, values: mask }, confidence: 1, source: 'manual', revision: 'oxford-trimap-v1', userConfirmed: true },
    }
    const baseOptions = optionsForBaseline(baselineId, { size: { width: size, height: size }, maxColors: 12, occupancyMode })
    if (baseOptions === undefined) throw new Error(`Baseline ${baselineId} has no local core adapter`)
    if (mode === 'ablation-no-shape' && baseOptions.structure) baseOptions.structure = { ...baseOptions.structure, occupancyMode: 'full-frame' }
    if (mode === 'ablation-area-resize' && baseOptions.baseline === 'mvp') baseOptions.resizeMethod = 'area'
    const result = await algorithm.generate({ image, palette, analysis, options: baseOptions })
    const candidate = result.recommended ?? result.bestEffort
    if (candidate === undefined) throw new Error(`Generation produced no candidate for ${sample.imageId}/${size}/${baselineId}/${mode}`)
    const imageOut = join(sampleOutput, `${id}.png`)
    await renderPattern(candidate, imageOut, { cellSize: Math.max(4, Math.floor(480 / size)) })
    const features = preferenceCandidateFromPattern(id, candidate)
    preferences.push({ source: { id: sample.imageId, groupId: sample.sourceGroup, split: sample.split, digest: sample.sha256 }, generationId: `${sample.imageId}-${id}`, candidate: features, humanPreference: null, baseline: baselineId, implementationStatus: baseline.implementationStatus, paperReproduction: baseline.paperReproduction })
    rows.push({ datasetId: manifest.datasetId, sampleId: sample.sampleId, imageId: sample.imageId, sourceGroup: sample.sourceGroup, split: sample.split, breedGroup: sample.breedGroup, size, baseline: baselineId, baselineLabel: baseline.label, implementationStatus: baseline.implementationStatus, paperReproduction: baseline.paperReproduction, mode, status: result.status, outputPath: imageOut, score: candidate.score, metrics: candidate.metrics, timing: result.timing })
  }
}
const jsonl = rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
await writeFile(join(output, 'metrics.jsonl'), jsonl)
const csvFields = ['imageId','sourceGroup','split','breedGroup','size','baseline','baselineLabel','implementationStatus','paperReproduction','mode','status','skipReason','totalBeads','uniqueColors','meanColorDistance','silhouetteBoundaryIoU','shapeTopologyClDice','scoreCraftEase','scoreSilhouette','scoreColorFidelity','scoreCleanliness','outputPath']
const csv = [csvFields.join(','), ...rows.map((row) => csvFields.map((field) => {
  const value = field in row ? row[field] : field.startsWith('score') ? row.score?.[field.slice(5, 6).toLowerCase() + field.slice(6)] : row.metrics?.[field]
  return JSON.stringify(value ?? '')
}).join(','))].join('\n') + '\n'
await writeFile(join(output, 'metrics.csv'), csv)
await writeFile(join(output, 'preference-export.jsonl'), preferences.map((row) => JSON.stringify(row)).join('\n') + '\n')
await writeFile(join(output, 'run.json'), JSON.stringify({ schemaVersion: 'real-pet-benchmark-run-v1', datasetId: manifest.datasetId, manifestPath, selectedSamples: selected.length, sizes, baselines: baselineIds, modes, split: split ?? 'all', generatedAt: new Date().toISOString(), sourceGroups: [...new Set(selected.map((sample) => sample.sourceGroup))].sort(), outputs: rows.length }, null, 2) + '\n')
console.log(JSON.stringify({ output, samples: selected.length, rows: rows.length, runnableRows: rows.filter((row) => row.status !== 'skipped').length, skippedRows: rows.filter((row) => row.status === 'skipped').length, sizes, baselines: baselineIds, modes }, null, 2))
