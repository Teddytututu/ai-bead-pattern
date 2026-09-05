import { expect, test } from '@playwright/test'

test('generates a refined pattern with planning diagnostics', async ({ page }) => {
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto('/apps/demo/')
  await expect(page.locator('#patternCanvas')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('#preferencePanel')).toBeHidden()

  await expect(page.locator('#refinementModeControl [data-refinement="quality"]'))
    .toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#patternCanvas')).toBeVisible()
  await expect(page.locator('#structureRegionCount')).not.toHaveText('--', { timeout: 20_000 })
  await expect(page.locator('#valueRoleCount')).not.toHaveText('--')
  await expect(page.locator('#paletteRoleCount')).not.toHaveText('--')
  await expect(page.locator('#gridRefinementEnergy')).toContainText('→')
  await expect(page.locator('#outlineModeValue')).toHaveText('选择性')
  await page.locator('[data-outline-mode="full"]').click()
  await expect(page.locator('#outlineModeValue')).toHaveText('完整')
  await expect(page.locator('[data-outline-mode="full"]')).toHaveAttribute('aria-pressed', 'true')
  expect(errors).toEqual([])
})

test('records multidimensional scores, localized issues, comparison, and session restore', async ({ page }) => {
  await page.goto('/apps/demo/?internal=1')
  await expect(page.locator('#patternCanvas')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('#preferencePanel')).toBeVisible()

  await page.locator('#preferenceStartButton').click()
  await expect(page.locator('#preferenceWorkbenchDialog')).toBeVisible()
  await expect(page.locator('.preference-workbench-hint')).toContainText('点候选标题')
  await expect(page.locator('.preference-candidate-card')).toHaveCount(4)
  await expect(page.locator('#preferenceAxisScores input[type="range"]')).toHaveCount(11)
  await expect(page.locator('#preferenceIssueTags button')).toHaveCount(14)
  await expect(page.locator('#preferenceWorkbenchDialog')).toHaveAttribute('data-preference-record-schema', '2')
  await expect(page.locator('#preferenceLearningSampleCount')).toContainText('1')
  await expect(page.locator('#preferenceRankingDifference')).toContainText('规则')
  await expect(page.locator('#preferenceGenerationFeedback')).toContainText('边缘')

  const firstActivePair = await page.locator('#preferenceActivePair').textContent()

  const identityScore = page.locator('#preferenceAxisScores input[data-axis-id="identity"]')
  await identityScore.fill('5')
  await identityScore.dispatchEvent('change')
  await page.locator('.preference-candidate-canvas').first().click({ position: { x: 80, y: 80 } })
  await expect(page.locator('#preferenceIssueList .preference-issue-row')).toHaveCount(1)
  await expect(page.locator('#preferenceProgressText')).toContainText('1/44')

  await page.locator('#preferenceUndoButton').click()
  await expect(page.locator('#preferenceIssueList .preference-issue-row')).toHaveCount(0)
  await page.locator('#preferenceRedoButton').click()
  await expect(page.locator('#preferenceIssueList .preference-issue-row')).toHaveCount(1)
  await page.locator('[data-preference-layer="structure"]').click()
  await expect(page.locator('[data-preference-layer="structure"]')).toHaveAttribute('aria-pressed', 'true')
  await page.locator('[data-comparison-choice="tie"]').click()
  await expect(page.locator('#preferenceWorkbenchStatus')).toContainText('1 次比较')
  await expect(page.locator('#preferenceActivePair')).not.toHaveText(firstActivePair)

  await page.locator('#preferenceWorkbenchCloseButton').click()
  await page.locator('#preferenceStartButton').click()
  await expect(page.locator('#preferenceIssueList .preference-issue-row')).toHaveCount(1)
})

test('keeps the workbench contained on a 390px mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/apps/demo/')
  await expect(page.locator('#preferencePanel')).toBeHidden()

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
