import { expect, test } from '@playwright/test'

async function waitForGeneration(page) {
  await page.waitForFunction(() => document.querySelector('#statusText')?.textContent !== '生成中')
}

async function uploadWideImage(page) {
  await expect(page.locator('#fileInput')).toBeEnabled({ timeout: 20_000 })
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

test('roughly circles a subject, confirms once, and restores the solid selection', async ({ page }) => {
  await page.goto('/apps/demo/')
  await waitForGeneration(page)
  await page.getByRole('button', { name: '圈选主体' }).click()

  const canvas = page.getByLabel('主体圈选画布')
  await expect(canvas).toBeVisible()
  const bounds = await canvas.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.move(bounds.x + bounds.width * 0.08, bounds.y + bounds.height * 0.08)
  await page.mouse.down()
  for (const [x, y] of [[0.92, 0.08], [0.92, 0.92], [0.08, 0.92], [0.08, 0.08]]) {
    await page.mouse.move(bounds.x + bounds.width * x, bounds.y + bounds.height * y, { steps: 8 })
  }
  await page.mouse.up()
  await expect(page.locator('#maskEditorDetail')).toContainText('待确认')
  await expect(page.locator('#maskEditorDetail')).toContainText('自动识别')

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

  await page.getByRole('button', { name: '圈选主体' }).click()
  await expect(page.locator('#maskEditorDetail')).toContainText('1 / 1 次调整 · 已确认')
  await expect(canvas).toBeVisible()
  const reopenedBounds = await canvas.boundingBox()
  expect(reopenedBounds).not.toBeNull()
  await page.getByRole('button', { name: '补充' }).click()
  await page.mouse.click(reopenedBounds.x + reopenedBounds.width * 0.25, reopenedBounds.y + reopenedBounds.height * 0.75)
  await expect(page.locator('#maskEditorDetail')).toContainText('取消将放弃')
  await page.getByRole('button', { name: '取消并关闭主体编辑器' }).click()
  await page.getByRole('button', { name: '圈选主体' }).click()
  await expect(page.locator('#maskEditorDetail')).toContainText('1 / 1 次调整 · 已确认')
})

test('keeps a wide source proportional in the mobile editor', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/apps/demo/')
  await waitForGeneration(page)
  await uploadWideImage(page)
  await page.getByRole('button', { name: '圈选主体' }).click()

  const canvas = page.getByLabel('主体圈选画布')
  await expect.poll(async () => canvas.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    return bounds.width > 0 && bounds.height > 0
  })).toBe(true)
  const dimensions = await canvas.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    return {
      displayRatio: bounds.width / bounds.height,
      sourceRatio: element.width / element.height,
    }
  })
  expect(dimensions.displayRatio).toBeCloseTo(2, 5)
  expect(dimensions.sourceRatio).toBe(2)
  await expect(page.getByRole('button', { name: '取消并关闭主体编辑器' })).toBeInViewport()
  await expect(page.getByRole('button', { name: '确认主体并重新生成' })).toBeInViewport()
})
