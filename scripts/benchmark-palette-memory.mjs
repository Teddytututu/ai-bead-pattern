import { spawn } from 'node:child_process'
import { cpus, platform } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const rows = []
for (const paletteId of ['generic-24', 'mard-291']) for (const input of ['gradient', 'cat-photo', 'transparent-edges']) {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./benchmark-palette.mjs', import.meta.url)), '--full', '--case', paletteId, input, '96', 'quality', '3'], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
    let text = ''
    child.stdout.on('data', chunk => { text += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve(text) : reject(new Error(`Benchmark exited ${code}`)))
  })
  const row = JSON.parse(output.trim()); rows.push(row); console.log(JSON.stringify(row))
}
await mkdir(new URL('../output/', import.meta.url), { recursive: true })
await writeFile(new URL('../output/palette-memory-benchmark.json', import.meta.url), JSON.stringify({ date: new Date().toISOString(), node: process.version, cpu: cpus()[0].model, platform: platform(), memoryMetric: 'Fresh process for each case; process.resourceUsage().maxRSS in KiB / 1024. Includes imports, image preparation, one warmup and three measured runs.', rows }, null, 2) + '\n')
