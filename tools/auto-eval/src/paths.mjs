import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url))

export function workspacePath(value) {
  return isAbsolute(value) ? resolve(value) : resolve(workspaceRoot, value)
}

export function commandArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--') continue
    if (key.startsWith('--')) {
      values[key.slice(2)] = argv[index + 1]
      index += 1
    }
  }
  return values
}
