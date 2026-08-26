import { expect, test } from '@playwright/test'

test('generates a refined pattern with planning diagnostics', async ({ page }) => {
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto('/apps/demo/')
  await expect(page.locator('#preferenceStartButton')).toBeEnabled({ timeout: 20_000 })

  await expect(page.locator('#refinementModeControl [data-refinement="quality"]'))
    .toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#patternCanvas')).toBeVisible()
  await expect(page.locator('#structureRegionCount')).not.toHaveText('--')
  await expect(page.locator('#valueRoleCount')).not.toHaveText('--')
  await expect(page.locator('#paletteRoleCount')).not.toHaveText('--')
  await expect(page.locator('#gridRefinementEnergy')).toContainText('→')
  expect(errors).toEqual([])
})

test('records a blind candidate preference and updates local ranking', async ({ page }) => {
  await page.goto('/apps/demo/')
  await expect(page.locator('#preferenceStartButton')).toBeEnabled({ timeout: 20_000 })
  await expect(page.locator('#preferenceComparison')).toBeHidden()

  await page.locator('#preferenceStartButton').click()
  await expect(page.locator('#preferenceComparison')).toBeVisible()
  await expect(page.locator('#preferenceCanvasA')).toBeVisible()
  await expect(page.locator('#preferenceCanvasB')).toBeVisible()
  await page.locator('[data-preference-choice="left"]').click()

  await expect(page.locator('#preferenceStatus')).toContainText('1 次比较')
  await expect(page.locator('.candidate-name').first()).toContainText('偏好')
})

test('keeps the workbench contained on a 390px mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/apps/demo/')
  await expect(page.locator('#preferenceStartButton')).toBeEnabled({ timeout: 20_000 })

  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    canvas: document.querySelector('#patternCanvas').getBoundingClientRect().toJSON(),
    frame: document.querySelector('.pattern-frame').getBoundingClientRect().toJSON(),
  }))
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth)
  expect(layout.canvas.width).toBeLessThanOrEqual(layout.frame.width)
  expect(layout.canvas.height).toBeLessThanOrEqual(layout.frame.height)
})
