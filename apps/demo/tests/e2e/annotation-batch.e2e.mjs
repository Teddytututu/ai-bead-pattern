import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { annotationFromDatasetTask } from '../../server/annotation-dataset.mjs'

test('automatically loads 20 JSON grids, saves when switching, and resumes across the 20/4 boundary', async ({ page }, testInfo) => {
  const prefix = randomUUID()
  const datasetId = 'b'.repeat(64)
  const items = Array.from({ length:24 }, (_,i) => {
    const task = { sampleId:prefix+'-'+i, title:'JSON 图纸 '+(i+1), gridSha256:'a'.repeat(64),
      grid:{width:2,height:2,rgb:[[255,255,255],[255,255,255],[30,40,50],[235,190,151]],occupancy:[null,null,null,null]} }
    const annotation = annotationFromDatasetTask(task,datasetId)
    return { id:annotation.id, sampleId:task.sampleId, title:task.title, annotation }
  })
  await page.route('**/api/annotation-dataset?**', route => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset') || 0)
    return route.fulfill({ json:{available:true,datasetId,offset,batchSize:20,total:24,items:items.slice(offset,offset+20),hasNext:offset+20<24} })
  })
  await page.goto('/apps/demo/annotation.html')
  await expect(page.locator('#batchInfo')).toContainText('本批 20 张')
  await expect(page.locator('#batchInfo')).toContainText('当前 1/24')
  await expect(page.locator('#batchItems option')).toHaveCount(21)
  await expect(page.locator('#inputReviewInfo')).toContainText('4 格占用未知')
  await page.locator('#reviewer').fill('automated-batch-test')
  await page.locator('#markOccupied').click()
  await page.locator('#confirmInput').click()
  await expect(page.locator('#inputReviewInfo')).toContainText('输入已确认')
  await page.locator('#itemNext').click()
  await expect(page.locator('#batchInfo')).toContainText('当前 2/24')
  await expect(page.locator('#reviewer')).toHaveValue('automated-batch-test')
  await page.locator('#batchItems').selectOption('19')
  await expect(page.locator('#batchInfo')).toContainText('当前 20/24')
  await page.locator('#saveNext').click()
  await expect(page.locator('#batchInfo')).toContainText('本批 4 张')
  await expect(page.locator('#batchInfo')).toContainText('当前 21/24')
  await expect(page.locator('#batchItems option')).toHaveCount(5)
  await page.reload()
  await expect(page.locator('#batchInfo')).toContainText('当前 21/24')
  await page.locator('#batchItems').selectOption('3')
  await page.locator('#saveNext').click()
  await expect(page.locator('#message')).toContainText('图库末尾')
  await expect(page.locator('#itemNext')).toBeDisabled()
  await page.locator('#batchPrevious').click()
  await expect(page.locator('#batchInfo')).toContainText('当前 1/24')
  await expect(page.locator('#inputReviewInfo')).toContainText('输入已确认')
  await page.locator('#title').fill('Unsent change')
  await page.route('**/api/annotations', async route => {
    if(route.request().method()==='POST')return route.fulfill({ status:503, json:{detail:'保存失败测试'} })
    return route.continue()
  })
  await page.locator('#itemNext').click()
  await expect(page.locator('#message')).toContainText('保存失败测试')
  await expect(page.locator('#batchInfo')).toContainText('当前 1/24')
  await expect(page.locator('#title')).toHaveValue('Unsent change')
  await page.screenshot({ path:testInfo.outputPath('batch-desktop.png'),fullPage:true })
  await page.setViewportSize({width:390,height:844})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
})
