// Opt-in integration check against a real, already running local SDXL service.
import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
const base = process.env.SDXL_DEMO_URL ?? 'http://127.0.0.1:4177'
const output = resolve(process.argv[2] ?? 'output/diagnostics/sdxl-browser-v1')
await mkdir(output, { recursive: false })
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto(base + '/apps/demo/region.html')
  await page.locator('#example').click()
  await page.locator('#status').filter({ hasText: '缺少左眼' }).waitFor()
  // Exercise mask tools without modifying the original missing-eye mask.
  const box = await page.locator('#before').boundingBox()
  await page.locator('#brush').selectOption('lock')
  await page.mouse.click(box.x + box.width * .8, box.y + box.height * .8)
  await page.locator('#brush').selectOption('unlock')
  await page.mouse.click(box.x + box.width * .8, box.y + box.height * .8)
  assert.equal(await page.locator('#generate').isDisabled(), true)
  assert.equal(await page.locator('#export').isDisabled(), true)
  await page.locator('#prepare').click()
  await page.locator('#phase').filter({ hasText: '第 1 步完成' }).waitFor()
  assert.equal(await page.locator('#generate').isDisabled(), false)
  await page.locator('#size').selectOption('1024')
  assert.equal(await page.locator('#generate').isDisabled(), true)
  await page.locator('#size').selectOption('512')
  await page.locator('#prepare').click()
  await page.locator('#phase').filter({ hasText: '第 1 步完成' }).waitFor()
  const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/ai/region/generate') && r.request().method() === 'POST', { timeout: 240000 })
  await page.locator('#generate').click()
  const response = await responsePromise
  assert.equal(response.status(), 200, await response.text())
  const result = await response.json()
  assert.equal(result.decision, 'candidate', JSON.stringify(result.validation))
  assert.ok(result.changedCells.length > 0, 'Masked-context fixture should provide a filled candidate')
  assert.deepEqual([result.diagnostics.outsideChanged, result.diagnostics.lockedChanged, result.diagnostics.unfilledCells], [0, 0, 0])
  assert.equal(result.diagnostics.newlyOccupiedCells, 20)
  assert.equal(result.provenance.conditioning, 'full-grid-with-skin-prefill')
  assert.equal(result.provenance.skinColorId, 'diag-2')
  await page.locator('#accept').waitFor({ state: 'visible' })
  await page.screenshot({ path: resolve(output, 'candidate.png'), fullPage: true })
  await page.locator('#accept').click()
  assert.match(await page.locator('#status').innerText(), /填写接受原因/)
  await page.locator('#reason').fill('自动化流程测试：确认接受与撤销。非人工质量评审。')
  await page.locator('#accept').click()
  assert.match(await page.locator('#status').innerText(), /已接受/)
  async function download(id, name) {
    const event = page.waitForEvent('download'); await page.locator(id).click()
    const file = await event; await file.saveAs(resolve(output, name))
    return JSON.parse(await readFile(resolve(output, name), 'utf8'))
  }
  const accepted = await download('#export', 'accepted-pattern.json')
  assert.deepEqual(accepted.grid, result.grid.cells)
  assert.equal(accepted.totalBeads, accepted.grid.filter(v => v >= 0).length)
  assert.equal(accepted.materials.reduce((n, m) => n + m.count, 0), accepted.totalBeads)
  await page.locator('#undo').click()
  assert.equal(await page.locator('#export').isDisabled(), true, 'Undo restores draft holes; exporting as a completed grid must be blocked')
  const audit = await download('#audit', 'replay.json')
  const generated = audit.events.find(e => e.event === 'generated')
  assert.deepEqual(audit.currentGrid.cells, generated.request.currentGrid.cells)
  assert.notDeepEqual(audit.currentGrid.cells, accepted.grid)
  assert.equal(audit.trainingEligible, false)
  assert.equal(audit.accepted.length, 0)
  // Real main-workbench handoff uses its existing generated pattern document.
  await page.goto(base + '/apps/demo/')
  // A real analysis can produce a repairable candidate that fails the export quality gate.
  await page.locator('#candidateList .candidate[aria-pressed="true"]').waitFor({ timeout: 180000 })
  const popupPromise = page.waitForEvent('popup')
  await page.locator('#regionExperiment').click()
  const popup = await popupPromise
  await popup.waitForLoadState('networkidle')
  assert.match(await popup.locator('#status').innerText(), /已载入/)
  assert.equal(errors.length, 0, errors.join('\n'))
  const report = { status: 'passed-real-service-ui-not-quality', changedCells: result.changedCells.length, metrics: result.metrics,
    checks: ['paint lock/unlock', 'surroundings before fill', 'input change invalidates confirmation', 'skin-base full-grid GPU inference', 'no unfilled cells', 'reason required', 'accept', 'material totals', 'undo blocks incomplete export', 'replay export', 'main workbench handoff'], errors }
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { await browser.close() }
