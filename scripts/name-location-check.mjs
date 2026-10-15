import {chromium} from '@playwright/test';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';

process.env.LD_LIBRARY_PATH='/root/.cache/travel-browser-libs';
const url=process.env.TRAVEL_TEST_URL||'http://127.0.0.1:5190/';
const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const event=(id,kind,slot)=>({id,title:id,kind,slot,alternative:false,lat:50.1109,lng:8.6821,note:''});
const seed={id,name:'名称位置验收',destination:'德国',timezone:'Europe/Berlin',startDate:'2026-10-12',endDate:'2026-10-12',version:3,updatedAt:1,
 days:[{id:'day-a',date:'2026-10-12',city:'法兰克福',title:'类型与坐标',events:[event('旧观光','sight','morning'),event('旧步行','walk','afternoon'),{...event('跨城交通','train','transport'),to:{name:'终点',lat:49.4,lng:8.7}}]}],packing:{baseItems:[],baseNotes:'',extraItems:[],checkedIds:[],hiddenBaseIds:[],notes:''}};
const kinds=['nature','visit','shopping','activity'],labels=['自然','参观','逛街','活动'];
const results=[];mkdirSync('.artifacts',{recursive:true});
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
async function setup(width){
 const page=await browser.newPage({viewport:{width,height:width===375?667:width===390?844:900},isMobile:width<600,hasTouch:width<600});
 const state={trip:structuredClone(seed),saved:[],errors:[]};page.on('pageerror',e=>state.errors.push(e.message));
 await page.route('**/api/**',async r=>{const path=new URL(r.request().url()).pathname;let status=200,body;
  if(path==='/api/session')body={authenticated:true,username:'test',accountId:'test',role:'friend',csrfToken:'test'};
  else if(path==='/api/trips')body={trips:[state.trip]};
  else if(path==='/api/packing-template')body={items:[],notes:'',version:1};
  else if(path===`/api/trips/${id}`){if(r.request().method()==='PUT'){const saved=r.request().postDataJSON();state.saved.push(structuredClone(saved));state.trip={...state.trip,...saved,version:state.trip.version+1};}body=state.trip;}
  else if(path.includes('/weather/'))body={status:'past',city:'法兰克福'};
  else if(path.endsWith('/map-pack')){status=503;body={error:'测试不下载地图资源'};}
  else{status=404;body={error:'Unexpected '+path};state.errors.push(body.error);}
  await r.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.route('**/map-style.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({version:8,sources:{},layers:[{id:'bg',type:'background',paint:{'background-color':'#e7eee4'}}]})}));
 await page.goto(url);await page.locator('.journey').waitFor();return {page,state};
}
async function edit(page){await page.getByRole('button',{name:'编辑',exact:true}).click();await page.locator('.trip-editor').waitFor();}
async function open(page,title){const card=page.locator('.editor-event').filter({has:page.locator('.editor-event-heading strong').filter({hasText:title})});await card.locator('.editor-event-heading').click();await card.locator('.editor-event-fields').waitFor();return card;}
async function picker(page,location){await location.getByRole('button',{name:/地图选点/}).click();const modal=page.getByRole('dialog');await modal.locator('canvas').waitFor();return modal;}
async function setPoint(modal,lat,lng){await modal.getByRole('textbox',{name:'纬度',exact:true}).fill(lat);await modal.getByRole('textbox',{name:'经度',exact:true}).fill(lng);await modal.getByRole('button',{name:'定位',exact:true}).click();await modal.page().waitForFunction(()=>!document.querySelector('.picker-actions button').disabled);}
async function confirm(modal){await modal.getByRole('button',{name:'确认位置',exact:true}).click();await modal.waitFor({state:'hidden'});}
async function centered(modal){await modal.page().waitForFunction(()=>{const map=document.querySelector('.picker-map canvas').getBoundingClientRect(),pin=document.querySelector('.picker-map .maplibregl-marker')?.getBoundingClientRect();return pin&&Math.abs(pin.left+pin.width/2-map.left-map.width/2)<3&&Math.abs(pin.top+pin.height/2-map.top-map.height/2)<=pin.height/2;},null,{timeout:10000});}
async function osm(location,lat,lng){const link=location.getByRole('link',{name:/OpenStreetMap/});assert.equal(await link.count(),1);const href=new URL(await link.getAttribute('href'));assert.equal(href.hostname,'www.openstreetmap.org');assert.equal(Number(href.searchParams.get('mlat')),lat);assert.equal(Number(href.searchParams.get('mlon')),lng);assert.equal(await link.getAttribute('target'),'_blank');assert.match(await link.getAttribute('rel'),/noopener/);assert.match(await link.getAttribute('rel'),/noreferrer/);}
async function overflow(page,width){assert.ok(await page.locator('.trip-editor').evaluate(n=>n.scrollWidth<=n.clientWidth+1));assert.ok(await page.evaluate(()=>document.body.scrollWidth)<=width);}

try{for(const width of (process.argv.includes('--short-only')?[375]:[1366,390,375])){
 const {page,state}=await setup(width);
 try{
  assert.match(await page.title(),/旅途/);assert.equal(await page.getByRole('link',{name:'旅途首页'}).count(),1);assert.equal(await page.getByText('旅迹',{exact:true}).count(),0);
  const manifest=await (await page.request.get(new URL('manifest.webmanifest',url).href)).json();assert.equal(manifest.short_name,'旅途');assert.match(manifest.name,/旅途/);
  await edit(page);
  for(const [title,expected] of [['旧观光','visit'],['旧步行','activity']]){
   const card=await open(page,title),select=card.getByLabel('类型',{exact:true});assert.equal(await select.inputValue(),expected);assert.deepEqual(await select.locator('option').evaluateAll(ns=>ns.map(n=>n.value)),kinds);
   const backup=card.getByRole('checkbox',{name:/作为备选/});await backup.check();await backup.uncheck();
  }
  for(const slot of ['上午','下午'])for(let i=0;i<kinds.length;i++){
   await page.getByRole('button',{name:'＋ '+slot,exact:true}).click();const card=page.locator('.editor-event').last();await card.getByLabel('名称',{exact:true}).fill(slot+labels[i]);
   const select=card.getByLabel('类型',{exact:true});assert.deepEqual(await select.locator('option').allTextContents(),labels);await select.selectOption(kinds[i]);
   const location=card.locator('.editor-location');assert.equal(await location.locator('input').count(),0);const modal=await picker(page,location);await setPoint(modal,'50.11','8.68');await confirm(modal);
  }
  const legacy=await open(page,'旧观光'),location=legacy.locator('.editor-location');let modal=await picker(page,location);
  const latField=modal.getByRole('textbox',{name:'纬度',exact:true}),lngField=modal.getByRole('textbox',{name:'经度',exact:true}),confirmButton=modal.getByRole('button',{name:'确认位置',exact:true});
  for(const [lat,lng] of [['-33.8688','-151.2093'],['0','0'],['90','180'],['-90','-180']]){
   await setPoint(modal,lat,lng);assert.match(await modal.locator('.picker-actions span').textContent(),new RegExp(String(Number(lat))));assert.equal(await confirmButton.isEnabled(),true);
  }
  for(const invalid of ['90.1','-90.1','1e2','abc','']){
   await latField.fill(invalid);await latField.blur();assert.equal(await latField.getAttribute('aria-invalid'),'true');assert.match(await modal.locator('#picker-coordinate-hint').textContent(),/纬度/);await modal.getByRole('button',{name:'定位',exact:true}).click();assert.equal(await confirmButton.isDisabled(),true);assert.equal(await latField.inputValue(),invalid);assert.equal(state.saved.length,0);
  }
  await latField.fill('50.11');for(const invalid of ['180.1','-180.1','--1']){await lngField.fill(invalid);await lngField.blur();assert.equal(await lngField.getAttribute('aria-invalid'),'true');assert.match(await modal.locator('#picker-coordinate-hint').textContent(),/经度/);assert.equal(await confirmButton.isDisabled(),true);}
  // Position is only a candidate until the user checks the map and confirms.
  await setPoint(modal,'-33.86','151.20');await centered(modal);assert.equal(await location.getByRole('link').getAttribute('href'),`https://www.openstreetmap.org/?mlat=50.1109&mlon=8.6821#map=16/50.1109/8.6821`);
  if(width===375){
   const originalViewport=page.viewportSize();await page.setViewportSize({width,height:360});await page.waitForFunction(()=>{const r=document.querySelector('.picker-dialog').getBoundingClientRect();return r.top>=0&&r.bottom<=window.visualViewport.height+1;});
   assert.ok(await modal.evaluate(n=>n.scrollWidth<=n.clientWidth+1));const final=modal.getByRole('button',{name:'确认位置',exact:true});await final.scrollIntoViewIfNeeded();const bounds=await final.boundingBox();assert.ok(bounds.y>=0&&bounds.y+bounds.height<=360,'短视口无法到达确认按钮');await final.focus();await page.keyboard.press('Tab');assert.equal(await modal.getByRole('button',{name:'取消选点',exact:true}).evaluate(n=>n===document.activeElement),true);await page.keyboard.press('Shift+Tab');assert.equal(await final.evaluate(n=>n===document.activeElement),true);
   await page.setViewportSize(originalViewport);await centered(modal);
  }
  await page.screenshot({path:'.artifacts/name-location-picker-'+width+'.png'});await modal.getByRole('button',{name:'取消选点',exact:true}).click();await osm(location,50.1109,8.6821);
  modal=await picker(page,location);await setPoint(modal,'-33.86','151.20');await centered(modal);
  // Typing another valid point must not confirm the previously previewed marker.
  await modal.getByRole('textbox',{name:'经度',exact:true}).fill('151.21');assert.equal(await modal.getByRole('button',{name:'确认位置',exact:true}).isDisabled(),true);await modal.getByRole('textbox',{name:'经度',exact:true}).press('Enter');await centered(modal);
  await confirm(modal);await osm(location,-33.86,151.21);
  // Clicking the map remains available and refreshes both coordinate inputs.
  modal=await picker(page,location);const before=await modal.locator('.picker-actions span').textContent();await modal.locator('canvas').click({position:{x:100,y:100}});await page.waitForFunction(text=>document.querySelector('.picker-actions span').textContent!==text,before);const picked={lat:Number(await modal.getByRole('textbox',{name:'纬度',exact:true}).inputValue()),lng:Number(await modal.getByRole('textbox',{name:'经度',exact:true}).inputValue())};assert.notEqual(picked.lat,-33.86);await confirm(modal);await osm(location,picked.lat,picked.lng);
  const transport=await open(page,'跨城交通'),end=transport.locator('.editor-location').nth(1);modal=await picker(page,end);await setPoint(modal,'0','-180');await centered(modal);await confirm(modal);await osm(end,0,-180);
  await overflow(page,width);await page.screenshot({path:'.artifacts/name-location-editor-'+width+'.png'});
  await page.getByRole('button',{name:'保存旅程',exact:true}).click();await page.locator('.journey').waitFor();assert.equal(state.saved.length,1);
  const saved=state.saved[0],events=saved.days[0].events;assert.equal(saved.version,3);assert.equal(events.find(e=>e.id==='旧观光').kind,'sight');assert.equal(events.find(e=>e.id==='旧步行').kind,'walk');assert.deepEqual(events.find(e=>e.id==='跨城交通').to,{name:'终点',lat:0,lng:-180});assert.equal(events.find(e=>e.id==='旧观光').lat,picked.lat);
  for(const slot of ['上午','下午'])for(let i=0;i<kinds.length;i++){const e=events.find(e=>e.title===slot+labels[i]);assert.equal(e.kind,kinds[i]);assert.equal(await page.locator(`[data-event="${e.id}"]`).count(),1);assert.match(await page.locator(`[data-event="${e.id}"] .wish-label`).textContent(),new RegExp(labels[i]));}
  await page.reload();await page.locator('.journey').waitFor();await edit(page);const restored=await open(page,'跨城交通');const restoredModal=await picker(page,restored.locator('.editor-location').nth(1));assert.equal(await restoredModal.getByRole('textbox',{name:'纬度',exact:true}).inputValue(),'0');assert.equal(await restoredModal.getByRole('textbox',{name:'经度',exact:true}).inputValue(),'-180');await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'取消',exact:true}).click();await page.locator('.journey').waitFor();
  const downloadReady=page.waitForEvent('download');await page.getByRole('button',{name:'导出离线 HTML'}).click();const download=await downloadReady,html=readFileSync(await download.path(),'utf8');assert.match(html,/旅途 · 离线副本/);assert.ok(!html.includes('旅迹'));const offline=await browser.newPage({viewport:page.viewportSize()});await offline.route('https://**',r=>r.abort());await offline.setContent(html);await offline.locator('#day-content article').first().waitFor();
  for(const slot of ['上午','下午'])for(let i=0;i<kinds.length;i++){const e=events.find(e=>e.title===slot+labels[i]);assert.equal(await offline.locator(`article[data-id="${e.id}"]`).count(),1);assert.ok((await offline.locator(`article[data-id="${e.id}"]`).textContent()).includes(e.title));}
  const exported=await offline.locator('#trip-data').textContent();for(const k of kinds)assert.ok(exported.includes('"kind":"'+k+'"'));await offline.close();assert.deepEqual(state.errors,[]);results.push({width,branding:true,kinds:true,legacyPreserved:true,coordinateBoundaries:true,invalidConfirmBlocked:true,candidateOnly:true,flyToCentered:true,mapRefill:true,endpoint:true,saveReload:true,offline:true});console.log(JSON.stringify(results.at(-1)));
 }finally{await page.close();}
}}finally{await browser.close();writeFileSync(process.argv.includes('--short-only')?'.artifacts/picker-coordinates-short.json':'.artifacts/name-location-check.json',JSON.stringify({url,mapMock:true,results},null,2)+'\n');}
