import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { expect, test } from '@playwright/test'

import { numericArrayFingerprintSync } from '../../packages/pattern-core/dist/index.js'

const require = createRequire(new URL('../../services/ai-gateway/package.json', import.meta.url))
const sharp = require('sharp')

const fixtureDirectory = resolve('work/mask-gate/e2e')
const indexUrl = '/work/mask-gate/e2e/index.json'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function capturePageErrors(page) {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

test.beforeAll(async () => {
  await mkdir(fixtureDirectory, { recursive: true })
  const sourcePixels = Buffer.alloc(8 * 4 * 4, 255)
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const offset = (y * 8 + x) * 4
      sourcePixels[offset] = x >= 2 && x <= 5 ? 210 : 240
      sourcePixels[offset + 1] = x >= 2 && x <= 5 ? 70 : 240
      sourcePixels[offset + 2] = x >= 2 && x <= 5 ? 55 : 235
    }
  }
  const sourcePng = await sharp(sourcePixels, {
    raw: { width: 8, height: 4, channels: 4 },
  }).png().toBuffer()
  const maskRaw = Buffer.from([
    0, 0, 255, 255, 255, 255, 0, 0,
    0, 0, 255, 255, 255, 255, 0, 0,
    0, 0, 255, 255, 255, 255, 0, 0,
    0, 0, 255, 255, 255, 255, 0, 0,
  ])
  const maskPng = await sharp(maskRaw, {
    raw: { width: 8, height: 4, channels: 1 },
  }).png().toBuffer()
  const fingerprint = numericArrayFingerprintSync(
    Float32Array.from(maskRaw, (value) => value / 255),
  )
  const upstreamRevision = 'rembg-http:birefnet-general-lite:e2e'
  const metadata = {
    schemaVersion: 1,
    imageId: 'wide-01',
    datasetId: 'demo-e2e',
    source: {
      path: 'wide-01.source.png',
      sha256: sha256(sourcePng),
      width: 8,
      height: 4,
    },
    mask: {
      path: 'wide-01.mask.png',
      sha256: sha256(maskPng),
      width: 8,
      height: 4,
      encoding: 'png-u8-gray',
      numericFingerprint: fingerprint,
    },
    evidence: {
      confidence: 0.8,
      source: 'ai',
      upstreamRevision,
      revision: `sidecar:${upstreamRevision}:u8:${fingerprint}`,
      provenance: [{
        origin: 'model',
        provider: 'rembg-http',
        model: 'birefnet-general-lite',
        version: 'e2e',
      }],
    },
    modelVersions: { segmentation: 'rembg/birefnet-general-lite' },
  }
  const index = {
    schemaVersion: 1,
    datasetId: 'demo-e2e',
    samples: [{
      imageId: 'wide-01',
      category: 'portrait',
      cohort: 'failure',
      failureType: 'thin-edge',
      source: 'wide-01.source.png',
      mask: 'wide-01.mask.png',
      analysis: 'wide-01.analysis.json',
    }],
  }
  await Promise.all([
    writeFile(resolve(fixtureDirectory, 'wide-01.source.png'), sourcePng),
    writeFile(resolve(fixtureDirectory, 'wide-01.mask.png'), maskPng),
    writeFile(resolve(fixtureDirectory, 'wide-01.analysis.json'), JSON.stringify(metadata)),
    writeFile(resolve(fixtureDirectory, 'index.json'), JSON.stringify(index)),
  ])
})

test.afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true })
})

test('loads a real sidecar and exports a confirmed gate attempt', async ({ page }) => {
  const pageErrors = capturePageErrors(page)
  await page.goto(`/apps/demo/?maskGateIndex=${encodeURIComponent(indexUrl)}&sample=wide-01`)

  await expect(page.locator('#fileName')).toHaveText('wide-01')
  await expect(page.locator('#analysisSource')).toHaveText('AI 分割')
  await expect(page.locator('#maskGatePanel')).toBeVisible()
  await page.locator('#openMaskEditorButton').click()
  await expect(page.locator('#maskEditorDialog')).toBeVisible()
  await expect(page.locator('#maskEditorCanvas')).toHaveJSProperty('width', 8)
  await expect(page.locator('#maskEditorCanvas')).toHaveJSProperty('height', 4)

  const canvas = page.locator('#maskEditorCanvas')
  const box = await canvas.boundingBox()
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5)
  await page.mouse.up()
  await page.locator('#maskConfirmButton').click()
  await expect(page.locator('#maskEditorDialog')).toBeHidden()

  await page.locator('input[name="gateInitialAcceptable"][value="false"]').check()
  await page.locator('input[name="gateSubjectAcceptable"][value="true"]').check()
  await page.locator('input[name="gatePreference"][value="after"]').check()
  await expect(page.locator('#maskGateExportButton')).toBeEnabled()

  const downloadPromise = page.waitForEvent('download')
  await page.locator('#maskGateExportButton').click()
  const download = await downloadPromise
  const stream = await download.createReadStream()
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  const attempt = JSON.parse(Buffer.concat(chunks).toString('utf8'))

  expect(attempt.imageId).toBe('wide-01')
  expect(attempt.outcome).toBe('confirmed')
  expect(attempt.session.strokes).toHaveLength(1)
  expect(attempt.beforeGenerationId).toMatch(/^[a-f0-9]{32}$/)
  expect(attempt.afterGenerationId).toMatch(/^[a-f0-9]{32}$/)
  expect(attempt.correctionEndedAt).toBeGreaterThanOrEqual(attempt.correctionStartedAt)
  expect(attempt.patternPreference).toBe('after')
  expect(pageErrors).toEqual([])
})

test('exports an unrated attempt when mask editing is cancelled', async ({ page }) => {
  const pageErrors = capturePageErrors(page)
  await page.goto(`/apps/demo/?maskGateIndex=${encodeURIComponent(indexUrl)}&sample=wide-01`)

  await page.locator('input[name="gateInitialAcceptable"][value="false"]').check()
  await page.locator('#openMaskEditorButton').click()
  await expect(page.locator('#maskEditorDialog')).toBeVisible()

  const canvas = page.locator('#maskEditorCanvas')
  const box = await canvas.boundingBox()
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5)
  await page.locator('#maskEditorCloseButton').click()
  await expect(page.locator('#maskEditorDialog')).toBeHidden()
  await expect(page.locator('#maskGateExportButton')).toBeEnabled()

  const downloadPromise = page.waitForEvent('download')
  await page.locator('#maskGateExportButton').click()
  const download = await downloadPromise
  const stream = await download.createReadStream()
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  const attempt = JSON.parse(Buffer.concat(chunks).toString('utf8'))

  expect(attempt.imageId).toBe('wide-01')
  expect(attempt.outcome).toBe('cancelled')
  expect(attempt.patternPreference).toBe('unrated')
  expect(attempt.subjectAcceptable).toBe(false)
  expect(attempt.session.strokes).toHaveLength(1)
  expect(attempt.beforeGenerationId).toMatch(/^[a-f0-9]{32}$/)
  expect('afterGenerationId' in attempt).toBe(false)
  expect(attempt.correctionEndedAt).toBeGreaterThanOrEqual(attempt.correctionStartedAt)
  expect(pageErrors).toEqual([])
})

test('keeps the gate controls usable at 390 by 844', async ({ page }) => {
  const pageErrors = capturePageErrors(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/apps/demo/?maskGateIndex=${encodeURIComponent(indexUrl)}&sample=wide-01`)

  await expect(page.locator('#maskGatePanel')).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  expect(pageErrors).toEqual([])
})
