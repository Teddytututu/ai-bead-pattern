import { expect, test } from '@playwright/test'

async function waitForGeneration(page) {
  await page.waitForFunction(() => document.querySelector('#statusText')?.textContent !== '生成中')
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
    transfer.items.add(new File([blob], 'wide-mask-test.png', { type: 'image/png' }))
    const input = document.querySelector('#fileInput')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(page.locator('#fileName')).toHaveText('wide-mask-test.png')
  await waitForGeneration(page)
}

test('edits, confirms once, and restores the confirmed session', async ({ page }) => {
  await page.goto('/apps/demo/')
  await waitForGeneration(page)
  await page.getByRole('button', { name: '修正主体' }).click()

  const canvas = page.getByLabel('主体修正画布')
  const bounds = await canvas.boundingBox()
  await page.mouse.click(bounds.x + bounds.width * 0.75, bounds.y + bounds.height * 0.25)
  await expect(page.locator('#maskEditorDetail')).toContainText('待确认')

  await page.getByRole('button', { name: '撤销' }).click()
  await expect(page.getByRole('button', { name: '重做' })).toBeEnabled()
  await page.getByRole('button', { name: '重做' }).click()

  await page.evaluate(() => {
    window.__maskGenerationStarts = 0
    const status = document.querySelector('#statusText')
    window.__maskStatusObserver = new MutationObserver(() => {
      if (status.textContent === '生成中') window.__maskGenerationStarts += 1
    })
    window.__maskStatusObserver.observe(status, { childList: true, subtree: true })
  })
  await page.getByRole('button', { name: '确认主体并重新生成' }).click()
  await expect(page.locator('#maskEditorDialog')).toBeHidden()
  await expect(page.locator('#analysisSource')).toHaveText('人工确认主体')
  await waitForGeneration(page)
  const generationStarts = await page.evaluate(() => {
    window.__maskStatusObserver.disconnect()
    return window.__maskGenerationStarts
  })
  expect(generationStarts).toBe(1)

  await page.getByRole('button', { name: '修正主体' }).click()
  await expect(page.locator('#maskEditorDetail')).toHaveText('1 / 1 笔 · 已确认')
  const reopenedBounds = await canvas.boundingBox()
  await page.mouse.click(
    reopenedBounds.x + reopenedBounds.width * 0.25,
    reopenedBounds.y + reopenedBounds.height * 0.75,
  )
  await expect(page.locator('#maskEditorDetail')).toContainText('取消将放弃')
  await page.getByRole('button', { name: '取消并关闭主体编辑器' }).click()
  await page.getByRole('button', { name: '修正主体' }).click()
  await expect(page.locator('#maskEditorDetail')).toHaveText('1 / 1 笔 · 已确认')
})

test('keeps a wide source proportional in the mobile editor', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/apps/demo/')
  await waitForGeneration(page)
  await uploadWideImage(page)
  await page.getByRole('button', { name: '修正主体' }).click()

  const dimensions = await page.getByLabel('主体修正画布').evaluate((canvas) => {
    const bounds = canvas.getBoundingClientRect()
    return {
      displayRatio: bounds.width / bounds.height,
      sourceRatio: canvas.width / canvas.height,
    }
  })
  expect(dimensions.displayRatio).toBeCloseTo(2, 5)
  expect(dimensions.sourceRatio).toBe(2)
  await expect(page.getByRole('button', { name: '取消并关闭主体编辑器' })).toBeInViewport()
  await expect(page.getByRole('button', { name: '确认主体并重新生成' })).toBeInViewport()
})
