import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createEyeAnnotation } from '../../eye-annotation-state.mjs'
const grid={width:8,height:6,paletteId:'test',paletteVersion:'1',colors:[{id:'skin',rgb:[234,191,160]},{id:'dark',rgb:[30,25,20]}],cells:Array.from({length:48},(_,i)=>[18,19,21,22].includes(i)?1:0)}
async function point(page,x,y){
  const c=page.locator('#gridCanvas');await c.scrollIntoViewIfNeeded();const box=await c.boundingBox()
  return{x:box.x+(x+.5)/8*box.width,y:box.y+(y+.5)/6*box.height}
}
async function drawBox(page,x1,y1,x2,y2){
  const from=await point(page,x1,y1),to=await point(page,x2,y2)
  await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:5});await page.mouse.up()
}
async function skin(page){
  await page.locator('#pickSkin').click();const p=await point(page,1,1);await page.mouse.click(p.x,p.y)
}
async function state(page){return page.evaluate(()=>JSON.parse(localStorage.getItem('eye-annotation-workspace-v1')))}
test('single image supports eye boxes and a skin eyedropper, seals all content once, and stays immutable after reload',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await page.goto('/apps/demo/annotation.html')
  await page.locator('.utilities').evaluate(el=>el.open=true)
  await page.locator('#import').setInputFiles({name:'eyes.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(grid))})
  await expect(page.locator('#gridInfo')).toContainText('8 × 6')
  await expect(page.locator('canvas')).toHaveCount(1)
  expect(await page.locator('#canvasFrame').evaluate(frame=>frame.scrollHeight<=frame.clientHeight+1)).toBe(true)
  await expect(page.locator('#target, #confirmContext, #confirmInput, #reviewer')).toHaveCount(0)
  await expect(page.locator('#seal')).toBeDisabled()
  await drawBox(page,2,2,3,3);await drawBox(page,6,3,5,2)
  expect((await state(page)).annotation.eyeBoxes).toEqual([{x:2,y:2,width:2,height:2},{x:5,y:2,width:2,height:2}])
  await page.getByRole('button',{name:'删除眼睛 2'}).click()
  await page.locator('#zoom').selectOption('1.5')
  await drawBox(page,5,2,6,3)
  await page.locator('#zoom').selectOption('1')
  await skin(page)
  await expect(page.locator('#skinValue')).toHaveText('#EABFA0')
  await page.locator('#prompt').fill('Dark eyes with white highlights.')
  await expect(page.locator('#seal')).toBeEnabled()
  const before=(await state(page)).annotation
  expect(before.currentGrid).toEqual(grid)
  expect(before.skinSample).toEqual({x:1,y:1,colorId:'skin'})
  await page.reload()
  await expect(page.locator('#boxCount')).toHaveText('2 个框')
  await expect(page.locator('#prompt')).toHaveValue(before.prompt)
  await page.screenshot({path:testInfo.outputPath('eyes-desktop.png'),fullPage:true})
  await page.locator('#seal').click()
  await expect(page.locator('#saveState')).toContainText('已封存')
  const final=await state(page)
  expect(final.annotation.currentGrid).toEqual(grid)
  expect(final.annotation.confirmation).toMatchObject({grid:true,eyeMask:true,skin:true,prompt:true})
  await expect(page.locator('#prompt')).toBeDisabled()
  await expect(page.locator('#pickSkin')).toBeDisabled()
  await expect(page.locator('#seal')).toBeDisabled()
  const server=await(await page.request.get('/api/eye-annotations/'+final.annotation.id)).json()
  expect(server.annotation).toEqual(final.annotation)
  await page.reload();await expect(page.locator('#saveState')).toContainText('已封存')
  await page.setViewportSize({width:390,height:844})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  await page.screenshot({path:testInfo.outputPath('eyes-mobile.png'),fullPage:true})
  expect(errors).toEqual([])
})
test('20/4 queue advances only after a successful seal and preserves an unsealed draft on server failure',async({page})=>{
  const prefix=randomUUID(),datasetId='b'.repeat(64)
  const items=Array.from({length:24},(_,i)=>{
    const annotation=createEyeAnnotation(grid,{title:'图纸 '+(i+1),sourceName:prefix+'-'+i})
    return{id:annotation.id,sampleId:prefix+'-'+i,title:annotation.title,annotation}
  })
  await page.route('**/api/eye-annotation-dataset?**',route=>{
    const offset=Number(new URL(route.request().url()).searchParams.get('offset')||0)
    return route.fulfill({json:{available:true,datasetId,offset,total:24,batchSize:20,items:items.slice(offset,offset+20),hasNext:offset+20<24}})
  })
  await page.goto('/apps/demo/annotation.html')
  await expect(page.locator('#progress')).toContainText('当前 1 / 24')
  await page.locator('#batchItems').selectOption('19')
  await drawBox(page,2,2,3,3);await skin(page);await page.locator('#prompt').fill('Bright eyes.')
  await page.route('**/api/eye-annotations',async route=>{
    if(route.request().method()==='POST')return route.fulfill({status:503,json:{detail:'封存保存失败测试'}})
    return route.continue()
  })
  await page.locator('#seal').click()
  await expect(page.locator('#message')).toContainText('保存失败')
  await expect(page.locator('#progress')).toContainText('当前 20 / 24')
  expect((await state(page)).annotation.status).toBe('draft')
  await expect(page.locator('#seal')).toBeEnabled()
  await page.unroute('**/api/eye-annotations')
  await page.locator('#seal').click()
  await expect(page.locator('#progress')).toContainText('本批 4 张')
  await expect(page.locator('#progress')).toContainText('当前 21 / 24')
  await page.reload();await expect(page.locator('#progress')).toContainText('当前 21 / 24')
  await page.locator('#batchPrevious').click();await page.locator('#batchItems').selectOption('19')
  await expect(page.locator('#recordStatus')).toHaveText('已封存')
  await expect(page.locator('#prompt')).toHaveValue('Bright eyes.')
  await page.locator('#batchNext').click();await page.locator('#batchItems').selectOption('3')
  await drawBox(page,2,2,3,3);await skin(page);await page.locator('#prompt').fill('Last eyes.')
  await page.locator('#seal').click()
  await expect(page.locator('#message')).toContainText('图库末尾')
  await expect(page.locator('#next')).toBeDisabled()
  await expect(page.locator('#saveState')).toContainText('已封存')
})
