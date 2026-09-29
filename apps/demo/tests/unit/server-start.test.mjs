import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('workspace start serves browser modules and AI routes from the repository root', { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../server/serve.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, PORT: '0', AI_BEAD_E2E_FIXTURE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const exited = once(child, 'exit')
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  try {
    const base = await new Promise((resolve, reject) => {
      let stdout = ''
      child.stdout.on('data', chunk => {
        stdout += chunk
        const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)
        if (match) resolve(match[0])
      })
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`Demo exited ${code}: ${stderr}`)))
    })
    for (const path of ['/apps/demo/', '/apps/demo/src/ai-runtime.mjs', '/packages/pattern-core/dist/index.js', '/api/ai/health']) {
      const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) })
      assert.equal(response.status, 200, path)
      assert.ok((await response.text()).length > 0, path)
    }
  } finally {
    child.kill()
    await exited
  }
})
