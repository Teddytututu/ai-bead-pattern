import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

test('exports the selected tone policy and allows a true zero strength', async ({ page }) => {
  // Initial auto search plus a second generation; each generation keeps its 30 s wait budget.
  test.setTimeout(60_000)
  await page.goto('/apps/demo/')
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
  expect(document.metadata.algorithmVersion).toBe('0.10.0-mard-ink-fill')
  await page.screenshot({ path: 'output/value-policy-demo.png', fullPage: true })
})
