import { expect, test } from '@playwright/test'

async function waitForGeneration(page) {
  await page.waitForFunction(() => {
    const status = document.querySelector('#status')
    const generateButton = document.querySelector('#generateButton')
    return generateButton instanceof HTMLButtonElement
      && generateButton.disabled === false
      && status instanceof HTMLElement
      && status.dataset.state !== 'busy'
  })
}

async function uploadWideImage(page) {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 80
    canvas.height = 40
    const context = canvas.getContext('2d')
    context.fillStyle = '#edf2ef'
    context.fillRect(0, 0, 80, 40)
    context.fillStyle = '#287d73'
    context.fillRect(24, 8, 32, 24)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    const transfer = new DataTransfer()
    transfer.items.add(new File([blob], 'wide-analysis-test.png', { type: 'image/png' }))
    const input = document.querySelector('#fileInput')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(page.locator('#fileName')).toHaveText('wide-analysis-test.png')
  await waitForGeneration(page)
}

test('switches analysis layers and exposes the confirmed subject state', async ({ page }) => {
  await page.goto('/apps/demo/')
  await waitForGeneration(page)
  await page.getByRole('button', { name: '分析图层' }).click()

  const dialog = page.getByRole('dialog', { name: '图像理解' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: '修正主体', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '原图', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '原图', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: '关闭图像理解' }).click()

  await page.locator('#openMaskEditorButton').click()
  await page.getByRole('button', { name: '确认主体并重新生成' }).click()
  await waitForGeneration(page)
  await page.getByRole('button', { name: '分析图层' }).click()
  await expect(dialog.getByRole('button', { name: '修正主体', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: '修正主体', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('keeps a wide source proportional in the mobile analysis viewer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/apps/demo/')
  await waitForGeneration(page)
  await uploadWideImage(page)
  await page.getByRole('button', { name: '分析图层' }).click()

  const dimensions = await page.getByLabel('图像理解图层画布').evaluate((canvas) => {
    const bounds = canvas.getBoundingClientRect()
    return {
      displayRatio: bounds.width / bounds.height,
      sourceRatio: canvas.width / canvas.height,
    }
  })
  expect(dimensions.displayRatio).toBeCloseTo(2, 5)
  expect(dimensions.sourceRatio).toBe(2)
  await expect(page.getByRole('button', { name: '关闭图像理解' })).toBeInViewport()
})

test('shows resolved eye, nose, and mouth cells for the sample portrait', async ({ page }) => {
  await page.goto('/apps/demo/')
  await waitForGeneration(page)
  await page.getByRole('button', { name: '分析图层' }).click()

  const dialog = page.getByRole('dialog', { name: '图像理解' })
  const features = dialog.getByRole('button', { name: '五官落格', exact: true })
  await expect(features).toBeEnabled()
  await features.click()
  await expect(features).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.locator('#analysisDebugStatus')).toContainText('五官')
})
