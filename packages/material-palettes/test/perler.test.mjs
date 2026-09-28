import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { getPalette, parsePalette } from '../dist/index.js'
import { createPatternAlgorithm, createPatternDocument, createPaletteVersion, patternMaterialsCsv, patternSvg } from '../../pattern-core/dist/index.js'
const palette = await getPalette('perler-123')
const provenance = JSON.parse(await readFile(new URL('../../../assets/palettes/sources/perler-123-provenance.json', import.meta.url), 'utf8'))
const algorithm = createPatternAlgorithm({ clock: () => 123 })
const options = { width: 1, height: 1, maxColors: 1, baseline: 'a0', styles: ['faithful'], maxCandidates: 1 }
const image = colors => ({ width: colors.length, height: 1, data: new Uint8ClampedArray(colors.flatMap(c => [...c.rgb, 255])) })

test('Perler snapshot preserves 123 official SKUs, sources and 118 automatic colors', () => {
  assert.equal(palette.colorCount, 123)
  assert.equal(palette.automaticColorCount, 118)
  assert.equal(palette.brand, 'Perler')
  assert.equal(palette.rgbKind, 'screen-reference')
  assert.deepEqual(palette.colors.map(c => [c.id, c.name, c.rgb]), provenance.records.map(c => [c.id, c.name, c.rgb]))
  assert.equal(provenance.records.filter(c => c.rgbSource === 'beadcolors').length, 95)
  assert.equal(provenance.records.filter(c => c.rgbSource === 'official-photo-estimate').length, 28)
  assert.ok(palette.colors.every(c => c.id === c.code && /^(80-\d{5}|PER\d{5})$/.test(c.code)))
  assert.deepEqual(palette.colors.filter(c => !c.automaticMatch).map(c => [c.id, c.finish]), [
    ['80-15105', 'pearl'], ['80-15184', 'transparent'], ['80-19019', 'transparent'], ['80-19075', 'glow'], ['80-19085', 'metallic'],
  ])
  assert.ok(provenance.historicalRgbEntriesNotInCatalog.every(id => !palette.colors.some(c => c.id === id)))
})

test('all 118 ordinary Perler colors round-trip to real purchase codes', async () => {
  const seen = new Set()
  for (const color of palette.colors.filter(c => c.automaticMatch)) {
    if (seen.has(color.rgb.join(','))) continue
    seen.add(color.rgb.join(','))
    const result = await algorithm.generate({ palette, image: image([color]), options })
    assert.equal(result.status, 'success')
    assert.equal(result.pattern.cells[0].colorId, color.id)
    assert.equal(result.pattern.metadata.paletteVersion, palette.version)
  }
})

test('special finishes cannot leak into any automatic baseline or contour selection', async () => {
  const special = palette.colors.filter(c => !c.automaticMatch)
  for (const baseline of ['a0', 'a1', 'mvp']) {
    const result = await algorithm.generate({ palette, image: image(special), options: { ...options, baseline, width: 5, maxColors: 5 } })
    assert.equal(result.status, 'success')
    assert.ok(result.pattern.palette.every(c => c.automaticMatch))
  }
  await assert.rejects(algorithm.generate({ palette, image: image(special), options: { ...options, structure: { contours: { colorId: special[0].id } } } }), /automatic matching/)
  await assert.rejects(algorithm.generate({ palette: { ...palette, colors: special }, image: image(special), options }), /automatic matching/)
  const changed = structuredClone(palette); changed.colors[0].automaticMatch = !changed.colors[0].automaticMatch
  assert.notEqual(await createPaletteVersion(changed), palette.version)
})

test('explicit clear beads count as material, stay fixed during adaptation and never spread', async () => {
  const white = palette.colors.find(c => c.name === 'White'), clear = palette.colors.find(c => c.id === '80-19019')
  const result = await algorithm.generate({ palette, image: image([white]), options })
  const pattern = { ...result.pattern, width: 3, height: 1, palette: [white, clear], cells: [
    { x: 0, y: 0, colorId: clear.id }, { x: 1, y: 0, colorId: white.id },
  ] }
  const adapted = await algorithm.adapt({ palette, pattern, fixedCells: [pattern.cells[0]], coherence: 100 })
  assert.deepEqual(adapted.pattern.cells, pattern.cells)
  const doc = createPatternDocument(adapted.pattern)
  assert.ok(doc.grid[0] >= 0); assert.equal(doc.grid[2], -1)
  assert.equal(doc.materials.reduce((n, m) => n + m.count, 0), 2)
  assert.match(patternMaterialsCsv(adapted.pattern), /"Perler","perler-123"/)
  assert.match(patternMaterialsCsv(adapted.pattern), /80-19019/)
  const svg = patternSvg(adapted.pattern)
  assert.match(svg, /width="46" height="46"/)
  assert.match(svg, />80-19019<\/text>/)
})

test('catalog validation catches Perler count, SKU, finish and eligibility corruption', async () => {
  for (const mutate of [
    p => p.colors.pop(), p => p.colors[0].code = 'P01', p => p.automaticColorCount++,
    p => p.colors[0].automaticMatch = 'false', p => p.colors[0].finish = 'unknown',
    p => p.colors.find(c => c.finish === 'transparent').automaticMatch = true,
  ]) {
    const changed = structuredClone(palette); mutate(changed)
    await assert.rejects(parsePalette(changed))
  }
})
