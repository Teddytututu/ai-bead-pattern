import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../wechat-miniapp/pages/index/index.ts', import.meta.url), 'utf8')
const script = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText
const catalogs = [
  { id: 'perler-123', name: 'Perler 123', colorCount: 123, automaticColorCount: 118 },
  { id: 'generic-24', name: '通用 24 色', colorCount: 24 },
  { id: 'mard-291', name: 'MARD 291', colorCount: 291, automaticColorCount: 291 },
]
function harness(listPalettes) {
  let page
  const removed = []
  runInNewContext(script, { exports: {},
    require: name => name.endsWith('/config') ? { config: { apiBaseUrl: 'http://localhost' } } : {
      WechatPatternClient: class { listPalettes = listPalettes }, ApiError: Error,
    },
    wx: { getStorageSync: () => undefined, removeStorageSync: key => removed.push(key) },
    Page: value => { page = value; page.setData = data => Object.assign(page.data, data) },
  })
  return { get page() { return page }, removed }
}

test('miniapp resolves palette IDs from API order and preserves pending retry on initial load', async () => {
  const { page, removed } = harness(async () => catalogs)
  await page.loadPalettes()
  assert.equal(page.data.paletteId, 'mard-291'); assert.equal(page.data.paletteIndex, 2)
  assert.equal(removed.length, 0)
  page.changePalette({ detail: { value: '0' } })
  assert.equal(page.data.paletteId, 'perler-123'); assert.equal(page.data.colorLimit, 48)
  assert.match(page.data.paletteNote, /123.*118/)
  page.data.maxColors = 48
  page.changePalette({ detail: { value: '1' } })
  assert.equal(page.data.paletteId, 'generic-24'); assert.equal(page.data.maxColors, 24)
  assert.equal(page.data.paletteNote, '')
  assert.deepEqual(removed, ['pendingPatternRequest', 'pendingPatternRequest'])
})

test('miniapp catalog failure can retry without enabling generation against an unknown palette', async () => {
  let attempts = 0
  const { page } = harness(async () => { if (!attempts++) throw new Error('network unavailable'); return catalogs })
  await page.loadPalettes()
  assert.equal(page.data.palettes.length, 0); assert.equal(page.data.paletteLoading, false)
  assert.ok(page.data.error)
  await page.loadPalettes()
  assert.equal(page.data.palettes.length, 3); assert.equal(page.data.error, '')
})
