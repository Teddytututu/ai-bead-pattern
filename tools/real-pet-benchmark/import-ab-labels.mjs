#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const batchPath = resolve(process.argv[2] ?? 'work/real-pet-benchmark/results-600-20260905/ab-batch.labeled.json')
const exportPath = resolve(process.argv[3] ?? batchPath.replace(/ab-batch\.labeled\.json$/, 'preference-records.v2.jsonl'))
const featurePath = resolve(process.argv[4] ?? resolve(batchPath, '..', 'preference-export.jsonl'))
const batch = JSON.parse(await readFile(batchPath, 'utf8'))
const features = (await readFile(featurePath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
const byCandidate = new Map(features.map((entry) => [`${entry.source.id}:${entry.candidate.id}`, entry]))
const records = []
for (const pair of batch.pairs) {
  if (!['a', 'b', 'tie'].includes(pair.choice)) continue
  const a = byCandidate.get(`${pair.source.id}:${pair.candidateA.id}`)
  const b = byCandidate.get(`${pair.source.id}:${pair.candidateB.id}`)
  if (!a || !b) throw new Error(`Missing preference export for ${pair.pairId}`)
  const now = new Date().toISOString()
  records.push({
    schemaVersion: 2,
    id: `ab-${pair.pairId}`,
    generationId: `${pair.source.id}-${pair.context.size}-${pair.context.mode}`,
    source: { id: pair.source.id, groupId: pair.source.groupId, subjectKind: 'pet', digest: a.source.digest },
    candidates: [a.candidate, b.candidate],
    annotator: { anonymousId: batch.annotatorId ?? 'human-local', raterType: 'human', confidence: (pair.confidence ?? 3) / 5 },
    axisScores: {},
    issueAnnotations: pair.issue ? [{ id: `${pair.pairId}:issue`, candidateId: pair.choice === 'b' ? b.candidate.id : a.candidate.id, issue: pair.issue, severity: 3, confidence: (pair.confidence ?? 3) / 5 }] : [],
    comparisons: [{ candidateAId: a.candidate.id, candidateBId: b.candidate.id, choice: pair.choice }],
    eliminations: [], createdAt: now, updatedAt: now,
  })
}
await writeFile(exportPath, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''))
console.log(JSON.stringify({ output: exportPath, labeledRecords: records.length, pendingPairs: batch.pairs.filter((pair) => !pair.choice).length }, null, 2))
