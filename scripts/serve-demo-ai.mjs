import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const endpoint = process.env.PIXEL_PROPOSAL_ENDPOINT ?? 'http://127.0.0.1:7101'
const project = resolve(process.cwd(), 'services/pixel-proposal-sidecar')
const sidecar = spawn('uv', [
  'run',
  '--project', project,
  '--python', '3.11',
  'python', '-m', 'pixel_proposal_sidecar',
], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
})

function stopSidecar() {
  if (sidecar.exitCode === null) sidecar.kill()
}

process.once('SIGINT', () => {
  stopSidecar()
  process.exit(130)
})
process.once('SIGTERM', () => {
  stopSidecar()
  process.exit(143)
})
process.once('exit', stopSidecar)

async function waitForSidecar() {
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    if (sidecar.exitCode !== null) throw new Error(`Pixel proposal sidecar exited with ${sidecar.exitCode}`)
    try {
      const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch {
      // The uv environment may still be installing on the first launch.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
  }
  throw new Error('Pixel proposal sidecar did not become healthy within 10 minutes')
}

await waitForSidecar()
process.env.PIXEL_PROPOSAL_ENDPOINT = endpoint
await import('./serve-demo.mjs')
