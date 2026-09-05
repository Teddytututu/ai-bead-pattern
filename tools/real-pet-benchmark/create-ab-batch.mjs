#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const args = {}
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index]
  if (!value.startsWith('--')) continue
  const next = process.argv[index + 1]
  args[value.slice(2)] = next === undefined || next.startsWith('--') ? true : next
  if (args[value.slice(2)] !== true) index += 1
}
const metricsPath = resolve(args.metrics ?? 'work/real-pet-benchmark/results/metrics.jsonl')
const outputPath = resolve(args.output ?? 'work/real-pet-benchmark/results/ab-batch.json')
const rows = (await readFile(metricsPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
const eligible = rows.filter((row) => row.status !== 'skipped' && row.outputPath)
const groups = new Map()
for (const row of eligible) {
  const key = [row.imageId, row.size, row.mode].join('\u0000')
  const entries = groups.get(key) ?? []
  entries.push(row)
  groups.set(key, entries)
}
const pairs = []
for (const entries of groups.values()) {
  const reference = entries.find((entry) => entry.baseline === 'mvp') ?? entries[0]
  for (const challenger of entries) {
    if (challenger === reference) continue
    const pairId = `${reference.imageId}:${reference.size}:${reference.mode}:${reference.baseline}-vs-${challenger.baseline}`
    pairs.push({
      pairId,
      source: { id: reference.imageId, groupId: reference.sourceGroup, split: reference.split },
      context: { size: reference.size, mode: reference.mode },
      candidateA: { id: `${reference.baseline}-${reference.size}-${reference.mode}`, baseline: reference.baseline, imagePath: reference.outputPath },
      candidateB: { id: `${challenger.baseline}-${challenger.size}-${challenger.mode}`, baseline: challenger.baseline, imagePath: challenger.outputPath },
      choice: null,
      confidence: null,
      issue: null,
      note: '',
    })
  }
}
const batch = {
  schemaVersion: 'bead-ab-batch-v1',
  generatedAt: new Date().toISOString(),
  metricsPath,
  instructions: '选择更像原图且更易制作的一侧；相近时选择 tie。记录由人工填写。',
  pairs,
}
await writeFile(outputPath, JSON.stringify(batch, null, 2) + '\n')
console.log(JSON.stringify({ output: outputPath, pairs: pairs.length, sources: new Set(pairs.map((pair) => pair.source.id)).size }, null, 2))
