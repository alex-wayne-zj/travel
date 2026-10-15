import {chromium} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {gcjToWgs} from '../src/map-import.ts';
process.env.LD_LIBRARY_PATH='/root/.cache/travel-browser-libs';
const url=process.env.TRAVEL_TEST_URL||'http://127.0.0.1:5198/';
const short='https://surl.amap.com/2b7Uxlw1xf1y';
const apple='https://maps.apple.com/place?coordinate=31.239703,121.499718&name='+encodeURIComponent('东方明珠广播电视塔')+'&place-id=H2710I3F80D8C5B11FA';
const expanded='https://wb.amap.com/?p='+encodeURIComponent('B00150F6D6,31.23970343070824,121.49971783161163,东方明珠广播电视塔,世纪大道1号');
const initial={id:'import-test',name:'地图导入验收',destination:'中国',startDate:'2026-10-15',endDate:'2026-10-15',timezone:'Asia/Shanghai',version:1,updatedAt:1,days:[{id:'day',date:'2026-10-15',city:'上海',title:'城市漫游',events:[{id:'existing',title:'保留我的名称',kind:'visit',slot:'morning',lat:31.2,lng:121.4,note:'',sourceUrl:'https://example.com/keep'},{id:'train',title:'跨城交通',kind:'train',slot:'transport',lat:31.2,lng:121.4,note:'',to:{name:'',lat:31.1,lng:121.3}}]}],packing:{baseItems:[],extraItems:[],checkedIds:[],hiddenBaseIds:[],notes:''}};
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const results=[];mkdirSync('.artifacts',{recursive:true});
try{for(const width of [1366,390,375]){
 const page=await browser.newPage({viewport:{width,height:width===375?667:900},isMobile:width<600,hasTouch:width<600});let trip=structuredClone(initial),resolves=0,delay=0;const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.route('**/api/**',async r=>{const path=new URL(r.request().url()).pathname;let body,status=200;
  if(path==='/api/session')body={authenticated:true,accountId:'admin',username:'test',role:'admin',csrfToken:'test'};
  else if(path==='/api/trips')body={trips:[trip]};
  else if(path==='/api/packing-template')body={items:[],notes:'',version:1};
  else if(path==='/api/map-links/resolve'){resolves++;assert.equal(r.request().method(),'POST');assert.equal(r.request().headers()['x-csrf-token'],'test');if(delay)await new Promise(resolve=>setTimeout(resolve,delay));body={url:expanded};}
  else if(path.includes('/weather/'))body={status:'future',city:'上海'};
  else if(path.endsWith('/map-pack')){status=503;body={error:'测试不下载地图包'};}
  else if(path==='/api/trips/import-test'){if(r.request().method()==='PUT')trip={...trip,...r.request().postDataJSON(),version:trip.version+1};body=trip;}
  else{status=404;body={error:'unexpected route'};}
  await r.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.route('**/map-style.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({version:8,sources:{},layers:[{id:'bg',type:'background',paint:{'background-color':'#e7eee4'}}]})}));
 await page.goto(url);await page.locator('.journey').waitFor();await page.getByRole('button',{name:'编辑',exact:true}).click();await page.locator('.trip-editor').waitFor();
 let existing=page.locator('[data-event-id="existing"]');await existing.locator('.editor-event-heading').click();
  const openPicker=async(location)=>{await location.getByRole('button',{name:/地图选点/}).click();const modal=page.getByRole('dialog');await modal.locator('canvas').waitFor();assert.equal(await modal.getByRole('textbox',{name:'纬度',exact:true}).count(),0);await modal.getByRole('button',{name:'经纬度选点',exact:true}).click();return modal;};
 const paste=async(modal,text)=>{await page.evaluate(text=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:async()=>text}}),text);await modal.getByRole('button',{name:'粘贴导入链接',exact:true}).click();await modal.locator('.picker-import-status a').waitFor();};
 let modal=await openPicker(existing.locator('.editor-location'));await paste(modal,apple);
 assert.equal(resolves,0);assert.equal(await modal.getByRole('checkbox',{name:/校正国内地图偏移/}).isChecked(),true);
 const expected=gcjToWgs(31.239703,121.499718);
 assert.equal(Number(await modal.getByRole('textbox',{name:'纬度',exact:true}).inputValue()),expected.lat);
 assert.equal(Number(await modal.getByRole('textbox',{name:'经度',exact:true}).inputValue()),expected.lng);
 await modal.getByRole('checkbox',{name:/校正国内地图偏移/}).uncheck();assert.equal(Number(await modal.getByRole('textbox',{name:'纬度',exact:true}).inputValue()),31.239703);
 await modal.getByRole('checkbox',{name:/校正国内地图偏移/}).check();
 assert.equal(await modal.evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);
 await page.screenshot({path:`.artifacts/map-import-${width}.png`});
 await modal.getByRole('button',{name:'取消选点',exact:true}).click();
 assert.match(await existing.getByRole('link',{name:/OpenStreetMap/}).getAttribute('href'),/mlat=31.2&mlon=121.4/);
 modal=await openPicker(existing.locator('.editor-location'));await paste(modal,apple);await modal.getByRole('button',{name:'确认位置',exact:true}).click();
 assert.equal(await existing.getByLabel('名称',{exact:true}).inputValue(),'保留我的名称');assert.equal(await existing.getByLabel('参考链接',{exact:true}).inputValue(),'https://example.com/keep');
 await page.getByRole('button',{name:'＋ 下午',exact:true}).click();let added=page.locator('.editor-event').last();modal=await openPicker(added.locator('.editor-location'));await paste(modal,'东方明珠广播电视塔\n'+short);
 assert.equal(resolves,1);const amapLat=Number(await modal.getByRole('textbox',{name:'纬度',exact:true}).inputValue());assert.ok(Math.abs(amapLat-expected.lat)<.000002);
 await modal.getByRole('button',{name:'确认位置',exact:true}).click();assert.equal(await added.getByLabel('名称',{exact:true}).inputValue(),'东方明珠广播电视塔');assert.equal(await added.getByLabel('参考链接',{exact:true}).inputValue(),short);
 modal=await openPicker(added.locator('.editor-location'));await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:async()=>{throw Error('denied')}}}));await modal.getByRole('button',{name:'粘贴导入链接',exact:true}).click();await modal.getByLabel('从地图导入',{exact:true}).waitFor();await modal.getByLabel('从地图导入',{exact:true}).fill('https://maps.apple.com.evil.test/?ll=30,120&q=x');await modal.getByRole('button',{name:'读取链接',exact:true}).click();await modal.getByText('仅支持苹果地图和高德地图的官方地点链接。',{exact:true}).waitFor();assert.equal(await modal.getByRole('button',{name:'确认位置',exact:true}).isDisabled(),true);
 // Editing a coordinate returns to manual mode; a delayed short-link response cannot override it.
 delay=500;await modal.getByLabel('从地图导入',{exact:true}).fill(short);await modal.getByRole('button',{name:'读取链接',exact:true}).click();await modal.getByRole('textbox',{name:'纬度',exact:true}).fill('48.137');await modal.getByRole('textbox',{name:'经度',exact:true}).fill('11.575');await modal.getByRole('button',{name:'定位',exact:true}).click();await page.waitForTimeout(650);assert.equal(await modal.getByRole('textbox',{name:'纬度',exact:true}).inputValue(),'48.137');assert.equal(await modal.locator('.picker-import-status a').count(),0);
 if(width===375){await page.setViewportSize({width,height:360});await modal.getByRole('button',{name:'确认位置',exact:true}).scrollIntoViewIfNeeded();const box=await modal.getByRole('button',{name:'确认位置',exact:true}).boundingBox();assert.ok(box.y+box.height<=361);assert.equal(await modal.evaluate(n=>n.scrollWidth<=n.clientWidth+1),true);await page.setViewportSize({width,height:667});}
 await modal.getByRole('button',{name:'取消选点',exact:true}).click();
 const transport=page.locator('[data-event-id="train"]');await transport.locator('.editor-event-heading').click();const endName=transport.getByLabel('终点名称',{exact:true});await endName.focus();assert.equal(await endName.evaluate(n=>getComputedStyle(n).outlineOffset),'-2px');await transport.getByLabel('类型',{exact:true}).selectOption('bus');modal=await openPicker(transport.locator('.editor-location').nth(1));await paste(modal,apple);await modal.getByRole('button',{name:'确认位置',exact:true}).click();assert.equal(await transport.getByLabel('终点名称',{exact:true}).inputValue(),'东方明珠广播电视塔');
 await page.getByRole('button',{name:'保存旅程',exact:true}).click();await page.locator('.journey').waitFor();
 const saved=trip.days[0].events;assert.equal(saved.find(e=>e.id==='train').kind,'bus');assert.equal(saved.find(e=>e.id==='existing').title,'保留我的名称');assert.equal(saved.find(e=>e.title==='东方明珠广播电视塔').sourceUrl,short);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);results.push({width,apple:true,amap:true,correction:true,confirmOnly:true,preserveExisting:true,fillNewNameAndSource:true,race:true,mobileKeyboard:width===375});await page.close();
}}finally{await browser.close();writeFileSync('.artifacts/map-import-check.json',JSON.stringify(results,null,2));}
console.log(JSON.stringify(results,null,2));
