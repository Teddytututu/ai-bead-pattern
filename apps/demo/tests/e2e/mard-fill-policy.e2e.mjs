import { expect, test } from '@playwright/test'

test('shows one MARD ink, excludes black fill, and keeps 24-color mode compatible', async ({ page }) => {
  test.setTimeout(60_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/apps/demo/')
  await expect(page.locator('#generateButton')).toBeEnabled({ timeout: 30_000 })
  await expect(page.locator('#contourStatus')).toContainText(/单色深描边 (B22|B23|C12|C18|D4|D10|D15|D22|F7|F11|G8|R22)\b/)
  await expect(page.locator('#materialList')).not.toContainText(/\bH7\b/)
  await page.locator('[data-size="32"]').click()
  await page.selectOption('#paletteSelect', 'generic-24')
  await expect(page.locator('#generateButton')).toBeEnabled({ timeout: 30_000 })
  await expect(page.locator('#paletteCount')).toHaveText('24 色')
  await expect(page.locator('#contourStatus')).not.toContainText('单色深描边')
  expect(errors).toEqual([])
})
