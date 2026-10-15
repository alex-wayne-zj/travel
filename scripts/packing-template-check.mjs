import {chromium} from '@playwright/test';
import {readFileSync,mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
process.env.LD_LIBRARY_PATH='/root/.cache/travel-browser-libs';
const url=process.env.TRAVEL_TEST_URL||'http://127.0.0.1:5199/';
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
mkdirSync('.artifacts',{recursive:true});
try{for(const width of [320,375,390,1366]){
 let template={items:[{id:'base',category:'日常用品',label:'很长的模板物品名称'}],notes:'共用提醒',version:1};
 let trip={id:'packing-test',name:'模板验收旅程',destination:'德国',startDate:'2026-10-12',endDate:'2026-10-21',timezone:'Asia/Shanghai',days:JSON.parse(readFileSync('src/itinerary.json','utf8')),version:1,updatedAt:1,packing:{baseItems:structuredClone(template.items),baseNotes:template.notes,extraItems:[],checkedIds:[],hiddenBaseIds:[],notes:''}};
 let reject=true,payload;
 const page=await browser.newPage({viewport:{width,height:844},isMobile:width<600,hasTouch:width<600}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async r=>{
  const path=new URL(r.request().url()).pathname;let body,status=200;
  if(path==='/api/session')body={authenticated:true,accountId:'test',role:'friend',csrfToken:'test'};
  else if(path==='/api/trips')body={trips:[trip]};
  else if(path==='/api/packing-template'){
   if(r.request().method()==='PUT'){
    payload=r.request().postDataJSON();
    if(reject){status=409;body={error:'conflict'};reject=false;}
    else{const {currentTrip,...shared}=payload;template={...shared,version:shared.version+1};trip={...trip,version:trip.version+1,packing:{...currentTrip.packing,baseItems:template.items,baseNotes:template.notes}};body={...template,trip};}
   }else body=template;
  }else if(path==='/api/trips/'+trip.id)body=trip;
  else{status=503;body={error:'unavailable'};}
  await r.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.route('**/map-style.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({version:8,sources:{},layers:[]})}));
 await page.goto(url);await page.getByRole('button',{name:'行李与提醒',exact:true}).click();
 await page.locator('.check-item input').first().check();await page.getByLabel('注意事项',{exact:true}).fill('保留未保存的个人提醒');
 await page.getByRole('button',{name:'管理共用模板',exact:true}).click();await page.waitForTimeout(300);
 for(const label of ['模板分类','模板物品']){
  const input=page.getByLabel(label,{exact:true});await input.click();
  const g=await input.evaluate(e=>{const rect=e.getBoundingClientRect(),clip=e.closest('.motion-panel-clip').getBoundingClientRect(),style=getComputedStyle(e);return {left:rect.left,right:rect.right,clipLeft:clip.left,clipRight:clip.right,font:parseFloat(style.fontSize),offset:parseFloat(style.outlineOffset),outline:parseFloat(style.outlineWidth),viewport:innerWidth};});
  assert.ok(g.left>=g.clipLeft&&g.right<=g.clipRight&&g.left>=0&&g.right<=g.viewport,JSON.stringify(g));
  if(width<600)assert.ok(g.font>=16);await input.press('Tab');
  if(await input.evaluate(e=>e.matches(':focus-visible')))assert.ok(g.offset+g.outline<=0);
 }
 await page.getByLabel('模板物品',{exact:true}).fill('更新后的模板物品');await page.getByLabel('共用提醒',{exact:true}).fill('更新后的共用提醒');
 await page.getByRole('button',{name:'保存共用模板',exact:true}).click();await page.getByRole('alert').waitFor();
 assert.equal(await page.getByLabel('模板物品',{exact:true}).inputValue(),'更新后的模板物品');assert.equal(await page.getByLabel('注意事项',{exact:true}).inputValue(),'保留未保存的个人提醒');
 await page.getByRole('button',{name:'保存共用模板',exact:true}).click();await page.getByRole('status').filter({hasText:'共用模板已应用到当前旅程'}).waitFor();
 assert.equal(payload.currentTrip.packing.checkedIds[0],'base');assert.equal(payload.currentTrip.version,1);
 assert.equal(await page.locator('.check-item span').first().innerText(),'更新后的模板物品');assert.ok(await page.locator('.check-item input').first().isChecked());
 assert.equal(await page.getByLabel('注意事项',{exact:true}).inputValue(),'保留未保存的个人提醒');
 await page.reload();await page.getByRole('button',{name:'行李与提醒',exact:true}).click();assert.equal(await page.locator('.check-item span').first().innerText(),'更新后的模板物品');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 await page.getByRole('button',{name:'管理共用模板',exact:true}).click();await page.waitForTimeout(300);await page.getByLabel('模板物品',{exact:true}).focus();await page.screenshot({path:'.artifacts/packing-template-'+width+'.png',fullPage:true});
 await page.close();console.log('PASS packing template focus, conflict draft, current-trip apply and reload:',width);
}}finally{await browser.close();}
