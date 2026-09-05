#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { resolve } from 'node:path'

const batchPath = resolve(process.argv[2] ?? 'work/real-pet-benchmark/results/ab-batch.json')
const outPath = resolve(process.argv[3] ?? batchPath.replace(/\.json$/, '.labeled.json'))
const batch = JSON.parse(await readFile(batchPath, 'utf8'))
const rl = createInterface({ input, output })
console.log(`A/B 标注 ${batch.pairs.length} 对。图像路径写入批次文件，可在图片查看器中打开。`)
for (let index = 0; index < batch.pairs.length; index += 1) {
  const pair = batch.pairs[index]
  if (pair.choice) continue
  console.log(`\n[${index + 1}/${batch.pairs.length}] ${pair.source.id} size=${pair.context.size} mode=${pair.context.mode}`)
  console.log(`A (${pair.candidateA.baseline}): ${pair.candidateA.imagePath}`)
  console.log(`B (${pair.candidateB.baseline}): ${pair.candidateB.imagePath}`)
  const choice = (await rl.question('选择 [a/b/t=平局/s=跳过]：')).trim().toLowerCase()
  if (choice === 's' || choice === '') continue
  if (!['a', 'b', 't'].includes(choice)) { index -= 1; continue }
  const confidence = Number(await rl.question('信心 1-5（默认 3）：') || 3)
  const issue = (await rl.question('主要问题标签（可空）：')).trim() || null
  const note = (await rl.question('备注（可空）：')).trim()
  pair.choice = choice === 't' ? 'tie' : choice
  pair.confidence = Math.min(5, Math.max(1, Number.isFinite(confidence) ? confidence : 3))
  pair.issue = issue
  pair.note = note
  await writeFile(outPath, JSON.stringify({ ...batch, updatedAt: new Date().toISOString() }, null, 2) + '\n')
}
rl.close()
await writeFile(outPath, JSON.stringify({ ...batch, updatedAt: new Date().toISOString() }, null, 2) + '\n')
const labeled = batch.pairs.filter((pair) => pair.choice).length
console.log(JSON.stringify({ output: outPath, labeled, total: batch.pairs.length }, null, 2))
