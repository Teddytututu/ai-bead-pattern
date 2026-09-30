import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
const root = fileURLToPath(new URL('../../', import.meta.url))
const children = []
let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill()
  process.exitCode = code
}
const python = resolve(root, 'services/sdxl-region-sidecar/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
for (const [executable, args] of [[python, ['-m', 'sdxl_region_sidecar']], [process.execPath, ['apps/demo/server/serve.mjs']]]) {
  const child = spawn(executable, args, { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true })
  children.push(child)
  child.on('error', (error) => { console.error(error.message); stop(1) })
  child.on('exit', (code) => stop(code ?? 0))
}
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
