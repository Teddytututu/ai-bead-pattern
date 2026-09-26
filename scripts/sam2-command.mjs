import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const project = 'services/sam2-sidecar'
const python = resolve(project, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python')
const bundledUv = resolve('.tools/bootstrap/bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
const uv = existsSync(bundledUv) ? bundledUv : 'uv'
process.env.HF_HOME ??= resolve('.tools/huggingface')

export function spawnSam2(moduleArgs) {
  const direct = existsSync(python)
  return spawn(direct ? python : uv, direct ? moduleArgs : ['run', '--project', project, '--python', '3.11', 'python', ...moduleArgs], {
    cwd: process.cwd(), env: process.env, stdio: 'inherit', windowsHide: true,
  })
}

function completion(child) {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolveExit() : reject(new Error(`SAM2 command exited: ${code ?? signal}`)))
    const stop = () => child.kill()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    child.once('exit', () => {
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    })
  })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const command = process.argv[2]
  try {
    if (command === 'setup') {
      await completion(spawn(uv, ['sync', '--project', project, '--python', '3.11'], { stdio: 'inherit', windowsHide: true }))
    }
    const args = {
      setup: ['-m', 'sam2_sidecar.prefetch'], prefetch: ['-m', 'sam2_sidecar.prefetch'],
      start: ['-m', 'sam2_sidecar'], test: ['-m', 'unittest', 'discover', '-s', `${project}/tests`, '-v'],
      smoke: ['-m', 'sam2_sidecar.smoke'], 'grounded-smoke': ['-m', 'sam2_sidecar.grounded_smoke'],
    }[command]
    if (!args) throw new Error('Expected setup, prefetch, start, test, smoke or grounded-smoke')
    await completion(spawnSam2(args))
  } catch (error) {
    console.error(`SAM2: ${error.message}. 首次使用请安装 uv 并运行 pnpm sam2:setup。`)
    process.exitCode = 1
  }
}
