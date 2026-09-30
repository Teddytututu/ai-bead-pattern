import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const project = resolve(root, 'services/sdxl-region-sidecar')
const python = resolve(project, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python')
const bundledUv = resolve(root, '.tools/bootstrap/bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
const uv = existsSync(bundledUv) ? bundledUv : 'uv'
process.env.HF_HOME ??= resolve(root, '.tools/huggingface')
const command = process.argv[2]
const extra = process.argv.slice(3)
function run(executable, args) {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true })
    const stop = () => child.kill()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    child.once('error', reject)
    child.once('exit', (code) => {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
      code === 0 ? done() : reject(new Error(`SDXL command exited ${code}`))
    })
  })
}
try {
  if (command === 'setup') await run(uv, ['sync', '--project', project, '--python', '3.11'])
  const args = {
    setup: ['-m', 'sdxl_region_sidecar.prefetch'],
    prefetch: ['-m', 'sdxl_region_sidecar.prefetch'],
    start: ['-m', 'sdxl_region_sidecar'],
    test: ['-m', 'unittest', 'discover', '-s', `${project}/tests`, '-v'],
    smoke: ['-m', 'sdxl_region_sidecar.smoke'],
    'lora-smoke': ['-m', 'sdxl_region_sidecar.lora_smoke'],
    'vae-smoke': ['-m', 'sdxl_region_sidecar.vae_smoke'],
  }[command]
  if (!args) throw new Error('Expected setup, prefetch, start, test, smoke, lora-smoke, or vae-smoke')
  await run(python, [...args, ...extra])
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
