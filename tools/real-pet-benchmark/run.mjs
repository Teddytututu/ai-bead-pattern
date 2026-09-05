#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import sharp from 'sharp'
import { createPatternAlgorithm } from '@ai-bead-pattern/pattern-core'
import { preferenceCandidateFromPattern } from '../auto-eval/src/candidate-features.mjs'
import { renderPattern } from '../auto-eval/src/render.mjs'

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
const modes = String(args.modes ?? 'baseline,ablation-no-shape,ablation-area-resize').split(',')
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
await mkdir(output, { recursive: true })
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
  for (const size of sizes) for (const mode of modes) {
    const resizeMethod = mode === 'ablation-area-resize' ? 'area' : 'cell-aware'
    const occupancyMode = mode === 'ablation-no-shape' ? 'full-frame' : 'subject-shape'
    const analysis = {
      imageType: 'pet', confidence: 1,
      subjectMask: { width: image.width, height: image.height, values: mask },
      subjectMaskEvidence: { mask: { width: image.width, height: image.height, values: mask }, confidence: 1, source: 'manual', revision: 'oxford-trimap-v1', userConfirmed: true },
    }
    const result = await algorithm.generate({ image, palette, analysis, options: {
      canvas: { mode: 'fixed', size: { width: size, height: size } }, maxColors: 12, maxCandidates: 1,
      imageType: 'pet', resizeMethod, baseline: 'mvp', styles: ['faithful'],
      structure: { occupancyMode, outlineMode: 'selective', shapeRefinementIterations: 2 },
    } })
    const candidate = result.recommended ?? result.bestEffort
    if (candidate === undefined) throw new Error(`Generation produced no candidate for ${sample.imageId}/${size}/${mode}`)
    const id = `${size}-${mode}`
    const imageOut = join(sampleOutput, `${id}.png`)
    await renderPattern(candidate, imageOut, { cellSize: Math.max(4, Math.floor(480 / size)) })
    const features = preferenceCandidateFromPattern(id, candidate)
    preferences.push({ source: { id: sample.imageId, groupId: sample.sourceGroup, split: sample.split, digest: sample.sha256 }, generationId: `${sample.imageId}-${id}`, candidate: features, humanPreference: null })
    rows.push({ datasetId: manifest.datasetId, sampleId: sample.sampleId, imageId: sample.imageId, sourceGroup: sample.sourceGroup, split: sample.split, breedGroup: sample.breedGroup, size, mode, status: result.status, outputPath: imageOut, score: candidate.score, metrics: candidate.metrics, timing: result.timing })
  }
}
const jsonl = rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
await writeFile(join(output, 'metrics.jsonl'), jsonl)
const csvFields = ['imageId','sourceGroup','split','breedGroup','size','mode','status','totalBeads','uniqueColors','meanColorDistance','silhouetteBoundaryIoU','shapeTopologyClDice','scoreCraftEase','scoreSilhouette','scoreColorFidelity','scoreCleanliness','outputPath']
const csv = [csvFields.join(','), ...rows.map((row) => csvFields.map((field) => {
  const value = field in row ? row[field] : field.startsWith('score') ? row.score?.[field.slice(5, 6).toLowerCase() + field.slice(6)] : row.metrics?.[field]
  return JSON.stringify(value ?? '')
}).join(','))].join('\n') + '\n'
await writeFile(join(output, 'metrics.csv'), csv)
await writeFile(join(output, 'preference-export.jsonl'), preferences.map((row) => JSON.stringify(row)).join('\n') + '\n')
await writeFile(join(output, 'run.json'), JSON.stringify({ schemaVersion: 'real-pet-benchmark-run-v1', datasetId: manifest.datasetId, manifestPath, selectedSamples: selected.length, sizes, modes, split: split ?? 'all', generatedAt: new Date().toISOString(), sourceGroups: [...new Set(selected.map((sample) => sample.sourceGroup))].sort(), outputs: rows.length }, null, 2) + '\n')
console.log(JSON.stringify({ output, samples: selected.length, rows: rows.length, sizes, modes }, null, 2))
