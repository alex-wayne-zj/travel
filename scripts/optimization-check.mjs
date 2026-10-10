import {chromium} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
process.env.LD_LIBRARY_PATH='/root/.cache/travel-browser-libs';
const url=process.env.TRAVEL_TEST_URL||'http://127.0.0.1:5190/';
const base={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',name:'测试德国旅行',destination:'德国',startDate:'2026-10-12',endDate:'2026-10-21',timezone:'Europe/Berlin',days:JSON.parse(readFileSync('src/itinerary.json','utf8')),version:1,updatedAt:1,packing:{extraItems:[],checkedIds:[],hiddenBaseIds:[],notes:''}};
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const results=[];
try{for(const width of [375,390,1366]){
 const page=await browser.newPage({viewport:{width,height:width<600?844:768}}),errors=[];let trip=structuredClone(base),saved;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async r=>{const path=new URL(r.request().url()).pathname;let status=200,body;
 if(path==='/api/session')body={authenticated:true,username:'test',accountId:'test',role:'friend',csrfToken:'test'};
 else if(path==='/api/trips')body={trips:[trip]};else if(path==='/api/packing-template')body={items:[],notes:'',version:1};
 else if(path.endsWith('/map-pack')){status=503;body={error:'地图资源尚未准备完成，请稍后重试'};}
 else if(path==='/api/trips/'+trip.id){if(r.request().method()==='PUT'){saved=r.request().postDataJSON();trip={...trip,...saved,version:2};}body=trip;}
 else throw Error('Unexpected '+path);await r.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});});
 await page.route('**/map-assets/**',r=>r.abort());
 await page.route('**/map-style.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#e7eee4'}}]})}));
 await page.goto(url);await page.locator('.journey').waitFor();
 assert.equal(await page.locator('.history').evaluate(e=>e.inert),true);
 await page.getByRole('button',{name:'展开旅途列表'}).click();await page.waitForTimeout(300);assert.equal(await page.locator('.history').evaluate(e=>e.inert),false);
 await page.locator('.history').getByRole('button',{name:'关闭旅途列表'}).click();await page.waitForTimeout(50);assert.equal(await page.locator('.history').evaluate(e=>e.inert),true);await page.waitForTimeout(250);
 await page.getByRole('button',{name:'编辑',exact:true}).click();await page.getByLabel('旅程名称',{exact:true}).waitFor();
 const bounds=await page.evaluate(()=>({body:document.body.scrollWidth,editor:document.querySelector('.trip-editor').scrollWidth,client:document.querySelector('.trip-editor').clientWidth,workspace:document.querySelector('.workspace').clientWidth,scroll:getComputedStyle(document.querySelector('.trip-editor')).overflowY}));assert.ok(bounds.body<=width,JSON.stringify(bounds));assert.ok(bounds.editor<=bounds.client+1,JSON.stringify(bounds));assert.equal(bounds.scroll,'visible');
 await page.screenshot({path:'.artifacts/editor-top-'+width+'.png'});
 const enterDate=async value=>{await page.getByRole('button',{name:'开始日期',exact:true}).click();await page.getByRole('button',{name:'手动输入',exact:true}).click();await page.getByLabel('手动输入开始日期',{exact:true}).fill(value);await page.getByRole('button',{name:'关闭日历',exact:true}).click();};
 await enterDate('2026-12-12');assert.match(await page.locator('.timezone-help').innerText(),/GMT\+01:00/);await enterDate('2026-10-12');
 assert.equal(await page.getByRole('combobox',{name:'行程时区',exact:true}).count(),0);
 await page.getByRole('button',{name:/目的地国家/}).click();await page.getByRole('checkbox',{name:'日本',exact:true}).check();await page.getByRole('checkbox',{name:'德国',exact:true}).uncheck();await page.getByRole('button',{name:'完成',exact:true}).click();assert.match(await page.locator('.timezone-help').innerText(),/GMT\+09:00/);
 await page.getByRole('button',{name:/目的地国家/}).click();await page.getByRole('checkbox',{name:'德国',exact:true}).check();await page.getByRole('checkbox',{name:'日本',exact:true}).uncheck();await page.getByRole('button',{name:'完成',exact:true}).click();assert.match(await page.locator('.timezone-help').innerText(),/GMT\+02:00/);
 await page.getByRole('button',{name:'＋ 早餐',exact:true}).click();await page.getByLabel('名称',{exact:true}).fill('早餐咖啡馆');assert.equal(await page.getByLabel('类型',{exact:true}).inputValue(),'food');assert.equal(await page.getByLabel('纬度',{exact:true}).count(),0);assert.equal(await page.getByLabel('经度',{exact:true}).count(),0);await page.getByLabel('参考链接',{exact:true}).fill('https://example.com/travel-blog');
 await page.getByRole('button',{name:/地图选点 · 活动位置/}).click();await page.locator('.picker-map canvas').waitFor();await page.waitForTimeout(400);await page.locator('.picker-map canvas').click({position:{x:100,y:100}});await page.getByRole('button',{name:'确认位置',exact:true}).click();
 await page.screenshot({path:'.artifacts/editor-optimized-'+width+'.png'});
 await page.getByRole('button',{name:'保存旅程',exact:true}).click();await page.locator('.journey').waitFor();const breakfast=saved.days[0].events.find(e=>e.title==='早餐咖啡馆');assert.equal(breakfast.slot,'breakfast');assert.equal(breakfast.alternative,false);assert.ok(Number.isFinite(breakfast.lat));await page.getByRole('button',{name:/早餐.*早餐咖啡馆/}).waitFor();
 const wait=page.waitForEvent('download');await page.getByRole('button',{name:'导出离线 HTML'}).click();const download=await wait;const file='.artifacts/optimization-offline-'+width+'.html';await download.saveAs(file);await page.getByRole('link',{name:'保存离线文件'}).waitFor();assert.match(await page.locator('.export-ready').innerText(),/地图不完整/);assert.ok(readFileSync(file,'utf8').includes('早餐咖啡馆'));
 const offline=await browser.newPage();await offline.context().setOffline(true);await offline.goto('file://'+process.cwd()+'/'+file);assert.equal(await offline.locator('#dates button').count(),11);assert.match(await offline.locator('.notice').innerText(),/部分地图未载入/);await offline.locator('#dates button').nth(1).click();assert.ok(await offline.getByRole('heading',{name:'早餐咖啡馆'}).count());await offline.close();
 assert.deepEqual(errors,[]);results.push({width,bounds,sidebar:true,timezone:true,breakfast:true,mapPick:true,fallbackDownload:true,errors});await page.close();
}writeFileSync('.artifacts/optimization-check.json',JSON.stringify({url,results},null,2));console.log(JSON.stringify({url,results}));}finally{await browser.close();}
