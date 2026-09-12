#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const input = resolve(process.argv[2] ?? 'work/real-pet-benchmark/results-600-20260905/metrics.jsonl')
const output = resolve(process.argv[3] ?? input.replace(/metrics\.jsonl$/, 'aggregate.json'))
const rows = (await readFile(input, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
const runnable = rows.filter((row) => row.status !== 'skipped')
const by = (key) => {
  const groups = new Map()
  for (const row of runnable) {
    const value = row[key] ?? 'unknown'; const entries = groups.get(value) ?? []; entries.push(row); groups.set(value, entries)
  }
  return Object.fromEntries([...groups].map(([value, entries]) => [value, {
    count: entries.length,
    validRate: entries.filter((row) => row.status === 'success').length / entries.length,
    meanScore: entries.reduce((sum, row) => sum + (row.score?.total ?? 0), 0) / entries.length,
    meanBeads: entries.reduce((sum, row) => sum + (row.metrics?.totalBeads ?? 0), 0) / entries.length,
    meanColorDistance: entries.reduce((sum, row) => sum + (row.metrics?.meanColorDistance ?? 0), 0) / entries.length,
  }]))
}
const aggregate = {
  schemaVersion: 'real-pet-benchmark-aggregate-v1', input, generatedAt: new Date().toISOString(),
  rows: rows.length, runnableRows: runnable.length, skippedRows: rows.length - runnable.length,
  byBaseline: by('baseline'), bySize: by('size'), byMode: by('mode'),
}
await writeFile(output, JSON.stringify(aggregate, null, 2) + '\n')
console.log(JSON.stringify({ output, rows: rows.length, runnableRows: runnable.length, skippedRows: rows.length - runnable.length }, null, 2))
