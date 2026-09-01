import { expect, test } from '@playwright/test'

test('runs real neural analysis and exposes model contributions', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/apps/demo/')
  await expect(page.locator('#modelRouteSelect')).toBeVisible()
  await expect(page.locator('#modelRouteSelect option[value="learned-pixelization"]')).toBeDisabled()
  await expect(page.locator('#modelRouteSelect option[value="generative-proposal"]')).toBeDisabled()

  await page.locator('#modelRouteSelect').selectOption('neural-analysis')
  await expect(page.locator('#analysisSource')).toContainText('BiRefNet', { timeout: 45_000 })
  await expect(page.locator('#statusText')).not.toHaveText('生成中', { timeout: 45_000 })

  await page.getByRole('button', { name: '分析图层' }).click()
  const dialog = page.getByRole('dialog', { name: '图像理解' })
  await expect(dialog.getByRole('button', { name: 'AI 主体', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: '边缘', exact: true })).toBeEnabled()
  await expect(dialog.locator('#analysisDebugProvider')).toContainText('rembg-birefnet-general-lite')
  await expect(dialog.locator('#analysisDebugContributions')).toContainText('subject-segmentation')
})

test('keeps route controls and unavailable state readable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/apps/demo/')

  await expect(page.locator('#modelRouteSelect')).toBeInViewport()
  await expect(page.locator('#modelRouteStatus')).toContainText(/已连接|检查中|不可用/)
  const layout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    selectWidth: document.querySelector('#modelRouteSelect').getBoundingClientRect().width,
  }))
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth)
  expect(layout.selectWidth).toBeLessThan(layout.viewportWidth)
})
