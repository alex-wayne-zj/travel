import {chromium} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
process.env.LD_LIBRARY_PATH='/root/.cache/travel-browser-libs';
const url=process.env.TRAVEL_TEST_URL||'http://127.0.0.1:5190/';
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox']});
mkdirSync('.artifacts',{recursive:true});const results=[];
try{for(const width of [1366,768,390,375]){
 const height=width===375?667:width===390?844:768;const page=await browser.newPage({viewport:{width,height},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',route=>{
  assert.equal(route.request().method(),'GET','UI verification must not write to the API');const path=new URL(route.request().url()).pathname;
  const body=path==='/api/session'?{authenticated:true,username:'test',accountId:'test',role:'friend',csrfToken:'test'}:path==='/api/trips'?{trips:[]}:path==='/api/packing-template'?{items:[],notes:'',version:1}:null;
  assert.ok(body,`Unexpected ${path}`);return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto(url);await page.getByRole('button',{name:'创建新旅途',exact:true}).click();
 const enter=async(label,value)=>{await page.getByRole('button',{name:label,exact:true}).click();await page.getByRole('button',{name:'手动输入',exact:true}).click();await page.getByLabel('手动输入'+label,{exact:true}).fill(value);await page.getByRole('button',{name:'关闭日历',exact:true}).click();};
 const field=label=>({fill:value=>enter(label,value),inputValue:async()=>((await page.getByRole('button',{name:label,exact:true}).innerText()).replaceAll('/','-'))});
 const start=field('开始日期'),end=field('结束日期');
 await start.fill('2028-02-28');await end.fill('2028-03-03');
 await page.getByRole('button',{name:'开始日期',exact:true}).click();let dialog=page.getByRole('dialog',{name:'开始日期日历'});await dialog.waitFor();
 assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('data-date')),'2028-02-28');
 await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('data-date')),'2028-02-29');
 await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('data-date')),'2028-03-01');await page.keyboard.press('Enter');assert.equal(await start.inputValue(),'2028-03-01');assert.equal(await dialog.count(),0);
 assert.equal(await page.getByRole('button',{name:'开始日期',exact:true}).evaluate(e=>e===document.activeElement),true);
 await start.fill('2028-02-28');await page.getByRole('button',{name:'结束日期',exact:true}).click();dialog=page.getByRole('dialog',{name:'结束日期日历'});
 await page.getByRole('button',{name:'上个月',exact:true}).click();await page.getByRole('button',{name:'下个月',exact:true}).click();
 const geometry=await dialog.boundingBox();assert.ok(geometry.x>=15&&geometry.x+geometry.width<=width-15);assert.ok(geometry.y>=15&&geometry.y+geometry.height<=height-15);
 assert.equal(await dialog.locator('[data-date="2028-03-03"]').getAttribute('aria-selected'),'true');assert.ok(await dialog.locator('.in-range').count()>=3);
 await page.screenshot({path:`.artifacts/date-picker-${width}.png`});
 await page.keyboard.press('Escape');assert.equal(await dialog.count(),0);assert.equal(await end.inputValue(),'2028-03-03');
 await page.getByRole('button',{name:'开始日期',exact:true}).click();await page.getByLabel('旅程名称',{exact:true}).click();assert.equal(await page.locator('.date-calendar').count(),0);
 await page.getByRole('button',{name:'开始日期',exact:true}).click();await page.keyboard.press('PageDown');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('data-date')),'2028-03-28');await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('data-date')),'2028-03-27');await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('data-date')),'2028-04-02');await page.keyboard.press('Escape');
 await start.fill('2028-12-31');await page.getByRole('button',{name:'开始日期',exact:true}).click();await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('data-date')),'2029-01-01');await page.keyboard.press('Escape');
 // Tab can leave the nonmodal panel without capturing focus.
 await page.getByRole('button',{name:'开始日期',exact:true}).click();await page.keyboard.press('Tab');await page.keyboard.press('Tab');await page.keyboard.press('Tab');assert.equal(await page.locator('.date-calendar').count(),0);
 // Invalid manual dates remain drafts; existing application validation reports the error.
 await start.fill('2028-02-30');await page.getByRole('button',{name:'应用',exact:true}).click();assert.match(await page.locator('.basics-dates').innerText(),/有效日期/);
 await start.fill('2028-02-28');await end.fill('2028-02-27');await page.getByRole('button',{name:'应用',exact:true}).click();assert.match(await page.locator('.basics-dates').innerText(),/不能早于/);
 await end.fill('2028-03-03');await page.getByRole('button',{name:'应用',exact:true}).click();assert.equal(await page.locator('.editor-dates button').count(),5);
 // Four-digit year extremes stay in their own year without exposing invalid adjacent cells.
 await start.fill('0099-12-31');await page.getByRole('button',{name:'开始日期',exact:true}).click();assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('data-date')),'0099-12-31');await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('data-date')),'0100-01-01');await page.keyboard.press('Escape');
 await start.fill('9999-12-31');await page.getByRole('button',{name:'开始日期',exact:true}).click();assert.equal(await page.getByRole('button',{name:'下个月',exact:true}).isDisabled(),true);await page.keyboard.press('ArrowRight');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('data-date')),'9999-12-31');await page.keyboard.press('Escape');
 await start.fill('0000-01-01');await page.getByRole('button',{name:'开始日期',exact:true}).click();assert.equal(await page.getByRole('button',{name:'上个月',exact:true}).isDisabled(),true);await page.keyboard.press('ArrowLeft');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('data-date')),'0000-01-01');await page.keyboard.press('Escape');
 await start.fill('2028-02-28');await page.getByRole('button',{name:'开始日期',exact:true}).click();await page.evaluate(()=>window.dispatchEvent(new Event('travel:reauth')));await page.locator('.date-calendar').waitFor({state:'detached'});assert.equal(await page.locator('.date-calendar').count(),0);assert.equal(await start.inputValue(),'2028-02-28');await page.locator('.reauth-dialog').waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
 results.push({width,geometry,leapDay:true,yearBoundary:true,range:true,keyboard:true,manualValidation:true,extremeYears:true,reauthPreservesDraft:true,errors});await page.close();
}}
finally{await browser.close()}
writeFileSync('.artifacts/date-picker-check.json',JSON.stringify({url,results},null,2)+'\n');console.log(JSON.stringify({url,results}));
