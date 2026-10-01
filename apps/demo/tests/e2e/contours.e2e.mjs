import { expect, test } from '@playwright/test'

test('keeps contour generation and removes facial template controls', async ({ page }) => {
  // Initial automatic search and a second fixed-grid generation both run in this test.
  test.setTimeout(60_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/apps/demo/')
  await expect(page.locator('#generateButton')).toBeEnabled({ timeout: 30_000 })
  await expect(page.locator('#featureEditor')).toHaveCount(0)
  await expect(page.locator('#featureStatus')).toHaveCount(0)
  await expect(page.locator('#externalContour')).toBeChecked()
  await expect(page.locator('#internalContour')).toBeChecked()
  await page.uncheck('#internalContour')
  await page.locator('[data-size="32"]').click()
  await page.locator('[data-occupancy="full-frame"]').click()
  await page.click('#generateButton')
  await expect(page.locator('#generateButton')).toBeEnabled({ timeout: 30_000 })
  await expect(page.locator('#externalContour')).toBeChecked()
  await expect(page.locator('#internalContour')).not.toBeChecked()
  await expect(page.locator('#contourStatus')).toContainText('轮廓')
  expect(errors).toEqual([])
})
