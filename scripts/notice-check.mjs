import {chromium} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
process.env.LD_LIBRARY_PATH='/root/.cache/travel-browser-libs';
const url=process.env.TRAVEL_TEST_URL||'http://127.0.0.1:5190/';
const days=JSON.parse(readFileSync('src/itinerary.json','utf8'));
const trip={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',name:'测试德国旅行',destination:'德国',startDate:'2026-10-12',endDate:'2026-10-21',timezone:'Europe/Berlin',days,version:1,updatedAt:1,packing:{extraItems:[],checkedIds:[],hiddenBaseIds:[],notes:''}};
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const results=[];
try{
 for(const viewport of [{width:1366,height:768},{width:390,height:844}]){
 const page=await browser.newPage({viewport});let native=0;const errors=[];
 page.on('dialog',async d=>{native++;await d.dismiss();});page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{
 const path=new URL(route.request().url()).pathname;let status=200,body;
 if(path==='/api/session')body={authenticated:true,username:'test',accountId:'test-account',role:'friend',csrfToken:'test'};
 else if(path==='/api/trips')body={trips:[trip]};
 else if(path==='/api/packing-template')body={items:[],notes:'测试通用提醒',version:1};
 else if(path.endsWith('/map-pack')){status=503;body={error:'地图资源尚未准备完成，请稍后重试'};}
 else if(path==='/api/trips/'+trip.id)body=trip;
 else throw Error('Unexpected API '+path);
 await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.route('**/map-assets/**',r=>r.abort());
 await page.goto(url);await page.locator('.journey').waitFor();
 const edit=()=>page.getByRole('button',{name:'编辑',exact:true}).click();
 const journey=()=>page.getByRole('button',{name:'行程',exact:true}).click();
 await edit();await page.getByLabel('旅程名称',{exact:true}).waitFor();await journey();await page.locator('.journey').waitFor();assert.equal(await page.locator('.confirmation-card').count(),0);
 await edit();await page.getByLabel('旅程名称',{exact:true}).fill('未保存修改');await journey();await page.locator('.confirmation-card').waitFor();assert.equal(await page.locator('.confirmation-content').evaluate(e=>e.inert),true);
 await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('.confirmation-card')),true);
 await page.keyboard.press('Escape');await page.locator('.confirmation-card').waitFor({state:'detached'});assert.equal(await page.getByLabel('旅程名称',{exact:true}).inputValue(),'未保存修改');
 await page.getByRole('button',{name:'取消',exact:true}).click();await page.locator('.confirmation-card').waitFor();await page.getByRole('button',{name:'继续编辑',exact:true}).click();assert.equal(await page.getByLabel('旅程名称',{exact:true}).inputValue(),'未保存修改');
 await journey();await page.getByRole('button',{name:'放弃修改并离开',exact:true}).click();await page.locator('.journey').waitFor();
 await page.getByRole('button',{name:'导出离线 HTML',exact:true}).click();await page.locator('.app-error').waitFor();assert.match(await page.locator('.app-error').innerText(),/地图资源尚未准备/);await page.waitForTimeout(4300);assert.equal(await page.locator('.app-error').count(),1);await page.waitForTimeout(1000);assert.equal(await page.locator('.app-error').count(),0);
 await page.getByRole('button',{name:'行李与提醒',exact:true}).click();await page.getByLabel('目的地与个人提醒').fill('未保存清单');await journey();await page.locator('.confirmation-card').waitFor();await page.keyboard.press('Escape');assert.equal(await page.getByLabel('目的地与个人提醒').inputValue(),'未保存清单');
 await page.reload();await page.locator('.journey').waitFor();assert.equal(native,0);assert.deepEqual(errors,[]);results.push({viewport,nativeDialogs:native,dirtyGuard:true,noticeExpiresAfterFiveSeconds:true,pageErrors:errors});await page.screenshot({path:'.artifacts/notice-'+viewport.width+'.png'});await page.close();
 }
 writeFileSync('.artifacts/notice-check.json',JSON.stringify({url,results},null,2));console.log(JSON.stringify({url,results}));
}finally{await browser.close();}
