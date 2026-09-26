import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { getPalette, listPalettes, parsePalette } from '../dist/index.js'
import { createPatternAlgorithm, createPaletteVersion, patternLimits } from '../../pattern-core/dist/index.js'

const raw = JSON.parse(await readFile(new URL('../../../assets/palettes/mard-291.json', import.meta.url), 'utf8'))
const algorithm = createPatternAlgorithm({ clock: () => 123 })
function image(colors) {
  return { width: colors.length, height: 1, data: new Uint8ClampedArray(colors.flatMap(c => [...c.rgb, 255])) }
}
const options = { width: 1, height: 1, maxColors: 1, baseline: 'a0', styles: ['faithful'], maxCandidates: 1 }

test('validates and freezes the complete versioned catalog', async () => {
  const palette = await getPalette()
  assert.equal(palette.colors.length, 291)
  assert.equal(Object.keys(palette.groups).length, 15)
  assert.match(palette.version, /^sha256:[a-f0-9]{64}$/)
  assert.equal(palette.version, await createPaletteVersion(palette))
  assert.deepEqual((await listPalettes()).map(p => p.id), ['mard-291', 'generic-24'])
  assert.throws(() => { palette.colors[0].rgb[0] = 0 }, TypeError)
  await assert.rejects(getPalette('missing'), /Unknown/)
  await assert.rejects(getPalette('mard-291', 'stale'), /Unknown/)
})

test('rejects malformed counts, duplicate codes, bad groups, RGB, HEX and Lab', async () => {
  for (const mutate of [
    p => p.colors.pop(), p => p.colorCount++, p => p.colors[1].id = p.colors[0].id,
    p => p.colors[1].code = p.colors[0].code, p => p.groups.A++,
    p => p.colors[0].rgb[0] = 256, p => p.colors[0].hex = '#000000',
    p => p.colors[0].lab = [1, 2], p => p.colors[0].lab = [1, NaN, 2],
    p => p.schemaVersion = 2,
  ]) {
    const value = structuredClone(raw); mutate(value)
    await assert.rejects(parsePalette(value))
  }
})

test('version tracks content, preserves key-order equivalence, excludes stock', async () => {
  const palette = await getPalette()
  assert.equal(await createPaletteVersion({ ...palette, inventory: { A1: 0 } }), palette.version)
  const reversedKeys = Object.fromEntries(Object.entries(palette).reverse())
  assert.equal(await createPaletteVersion(reversedKeys), palette.version)
  const changed = structuredClone(palette)
  changed.colors[0].lab = [50, 0, 0]
  assert.notEqual(await createPaletteVersion(changed), palette.version)
})

test('all 291 colors remain reachable, including indices above 255', async () => {
  const palette = await getPalette()
  // Every unique RGB must round-trip to its exact physical code with a single-color input.
  const seen = new Set()
  for (const color of palette.colors) {
    const key = color.rgb.join(',')
    if (seen.has(key)) continue
    seen.add(key)
    const result = await algorithm.generate({ palette, image: image([color]), options })
    assert.equal(result.status, 'success')
    assert.equal(result.pattern.cells[0].colorId, color.id)
    assert.equal(result.pattern.metadata.paletteVersion, palette.version)
    assert.equal(result.pattern.metadata.paletteId, 'mard-291')
  }
})

test('512 colors accepted, 513 rejected; used colors, blank cells and adaptation agree', async () => {
  const palette = await getPalette()
  const expanded = { ...palette, id: 'expanded', version: undefined, colors: Array.from({ length: 512 }, (_, i) => ({ ...palette.colors[i % 291], id: `c${i}` })) }
  assert.equal((await algorithm.generate({ palette: expanded, image: image([palette.colors[0]]), options })).status, 'success')
  await assert.rejects(algorithm.generate({ palette: { ...expanded, colors: [...expanded.colors, { ...expanded.colors[0], id: 'overflow' }] }, image: image([palette.colors[0]]), options }), /limit/)
  assert.equal(patternLimits.maxPaletteColors, 512)
  for (const maxColors of [1, 20, 48]) {
    const result = await algorithm.generate({ palette, image: image(palette.colors.slice(240, 288)), options: { ...options, width: 48, maxColors } })
    assert.equal(result.status, 'success')
    assert.ok(result.materialCounts.length <= maxColors)
    assert.equal(result.materialCounts.reduce((n, c) => n + c.count, 0), result.pattern.cells.length)
    const fixedCells = [result.pattern.cells[0]]
    const adapted = await algorithm.adapt({ palette, pattern: result.pattern, fixedCells, maxChangedCells: 0 })
    assert.equal(adapted.pattern.cells[0].colorId, fixedCells[0].colorId)
    assert.equal(adapted.pattern.metadata.paletteVersion, palette.version)
  }
  const result = await algorithm.generate({ palette, image: image([palette.colors[290]]), options: { ...options, width: 8, height: 4 } })
  assert.ok(result.pattern.cells.length < 32)
  assert.equal(result.materialCounts.reduce((n, c) => n + c.count, 0), result.pattern.cells.length)
})

test('palette content, stock and options change generation identity', async () => {
  const palette = await getPalette()
  const request = { palette, image: image([palette.colors[0]]), options }
  const first = await algorithm.generate(request)
  assert.equal(first.generationId, (await algorithm.generate(request)).generationId)
  const changed = structuredClone(palette); changed.colors[0].lab = [0, 0, 0]
  assert.notEqual(first.generationId, (await algorithm.generate({ ...request, palette: changed })).generationId)
  assert.notEqual(first.generationId, (await algorithm.generate({ ...request, palette: { ...palette, inventory: { A1: 0 } } })).generationId)
  assert.notEqual(first.generationId, (await algorithm.generate({ ...request, options: { ...options, maxColors: 2 } })).generationId)
})
