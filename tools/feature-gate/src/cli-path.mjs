import { isAbsolute, resolve } from 'node:path'

export function resolveCliPath(path) {
  return isAbsolute(path) ? path : resolve(process.env.INIT_CWD ?? process.cwd(), path)
}
