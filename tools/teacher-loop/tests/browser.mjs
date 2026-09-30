import { chromium } from '@playwright/test';
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:7119');
await page.waitForFunction(()=>document.getElementById('dataset').textContent.includes('500'));
await page.waitForFunction(()=>document.getElementById('source').complete&&document.getElementById('source').naturalWidth>0);
await page.getByRole('heading',{name:'选择卡通风格，同时保持原图主体不失真'}).waitFor();
 await page.screenshot({path:'output/teacher-loop/browser-desktop.png',fullPage:true});
if(await page.locator('#a').getAttribute('src')){
 await page.locator('#a').evaluate(im=>im.decode());
 await page.getByRole('button',{name:'仅 A 合格'}).click();
 if(!await page.locator('#save').isEnabled())throw Error('Review cannot be saved');
 await page.locator('#next').click();
 if(!(await page.locator('#message').innerText()).includes('尚未保存'))throw Error('Unsaved annotation was lost');
 // Exercise a human-like review against an isolated mocked write, never label real data.
 await page.route('**/api/rounds/*/items/*/review',async route=>{
   const body=route.request().postDataJSON();
   if(body.accepted!=='a'||!Number.isInteger(body.version))throw Error('Review schema mismatch');
   await route.fulfill({json:{...body,version:body.version+1,updated:'browser-test',exports:[{name:'labels-browser-fixture.jsonl',count:25,url:'/api/exports/labels-browser-fixture.jsonl'}]}});
 });
 await page.route('**/api/exports/labels-browser-fixture.jsonl',route=>route.fulfill({body:'{"fixture":true}\n',headers:{'Content-Type':'application/x-ndjson','Content-Disposition':'attachment; filename="labels-browser-fixture.jsonl"'}}));
 const downloadPromise=page.waitForEvent('download');
 await page.locator('#save').click();
 const download=await downloadPromise;if(download.suggestedFilename()!=='labels-browser-fixture.jsonl')throw Error('Auto JSONL download failed');
 await page.waitForFunction(()=>document.getElementById('message').textContent.includes('已保存'));
}
await page.setViewportSize({width:390,height:844});
await page.screenshot({path:'output/teacher-loop/browser-mobile.png',fullPage:true});
if(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1))throw Error('Mobile horizontal overflow');
if(errors.length)throw Error(errors.join('\n'));
await browser.close();console.log('Browser UI checks passed; production labels were not written.');
