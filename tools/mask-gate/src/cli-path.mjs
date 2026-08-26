import { isAbsolute, resolve } from 'node:path'

export function resolveCliPath(value) {
  if (value === undefined || isAbsolute(value)) return value
  return resolve(process.env.INIT_CWD ?? process.cwd(), value)
}
