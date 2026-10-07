import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

test('exports the selected tone policy and allows a true zero strength', async ({ page }, testInfo) => {
  // The neural part fixture intentionally fails feature quality. This policy/export
  // test uses the bundled deterministic evidence without relaxing the quality gate.
  test.setTimeout(90_000)
  await page.goto('/apps/demo/')
  await expect(page.locator('#modelRouteSelect')).toBeEnabled({ timeout: 30_000 })
  await page.selectOption('#modelRouteSelect', 'deterministic')
  await expect(page.locator('#downloadButton')).toBeEnabled({ timeout: 30_000 })
  await page.selectOption('#valueModeControl', 'preserve')
  await expect(page.locator('#valueStrengthControl')).toBeDisabled()
  await expect(page.locator('#valueStrengthValue')).toContainText('0%')
  await page.selectOption('#valueModeControl', 'stylized')
  await expect(page.locator('#valueStrengthControl')).toBeEnabled()
  await page.locator('#valueStrengthControl').fill('0')
  await page.locator('#valueStrengthControl').dispatchEvent('input')
  await expect(page.locator('#valueStrengthValue')).toHaveText('0%')
  await page.click('#generateButton')
  await expect(page.locator('#downloadButton')).toBeEnabled({ timeout: 30_000 })
  await page.selectOption('#exportFormat', 'json')
  const downloaded = page.waitForEvent('download')
  await page.click('#downloadButton')
  const document = JSON.parse(await readFile(await (await downloaded).path(), 'utf8'))
  expect(document.metadata.valueMode).toBe('stylized')
  expect(document.metadata.valueStrength).toBe(0)
  expect(document.metadata.algorithmVersion).toBe('0.12.0-source-sampling')
  await page.screenshot({ path: testInfo.outputPath('value-policy-demo.png'), fullPage: true })
})
