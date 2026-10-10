import {chromium} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
process.env.LD_LIBRARY_PATH='/root/.cache/travel-browser-libs';
const url=process.env.TRAVEL_TEST_URL||'http://127.0.0.1:5190/';
const days=JSON.parse(readFileSync('src/itinerary.json','utf8'));
const sample=days[0].events.find(e=>e.kind==='sight');
const extra=(id,kind,slot,alternative=false)=>({...sample,id,title:id,kind,slot,alternative});
days[0].events.push(...Array.from({length:6},(_,i)=>extra('多景点'+i,'sight','morning')),...Array.from({length:5},(_,i)=>extra('多餐厅'+i,'food','lunch')),...Array.from({length:7},(_,i)=>extra('多备选'+i,'food','dinner',true)),extra('早餐主选','food','breakfast'),extra('旧早餐备选','food','breakfast',true),extra('无时段景点','sight',undefined),{...extra('历史备选无标记','sight','alternative'),alternative:undefined});
const base={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',name:'UI验收旅行',destination:'德国',startDate:'2026-10-12',endDate:'2026-10-21',timezone:'Europe/Berlin',days,version:1,updatedAt:1,packing:{extraItems:[],checkedIds:[],hiddenBaseIds:[],notes:''}};
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const results=[];
try{for(const width of [1366,1024,768,390,375]){
 const page=await browser.newPage({viewport:{width,height:width<600?844:900}}),errors=[];let trip=structuredClone(base),saved;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async r=>{const path=new URL(r.request().url()).pathname;let status=200,body;
 if(path==='/api/session')body={authenticated:true,username:'test',accountId:'test',role:'friend',csrfToken:'test'};
 else if(path==='/api/trips')body={trips:[trip]};else if(path==='/api/packing-template')body={items:[],notes:'',version:1};
 else if(path.endsWith('/map-pack')){status=503;body={error:'测试底图不可用'};}
 else if(path==='/api/trips/'+trip.id){if(r.request().method()==='PUT'){saved=r.request().postDataJSON();trip={...trip,...saved,version:trip.version+1};}body=trip;}
 else throw Error('Unexpected '+path);await r.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});});
 await page.route('**/map-style.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#e7eee4'}}]})}));
 await page.goto(url);await page.locator('.journey').waitFor();
 const primary=page.locator('.primary-wishes'),backup=page.locator('.backup-wishes');
 const expectedPrimary=trip.days[0].events.filter(e=>!(e.alternative??(e.slot==='alternative'))&&['sight','food','walk'].includes(e.kind)&&e.slot!=='transport');
 assert.equal(await primary.locator('[data-event]').count(),expectedPrimary.length);assert.equal(await backup.locator('[data-event]').count(),trip.days[0].events.filter(e=>e.alternative??(e.slot==='alternative')).length);
 for(const rail of [primary,backup]){const geometry=await rail.evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth,rows:new Set([...e.children].map(c=>Math.round(c.getBoundingClientRect().top))).size}));assert.ok(geometry.scroll>geometry.width);assert.equal(geometry.rows,1);await rail.evaluate(e=>e.scrollLeft=e.scrollWidth);await rail.locator('button').last().click();await page.waitForTimeout(100);assert.equal(await rail.locator('button').last().getAttribute('aria-pressed'),'true');}
 await page.screenshot({path:'.artifacts/ui-rails-'+width+'.png'});
 await page.getByRole('button',{name:'编辑',exact:true}).click();await page.getByLabel('旅程名称',{exact:true}).waitFor();
 const layout=()=>page.evaluate(()=>{const rect=q=>{const r=document.querySelector(q).getBoundingClientRect();return {x:r.x,right:r.right,y:r.y};};return {heading:rect('.editor-heading'),meta:rect('.editor-meta'),workspace:rect('.editor-workspace'),dates:[...document.querySelectorAll('.editor-meta .basics-dates .date-value')].map(e=>e.getBoundingClientRect().top),overflow:document.querySelector('.trip-editor').scrollWidth-document.querySelector('.trip-editor').clientWidth,body:document.body.scrollWidth};});
 let geometry=await layout();assert.ok(Math.abs(geometry.heading.x-geometry.meta.x)<1);assert.ok(Math.abs(geometry.heading.right-geometry.meta.right)<1);assert.ok(Math.abs(geometry.workspace.x-geometry.meta.x)<1);assert.equal(geometry.dates[0],geometry.dates[1]);assert.ok(geometry.overflow<=1);assert.ok(geometry.body<=width);
 await page.screenshot({path:'.artifacts/ui-editor-'+width+'.png'});
 if(width>900){await page.getByRole('button',{name:'展开旅途列表'}).click();await page.waitForTimeout(350);geometry=await layout();assert.ok(Math.abs(geometry.heading.x-geometry.meta.x)<1);assert.ok(Math.abs(geometry.heading.right-geometry.meta.right)<1);assert.ok(geometry.overflow<=1);await page.screenshot({path:'.artifacts/ui-editor-sidebar-'+width+'.png'});await page.locator('.history').getByRole('button',{name:'关闭旅途列表'}).click();await page.waitForTimeout(300);}
 await page.locator('.editor-dates button').nth(1).click();await page.locator('.editor-dates button').first().click();
 await page.getByRole('button',{name:'＋ 早餐',exact:true}).click();await page.getByLabel('名称',{exact:true}).fill('新早餐');const toggle=page.getByRole('checkbox',{name:/作为备选/});assert.equal(await toggle.isChecked(),false);
 assert.equal(await page.getByRole('button',{name:'＋ 备用',exact:true}).count(),0);assert.equal(await page.locator('select[aria-label="时段"] option[value="alternative"]').count(),0);
 await toggle.check();await page.getByLabel('时段',{exact:true}).selectOption('lunch');assert.equal(await toggle.isChecked(),true);await page.getByLabel('时段',{exact:true}).selectOption('breakfast');await toggle.uncheck();
 await page.getByRole('button',{name:/地图选点 · 活动位置/}).click();await page.locator('.picker-map canvas').waitFor();await page.waitForTimeout(250);await page.locator('.picker-map canvas').click({position:{x:100,y:100}});await page.getByRole('button',{name:'确认位置',exact:true}).click();
 await page.locator('.editor-event-heading').filter({hasText:'历史备选无标记'}).click();assert.equal(await toggle.isChecked(),true);await page.getByLabel('时段',{exact:true}).selectOption('afternoon');assert.equal(await toggle.isChecked(),true);await toggle.uncheck();
 await page.getByRole('button',{name:'保存旅程',exact:true}).click();await page.locator('.journey').waitFor();assert.equal(saved.days[0].events.find(e=>e.title==='新早餐').alternative,false);assert.equal(saved.days[0].events.find(e=>e.title==='历史备选无标记').slot,'afternoon');assert.equal(saved.days[0].events.find(e=>e.title==='旧早餐备选').alternative,true);assert.ok(await primary.getByRole('button',{name:/新早餐/}).count());assert.ok(await primary.getByRole('button',{name:/历史备选无标记/}).count());
 // Editing accepts another event in a slot that already contains many events.
 await page.getByRole('button',{name:'编辑',exact:true}).click();await page.getByRole('button',{name:'＋ 上午',exact:true}).click();await page.getByLabel('名称',{exact:true}).fill('新增同一时段');assert.equal(await page.locator('.editor-error').count(),0);await page.getByRole('button',{name:'取消',exact:true}).click();await page.getByRole('button',{name:'放弃修改并离开',exact:true}).click();await page.locator('.journey').waitFor();
 // A real HTML download still occurs, and the completion notice expires each time.
 for(let i=0;i<2;i++){const waiting=page.waitForEvent('download');await page.getByRole('button',{name:'导出离线 HTML'}).click();const file=await waiting;assert.ok(file.suggestedFilename().endsWith('.html'));await page.locator('.export-ready').waitFor();assert.equal(await page.getByRole('button',{name:'关闭下载提示'}).count(),0);await page.waitForTimeout(4300);assert.equal(await page.locator('.export-ready').count(),1);await page.waitForTimeout(1000);assert.equal(await page.locator('.export-ready').count(),0);}
 assert.deepEqual(errors,[]);results.push({width,geometry,primaryCount:expectedPrimary.length,rails:true,backupIndependent:true,legacyPreserved:true,noticeFiveSeconds:true,errors});await page.close();
}writeFileSync('.artifacts/ui-refinement-check.json',JSON.stringify({url,results},null,2));console.log(JSON.stringify({url,results}));}finally{await browser.close();}
