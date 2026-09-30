// Isolated browser QA; synthetic edits are never imported into the real dataset.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'

const run = resolve(process.argv[2] ?? 'output/template-learning/ft1-preannotation-v1')
const output = resolve(process.argv[3] ?? 'output/tests/template-review-browser')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(pathToFileURL(resolve(run, 'pilot/review/index.html')).href)
  await page.waitForFunction(() => document.querySelector('#sourceImage').complete && document.querySelector('#sourceImage').naturalWidth > 0)
  assert.equal(await page.locator('#sample option').count(), 24)
  await page.screenshot({ path: resolve(output, 'initial-desktop.png') })
  // Export untouched machine drafts: no reviewer and zero confirmed parts.
  const download0 = page.waitForEvent('download')
  await page.locator('#export').click()
  await (await download0).saveAs(resolve(output, 'unreviewed-draft.json'))
  const original = JSON.parse(await readFile(resolve(output, 'unreviewed-draft.json'), 'utf8'))
  assert.equal(original.samples.length, 24)
  assert.equal(original.samples.flatMap(s => s.parts).filter(p => p.confirmed).length, 0)
  assert(original.samples.every(s => s.rights.decision === 'pending' && !s.groupConfirmed && !s.gridConfirmed))
  // Manual correction cannot be accepted without a person, visibility and role.
  await page.locator('#add').click()
  await page.locator('#partConfirmed').click()
  assert.equal(await page.locator('#partConfirmed').isChecked(), false)
  await page.locator('#reviewer').fill('synthetic-browser-test-not-human-gold')
  await page.locator('#visibility').selectOption('visible')
  await page.locator('#role').selectOption('eye-dark')
  await page.locator('#fillUnknown').click()
  await page.locator('#role').selectOption('eye-highlight')
  await page.locator('#grid').click({ position: { x: 5, y: 5 } })
  await page.locator('#undo').click()
  await page.locator('#partConfirmed').check()
  assert.equal(await page.locator('#partConfirmed').isChecked(), true)
  await page.locator('#next').click()
  await page.locator('#prev').click()
  const last = (await page.locator('#part option').count()) - 1
  await page.locator('#part').selectOption(String(last))
  assert.equal(await page.locator('#partConfirmed').isChecked(), true)
  await page.reload()
  await page.locator('#part').selectOption(String(last))
  assert.equal(await page.locator('#partConfirmed').isChecked(), true)
  await page.locator('#gridConfirmed').click()
  assert.equal(await page.locator('#gridConfirmed').isChecked(), false)
  // A source-permission claim without evidence must prevent export.
  await page.locator('#rightsDecision').selectOption('granted')
  await page.locator('#export').click()
  assert.match(await page.locator('#message').textContent(), /依据与证据/)
  await page.locator('#rightsDecision').selectOption('pending')
  const download1 = page.waitForEvent('download')
  await page.locator('#export').click()
  await (await download1).saveAs(resolve(output, 'synthetic-ui-edits.json'))
  const edited = JSON.parse(await readFile(resolve(output, 'synthetic-ui-edits.json'), 'utf8'))
  assert.equal(edited.samples.flatMap(s => s.parts).filter(p => p.confirmed).length, 1)
  assert.deepEqual(edited.samples[0].parts.at(-1).cells, ['eye-dark'])
  assert(edited.samples.every(s => s.rights.decision === 'pending'))
  await page.locator('#importFile').setInputFiles(resolve(output, 'unreviewed-draft.json'))
  await page.waitForFunction(() => document.querySelector('#message').textContent.includes('已恢复'))
  assert.match(await page.locator('#message').textContent(), /已恢复/)
  assert.match(await page.locator('#progress').textContent(), /已确认 0 个部件/)
  // All three views can load across every sample, including failed predictions.
  for (let sample = 0; sample < 24; sample++) {
    await page.locator('#sample').selectOption(String(sample))
    for (const view of ['sheet', 'panel', 'flat']) {
      await page.locator('#view').selectOption(view)
      await page.waitForFunction(() => document.querySelector('#sourceImage').complete && document.querySelector('#sourceImage').naturalWidth > 0)
    }
  }
  await page.locator('#sample').selectOption('0')
  await page.setViewportSize({ width: 700, height: 1000 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: resolve(output, 'mobile.png') })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ samples: 24, views: 72, draftExport: 'passed', correctionRestore: 'passed', eligibilityGuards: 'passed', pageErrors: errors }))
  await context.close()
} finally {
  await browser.close()
}
