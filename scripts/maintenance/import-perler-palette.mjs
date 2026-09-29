// Rebuild from the frozen downloads described in docs/perler-123.md. No network access.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import sharp from 'sharp'
const input = resolve(process.argv[2] ?? 'output/perler-sources')
const destination = new URL('../../assets/palettes/', import.meta.url)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const productsBytes = await readFile(join(input, 'perler-products.json'))
const csvBytes = await readFile(join(input, 'beadcolors-perler.csv'))
if (sha256(productsBytes) !== '732eb19667810ed089bfefee7c3afcf97c69fed3a2272c11ebc081047e406642'
  || sha256(csvBytes) !== '757aae3e0553ed3a74db691cf930ea3e27eed47d038c5cc74bcef71acf3d24d0') throw new Error('Expected the frozen source snapshot; review new sources before updating')
const upstream = new Map(csvBytes.toString('utf8').trim().split(/\r?\n/).map(line => {
  const [sku, name, r, g, b, contributor] = line.split(',')
  return [sku, { name, rgb: [r, g, b].map(Number), contributor }]
}))
const products = JSON.parse(productsBytes).products
const bags = products.filter(p => p.title.startsWith('1,000 Perler Beads - '))
const selected = bags.filter(p => !p.tags.includes('Multi-Color'))
const finishes = { '80-19019': 'transparent', '80-15184': 'transparent', '80-19075': 'glow', '80-19085': 'metallic', '80-15105': 'pearl' }
if (selected.length !== 123 || upstream.size !== 103) throw new Error('Source snapshot count changed; review before importing')
const colors = [], records = []
let upstreamCount = 0
for (const product of selected.sort((a, b) => a.variants[0].sku.localeCompare(b.variants[0].sku, 'en'))) {
  if (product.variants.length !== 1) throw new Error('Review multi-variant product')
  const id = product.variants[0].sku, name = product.title.slice('1,000 Perler Beads - '.length)
  const record = { id, name, productId: product.id, productUrl: `https://perler.com/products/${product.handle}` }
  let rgb
  if (upstream.has(id)) {
    const entry = upstream.get(id)
    rgb = entry.rgb
    record.rgbSource = 'beadcolors'
    record.upstreamName = entry.name
    record.contributor = entry.contributor
    upstreamCount++
  } else {
    const swatch = product.images.find(image => /swatch/i.test(image.src))
    if (!swatch) throw new Error(`Missing swatch: ${id}`)
    const bytes = await readFile(join(input, 'swatches', `${id}.jpg`))
    const { width, height } = await sharp(bytes).metadata()
    const data = await sharp(bytes).extract({ left: Math.floor(width * .1), top: Math.floor(height * .1), width: Math.floor(width * .8), height: Math.floor(height * .8) })
      .resize(256, 256).toColourspace('srgb').removeAlpha().raw().toBuffer()
    const pixels = Array.from({ length: data.length / 3 }, (_, i) => [...data.subarray(i * 3, i * 3 + 3)])
      .sort((a, b) => (a[0] - b[0]) * .2126 + (a[1] - b[1]) * .7152 + (a[2] - b[2]) * .0722)
    const middle = pixels.slice(Math.floor(pixels.length * .35), Math.floor(pixels.length * .75))
    rgb = [0, 1, 2].map(channel => middle.map(pixel => pixel[channel]).sort((a, b) => a - b)[Math.floor(middle.length / 2)])
    Object.assign(record, { rgbSource: 'official-photo-estimate', swatchUrl: swatch.src, swatchSha256: sha256(bytes) })
  }
  const finish = finishes[id] ?? 'solid'
  colors.push({ id, code: id, name, hex: `#${rgb.map(v => v.toString(16).padStart(2, '0')).join('')}`, rgb, finish, automaticMatch: finish === 'solid' })
  records.push({ ...record, rgb })
}
if (upstreamCount !== 95 || new Set(colors.map(c => c.id)).size !== 123) throw new Error('Source coverage changed')
const source = {
  catalog: 'https://perler.com/collections/shop-by-color/products.json?limit=250',
  collection: 'https://perler.com/collections/1-000ct-bead-bags',
  repository: 'https://github.com/maxcleme/beadcolors',
  revision: 'c8e4892ac8bdd352465e9db6cdbd1e7b4cdcbd27',
  path: 'raw/perler.csv', license: 'MIT (95 RGB references); official product photography (28 derived screen estimates)',
  retrievedAt: '2026-09-28',
}
const palette = { schema: 'material-palette', schemaVersion: 1, id: 'perler-123', name: 'Perler 123', brand: 'Perler', colorCount: 123, automaticColorCount: 118,
  rgbKind: 'screen-reference', source, notes: [
    'Frozen 2026-09-28 official 1,000-count single-color bag catalog; mixed bags and Zebra Stripe are excluded.',
    '95 RGB values from the pinned beadcolors data; 28 estimates from official swatch photographs. No physical color measurements.',
    'Transparent, glow, metallic and pearl beads remain addressable materials, but are excluded from automatic matching. They are not empty board cells.',
  ], colors }
await mkdir(new URL('sources/', destination), { recursive: true })
await writeFile(new URL('perler-123.json', destination), JSON.stringify(palette, null, 2) + '\n')
await writeFile(new URL('sources/perler-123-provenance.json', destination), JSON.stringify({ source,
  selection: 'Official titles beginning "1,000 Perler Beads - ", excluding the Multi-Color tag (including Zebra Stripe).',
  productsSha256: sha256(productsBytes), beadcolorsSha256: sha256(csvBytes),
  photoSampling: 'Central 80% crop, resize to 256x256 sRGB; select pixels between luminance percentiles 35 and 75; take each channel median. Screen estimate only.',
  excludedProducts: bags.filter(p => p.tags.includes('Multi-Color')).map(p => ({ id: p.variants[0].sku, name: p.title })),
  historicalRgbEntriesNotInCatalog: [...upstream.keys()].filter(id => !colors.some(c => c.id === id)), records,
}, null, 2) + '\n')
await writeFile(new URL('sources/beadcolors-LICENSE.txt', destination), await readFile(join(input, 'beadcolors-LICENSE')))
console.log(`Imported ${colors.length} colors: ${upstreamCount} upstream RGB + ${colors.length - upstreamCount} photo estimates; 118 automatic colors`)
