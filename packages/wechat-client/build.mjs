import { mkdir, copyFile, writeFile } from 'node:fs/promises'
await writeFile(new URL('./dist-cjs/package.json', import.meta.url), '{"type":"commonjs"}\n')
const target = new URL('../../apps/wechat-miniapp/vendor/', import.meta.url)
await mkdir(target, { recursive: true })
await copyFile(new URL('./dist-cjs/index.js', import.meta.url), new URL('./sdk.js', target))
await writeFile(new URL('./sdk.d.ts', target), "export * from '../../../packages/wechat-client/dist/index.js'\n")
