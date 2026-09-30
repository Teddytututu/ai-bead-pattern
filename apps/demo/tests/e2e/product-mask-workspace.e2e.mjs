import { test, expect } from '@playwright/test'
test('product masks own subject and eye guidance while training uses a separate app and data boundary',async({page,context})=>{
  test.setTimeout(60000)
  const trainingWrites=[]
  context.on('request',req=>{if(req.url().includes('/api/eye-annotations')&&req.method()==='POST')trainingWrites.push(req.url())})
  await page.goto('/apps/demo/')
  await expect(page.locator('#generateButton')).toBeEnabled({timeout:40000})
  await expect(page.locator('#maskTools')).toBeVisible()
  await expect(page.locator('#maskTools #openMaskEditorButton')).toBeVisible()
  await expect(page.locator('#maskTools #regionExperiment')).toBeEnabled()
  await expect(page.locator('#annotationWorkspace')).toBeHidden()
  await context.route('**/api/ai/region/health',r=>r.fulfill({json:{status:'ready',adapterConfigured:false}}))
  const opened=context.waitForEvent('page');await page.locator('#regionExperiment').click();const eyes=await opened
  await expect(eyes).toHaveURL(/mode=eye-guidance/)
  await expect(eyes.locator('h1')).toHaveText('眼睛蒙版')
  await expect(eyes.locator('#annotatePair')).toBeHidden()
  await expect(eyes.locator('#seal')).toHaveCount(0)
  const canvas=eyes.locator('#before');await canvas.scrollIntoViewIfNeeded();const rect=await canvas.boundingBox()
  for(const [x1,y1,x2,y2] of [[.3,.4,.4,.5],[.7,.5,.6,.4]]){
    await eyes.mouse.move(rect.x+rect.width*x1,rect.y+rect.height*y1);await eyes.mouse.down()
    await eyes.mouse.move(rect.x+rect.width*x2,rect.y+rect.height*y2,{steps:4});await eyes.mouse.up()
  }
  await expect(eyes.locator('#guidanceStatus')).toContainText('2 个眼睛框')
  let request
  await eyes.route('**/api/ai/region/prepare',route=>{
    request=route.request().postDataJSON()
    return route.fulfill({json:{contextSha256:'a'.repeat(64),skinColorId:request.currentGrid.colors[0].id,fillableCells:request.editMask.filter(Boolean).length,preview:{input:'',mask:''}}})
  })
  await eyes.locator('#prepare').click()
  await expect(eyes.locator('#generate')).toBeEnabled()
  expect(request.schemaVersion).toBe('region-generation-v3')
  expect(request.editMask.filter(Boolean).length).toBeGreaterThan(0)
  expect(request).not.toHaveProperty('confirmation')
  await eyes.locator('#removeEyeBox').click()
  await expect(eyes.locator('#guidanceStatus')).toContainText('1 个眼睛框')
  await expect(eyes.locator('#generate')).toBeDisabled()
  await eyes.locator('#import').setInputFiles({name:'training.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({schemaVersion:'eye-annotation-v1'}))})
  await expect(eyes.locator('#status')).toContainText('独立训练标注端')
  expect(trainingWrites).toEqual([])
  await eyes.close()
})
