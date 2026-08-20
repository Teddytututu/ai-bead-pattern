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

async function openGate(page, rater = 'e2e-rater') {
  await page.goto(`/apps/demo/?maskGateIndex=${encodeURIComponent(indexUrl)}&sample=wide-01&rater=${rater}`)
  await expect(page.locator('#maskGatePanel')).toBeVisible()
  await expect(page.locator('#maskGateLockInitialButton')).toBeDisabled()
}

async function lockInitial(page, acceptable) {
  await page.locator(`input[name="gateInitialAcceptable"][value="${acceptable}"]`).check()
  await expect(page.locator('#maskGateLockInitialButton')).toBeEnabled()
  await page.locator('#maskGateLockInitialButton').click()
  await expect(page.locator('#maskGateInitialFieldset')).toHaveAttribute('disabled', '')
}

async function downloadAttempt(page) {
  const downloadPromise = page.waitForEvent('download')
  await page.locator('#maskGateExportButton').click()
  const download = await downloadPromise
  const stream = await download.createReadStream()
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
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
  const commonIdentity = {
    protocolVersion: 'mask-gate-v2',
    datasetId: 'demo-e2e',
    manifestFingerprint: 'e2e-manifest-fingerprint',
    sampleOrderSeed: 'e2e-order-seed',
    modelConfigurationId: 'birefnet-general-lite-v1',
    commits: {
      core: 'core-e2e',
      demo: 'demo-e2e',
      gateway: 'gateway-e2e',
    },
  }
  const metadata = {
    schemaVersion: 2,
    ...commonIdentity,
    imageId: 'wide-01',
    sampleOrder: 1,
    sample: {
      category: 'portrait',
      cohort: 'targeted-failure',
      failureTags: ['thin-structure'],
      subjectCount: 1,
      targetMobile: true,
    },
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
    schemaVersion: 2,
    ...commonIdentity,
    samples: [{
      imageId: 'wide-01',
      category: 'portrait',
      cohort: 'targeted-failure',
      failureTags: ['thin-structure'],
      subjectCount: 1,
      targetMobile: true,
      sampleOrder: 1,
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

test('exports an accepted V2 interaction', async ({ page }) => {
  const pageErrors = capturePageErrors(page)
  await openGate(page, 'accepted-rater')
  await lockInitial(page, 'true')
  await page.locator('#maskGateAcceptButton').click()
  await expect(page.locator('#maskGateExportButton')).toBeEnabled()

  const attempt = await downloadAttempt(page)
  expect(attempt.outcome).toBe('accepted')
  expect(attempt.initialSubjectAcceptable).toBe(true)
  expect(attempt.protocolVersion).toBe('mask-gate-v2')
  expect(attempt.beforeSnapshot.patternHash).toMatch(/^[a-f0-9]{64}$/)
  expect('session' in attempt).toBe(false)
  expect(pageErrors).toEqual([])
})

test('exports a confirmed V2 interaction with blind A/B evidence', async ({ page }) => {
  const pageErrors = capturePageErrors(page)
  await openGate(page, 'confirmed-rater')
  await lockInitial(page, 'false')
  await page.locator('#maskGateEditButton').click()
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

  await page.locator('input[name="gateSubjectAcceptable"][value="true"]').check()
  await expect(page.locator('#maskGateComparison')).toBeVisible()
  await page.locator('input[name="gatePreference"][value="left"]').check()
  await expect(page.locator('#maskGateExportButton')).toBeEnabled()

  const attempt = await downloadAttempt(page)
  expect(attempt.outcome).toBe('confirmed')
  expect(attempt.session.strokes).toHaveLength(1)
  expect(attempt.beforeSnapshot.patternHash).toMatch(/^[a-f0-9]{64}$/)
  expect(attempt.afterSnapshot.patternHash).toMatch(/^[a-f0-9]{64}$/)
  expect(attempt.blindComparison.choice).toBe('left')
  expect(attempt.blindComparison.leftVariant).toMatch(/before|after/)
  expect(attempt.device.inputModality).toBe('mouse')
  expect(pageErrors).toEqual([])
})

test('exports a cancelled V2 interaction', async ({ page }) => {
  const pageErrors = capturePageErrors(page)
  await openGate(page, 'cancelled-rater')
  await lockInitial(page, 'false')
  await page.locator('#maskGateEditButton').click()
  const canvas = page.locator('#maskEditorCanvas')
  const box = await canvas.boundingBox()
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5)
  await page.locator('#maskEditorCloseButton').click()
  await expect(page.locator('#maskGateExportButton')).toBeEnabled()

  const attempt = await downloadAttempt(page)
  expect(attempt.outcome).toBe('cancelled')
  expect(attempt.session.strokes).toHaveLength(1)
  expect('afterSnapshot' in attempt).toBe(false)
  expect(pageErrors).toEqual([])
})

test('exports an explicit V2 error interaction', async ({ page }) => {
  const pageErrors = capturePageErrors(page)
  await openGate(page, 'error-rater')
  await lockInitial(page, 'false')
  await page.locator('#maskGateErrorButton').click()
  await expect(page.locator('#maskGateExportButton')).toBeEnabled()

  const attempt = await downloadAttempt(page)
  expect(attempt.outcome).toBe('error')
  expect(attempt.error.code).toBe('manual-gate-error')
  expect(pageErrors).toEqual([])
})

test('keeps the Gate usable at 390 by 844 and records touch-class metadata', async ({ page }) => {
  const pageErrors = capturePageErrors(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await openGate(page, 'mobile-rater')
  await lockInitial(page, 'true')
  await page.locator('#maskGateAcceptButton').click()
  const attempt = await downloadAttempt(page)

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  expect(attempt.device.class).toBe('mobile')
  expect(pageErrors).toEqual([])
})
