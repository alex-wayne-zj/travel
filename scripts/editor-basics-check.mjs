import {chromium} from '@playwright/test';import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import assert from 'node:assert/strict';
process.env.LD_LIBRARY_PATH='/root/.cache/travel-browser-libs';
const url=process.env.TRAVEL_TEST_URL||'http://127.0.0.1:5190/';
const fixture={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',name:'德国测试旅行',destination:'德国柏林',startDate:'2026-10-12',endDate:'2026-10-21',timezone:'Europe/Berlin',days:JSON.parse(readFileSync('src/itinerary.json','utf8')),version:1,updatedAt:1,packing:{extraItems:[],checkedIds:[],hiddenBaseIds:[],notes:''}};
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const results=[];mkdirSync('.artifacts',{recursive:true});
async function calendar(page,label,date){await page.getByRole('button',{name:label,exact:true}).click();await page.getByRole('gridcell',{name:date,exact:true}).click();}
try{for(const width of [1366,1024,768,390,375]){
 const height=width<600?844:900,page=await browser.newPage({viewport:{width,height},isMobile:width<600,hasTouch:width<600});await page.clock.setFixedTime(new Date('2026-10-09T12:00:00Z'));const errors=[];let trip=structuredClone(fixture),saved;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{
  const p=new URL(route.request().url()).pathname,method=route.request().method();let body,status=200;
  if(p==='/api/session')body={authenticated:true,username:'test',accountId:'test',role:'friend',csrfToken:'test'};
  else if(p==='/api/trips'&&method==='GET')body={trips:[trip]};
  else if(p==='/api/packing-template')body={items:[],notes:'',version:1};
  else if((p==='/api/trips'&&method==='POST')||(p==='/api/trips/'+trip.id&&method==='PUT')){saved=route.request().postDataJSON();trip={...trip,...saved,version:trip.version+1};body=trip;}
  else if(p==='/api/trips/'+trip.id)body=trip;
  else if(p.endsWith('/map-pack')){status=503;body={error:'测试地图未预备'};}
  else throw Error('Unexpected API '+p);
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.route('**/map-style.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({version:8,sources:{},layers:[{id:'bg',type:'background',paint:{'background-color':'#e7eee4'}}]})}));
 await page.goto(url);await page.locator('.journey').waitFor();
 // Opening an old free-text destination does not overwrite it or make the form dirty.
 await page.getByRole('button',{name:'编辑',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'其他国家',exact:true}).inputValue(),'德国柏林');await page.getByRole('button',{name:'取消',exact:true}).click();await page.locator('.journey').waitFor();assert.equal(await page.locator('.confirmation-card').count(),0);
 await page.getByRole('button',{name:'创建新旅途',exact:true}).click();await page.locator('.editor-meta').waitFor();const startBounds=await page.getByRole('button',{name:'开始日期',exact:true}).boundingBox(),endBounds=await page.getByRole('button',{name:'结束日期',exact:true}).boundingBox();assert.ok(Math.abs(startBounds.y-endBounds.y)<1);assert.equal(await page.locator('.timezone-field').count(),0);assert.equal(await page.locator('.date-field input').count(),0);
 let empty=await page.locator('.editor-start').boundingBox(),meta=await page.locator('.editor-meta').boundingBox();assert.ok(Math.abs(empty.x-meta.x)<1);assert.ok(Math.abs(empty.width-meta.width)<1);
 await page.screenshot({path:`.artifacts/editor-basics-empty-${width}.png`});
 await page.getByLabel('旅程名称',{exact:true}).fill('德法小旅行');await page.getByRole('button',{name:/目的地国家/}).click();if(width<600)assert.equal(await page.evaluate(()=>document.activeElement.tagName),'BUTTON');assert.deepEqual(await page.locator('.country-options label').allTextContents(),['中国','美国','日本','德国','韩国','法国','英国','加拿大','澳大利亚','新西兰','新加坡','马来西亚','印度尼西亚','瑞士','意大利','冰岛','西班牙','挪威']);await page.getByRole('checkbox',{name:'德国',exact:true}).check();await page.getByRole('checkbox',{name:'法国',exact:true}).check();await page.getByRole('button',{name:'完成',exact:true}).click();assert.equal(await page.getByRole('combobox',{name:'行程时区',exact:true}).inputValue(),'Etc/UTC');
 await page.getByRole('button',{name:'开始日期',exact:true}).click();assert.equal(await page.getByRole('dialog',{name:'开始日期日历'}).count(),1);assert.equal(await page.locator('.date-manual').count(),0);await page.getByRole('gridcell',{name:'2026-10-12',exact:true}).click();
 const before=await page.locator('.editor-start').boundingBox();await calendar(page,'结束日期','2026-10-11');assert.match(await page.locator('.date-field').nth(1).innerText(),/不能早于/);const after=await page.locator('.editor-start').boundingBox();assert.ok(Math.abs(before.y-after.y)<1,'validation must not shift subsequent content');
 await page.screenshot({path:`.artifacts/editor-basics-error-${width}.png`});
 await calendar(page,'结束日期','2026-10-16');assert.doesNotMatch(await page.locator('.date-field').nth(1).innerText(),/不能早于/);
await page.getByRole('combobox',{name:'行程时区',exact:true}).selectOption('Etc/GMT-8');assert.match(await page.locator('.timezone-help').innerText(),/GMT\+08:00/);
 assert.equal(await page.getByRole('button',{name:'当地时区',exact:true}).count(),0);
 await page.getByRole('button',{name:/目的地国家/}).click();await page.getByRole('checkbox',{name:'法国',exact:true}).uncheck();await page.getByRole('button',{name:'完成',exact:true}).click();assert.equal(await page.getByRole('combobox',{name:'行程时区',exact:true}).count(),0);assert.match(await page.getByLabel('绑定时区',{exact:true}).innerText(),/德国/);
 await page.getByRole('button',{name:/目的地国家/}).click();await page.getByRole('checkbox',{name:'法国',exact:true}).check();await page.getByRole('button',{name:'完成',exact:true}).click();await page.getByRole('combobox',{name:'行程时区',exact:true}).selectOption('Etc/GMT-8');
 await page.getByRole('button',{name:'应用',exact:true}).click();assert.equal(await page.locator('.editor-dates button').count(),5);assert.equal(await page.locator('.editor-start').count(),0);
 if(width>=768){await page.getByRole('button',{name:'展开旅途列表'}).click();await page.waitForTimeout(300);const h=await page.locator('.editor-heading').boundingBox(),m=await page.locator('.editor-meta').boundingBox();assert.ok(Math.abs(h.x-m.x)<1);await page.screenshot({path:`.artifacts/editor-basics-sidebar-${width}.png`});await page.locator('.history').getByRole('button',{name:'关闭旅途列表'}).click();}
 await page.screenshot({path:`.artifacts/editor-basics-ready-${width}.png`});
 // Secondary manual input still validates on leaving the field.
 await page.getByRole('button',{name:'开始日期',exact:true}).click();await page.getByRole('button',{name:'手动输入',exact:true}).click();await page.getByLabel('手动输入开始日期',{exact:true}).fill('2026-02-30');assert.equal(await page.getByLabel('手动输入开始日期',{exact:true}).inputValue(),'2026-02-30','manual fill lost before close');await page.getByRole('button',{name:'关闭日历',exact:true}).click();assert.match(await page.locator('.date-field').first().innerText(),/有效日期/);
 await page.getByRole('button',{name:'开始日期',exact:true}).click();await page.getByRole('gridcell',{name:'2026-10-12',exact:true}).click();
 await page.getByRole('button',{name:'保存旅程',exact:true}).click();await page.locator('.journey').waitFor();assert.equal(saved.destination,'德国、法国');assert.equal(saved.timezone,'Etc/GMT-8');assert.equal(saved.days.length,5);
 await page.getByRole('button',{name:'编辑',exact:true}).click();await page.getByRole('button',{name:/目的地国家/}).click();await page.getByRole('checkbox',{name:'其他国家',exact:true}).check();await page.getByRole('button',{name:'完成',exact:true}).click();await page.getByRole('textbox',{name:'其他国家',exact:true}).fill('泰国');assert.equal(await page.getByLabel('查找时区',{exact:true}).count(),0);await page.getByRole('combobox',{name:'行程时区',exact:true}).selectOption('Etc/GMT-7');
 await page.getByRole('button',{name:'开始日期',exact:true}).click();const bounds=await page.getByRole('dialog',{name:'开始日期日历'}).boundingBox();assert.ok(bounds.x>=15&&bounds.x+bounds.width<=width-15);assert.ok(bounds.y>=15&&bounds.y+bounds.height<=height-15);await page.keyboard.press('Escape');
 if(width===375){
  await page.getByRole('button',{name:'＋ 早餐',exact:true}).click();
  for(let attempt=0;attempt<2;attempt++){
   await page.locator('.workspace').evaluate(e=>{e.scrollTop=0;});await page.getByRole('button',{name:'保存旅程',exact:true}).click();
   await page.waitForFunction(()=>document.activeElement?.classList.contains('editor-status'));
   const status=await page.locator('.editor-status').boundingBox();assert.ok(status.y>=0&&status.y+status.height<=height+1,'repeated errors must remain visible');
  }
 }
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);results.push({width,legacyPreserved:true,calendarDefault:true,blurValidationStable:true,countries:true,zoneModes:true,save:true,other:true,errors});await page.close();
}}
finally{await browser.close()}
writeFileSync('.artifacts/editor-basics-check.json',JSON.stringify({url,results},null,2)+'\n');console.log(JSON.stringify({url,results}));
