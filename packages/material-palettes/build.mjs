import { mkdir, readFile, writeFile } from 'node:fs/promises'
const palettes = await Promise.all(['mard-291', 'generic-24'].map(async id =>
  JSON.parse(await readFile(new URL(`../../assets/palettes/${id}.json`, import.meta.url), 'utf8'))))
await mkdir(new URL('./dist/', import.meta.url), { recursive: true })
await writeFile(new URL('./dist/data.js', import.meta.url), `// Generated from assets/palettes; do not edit.\nexport const palettes = ${JSON.stringify(palettes)}\n`)
