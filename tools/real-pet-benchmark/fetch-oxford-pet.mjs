#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'

const execFileAsync = promisify(execFile)
const root = resolve(new URL('../..', import.meta.url).pathname)
const templatePath = join(root, 'tests/fixtures/real-pet-benchmark/manifest.template.json')
const args = {}
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index]
  if (!value.startsWith('--')) continue
  const key = value.slice(2)
  const next = process.argv[index + 1]
  if (next === undefined || next.startsWith('--')) args[key] = true
  else { args[key] = next; index += 1 }
}
const output = resolve(args.output ?? 'work/real-pet-benchmark')
const archives = args.archives === undefined ? output : resolve(args.archives)
const limit = Number(args.limit ?? 40)
const dryRun = args['dry-run'] === true
const urls = {
  images: 'https://www.robots.ox.ac.uk/~vgg/data/pets/data/images.tar.gz',
  annotations: 'https://www.robots.ox.ac.uk/~vgg/data/pets/data/annotations.tar.gz',
}
const manifest = JSON.parse(await readFile(templatePath, 'utf8'))
const selected = manifest.samples.slice(0, Number.isFinite(limit) ? limit : 40)

async function sha256(path) {
  const data = await readFile(path)
  return createHash('sha256').update(data).digest('hex')
}
async function exists(path) { try { await stat(path); return true } catch { return false } }
async function download(url, path) {
  if (await exists(path)) return 'cached'
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Download ${url} returned HTTP ${response.status}`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.from(await response.arrayBuffer()))
  return 'downloaded'
}
async function extract(archivePath, members, destination, stripComponents = 0) {
  await mkdir(destination, { recursive: true })
  const strip = stripComponents === 0 ? [] : [`--strip-components=${stripComponents}`]
  await execFileAsync('tar', ['-xzf', archivePath, '-C', destination, ...strip, ...members])
}

console.log(JSON.stringify({ datasetId: manifest.datasetId, samples: selected.length, output, urls, dryRun }, null, 2))
if (dryRun) process.exit(0)
await mkdir(output, { recursive: true })
const imageArchive = join(archives, 'images.tar.gz')
const annotationArchive = join(archives, 'annotations.tar.gz')
await download(urls.images, imageArchive)
await download(urls.annotations, annotationArchive)
const imageMembers = selected.map((sample) => `images/${sample.imageId}.jpg`)
const trimapMembers = selected.map((sample) => `annotations/trimaps/${sample.imageId}.png`)
await extract(imageArchive, imageMembers, output)
await extract(annotationArchive, trimapMembers, output, 1)
const result = structuredClone(manifest)
result.samples = selected.map((sample) => {
  const imagePath = join(output, sample.localPath)
  const trimapPath = join(output, sample.trimapPath)
  return {
    ...sample,
    localPath: imagePath,
    trimapPath,
    sha256: null,
    trimapSha256: null,
  }
})
for (const sample of result.samples) {
  sample.sha256 = await sha256(sample.localPath)
  sample.trimapSha256 = await sha256(sample.trimapPath)
}
result.splits = Object.fromEntries(Object.entries(result.splits).map(([key]) => [key, result.samples.filter((sample) => sample.split === key).length]))
result.fetchedAt = new Date().toISOString()
result.archiveSha256 = { images: await sha256(imageArchive), annotations: await sha256(annotationArchive) }
await writeFile(join(output, 'manifest.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({ manifest: join(output, 'manifest.json'), fetched: result.samples.length, splits: result.splits }, null, 2))
