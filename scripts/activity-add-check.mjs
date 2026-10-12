import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
process.env.LD_LIBRARY_PATH='/root/.cache/travel-browser-libs';
const url=process.env.TRAVEL_TEST_URL||'http://127.0.0.1:5190/',id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const existing=Array.from({length:14},(_,i)=>({id:'stop-'+i,title:'已有活动 '+i,slot:'afternoon',kind:'visit',alternative:false,lat:31.22,lng:121.46,note:'保留备注 '+i}));
const seed={id,name:'新增活动回归',destination:'中国',startDate:'2026-10-17',endDate:'2026-10-18',timezone:'Asia/Shanghai',days:[{id:'d1',date:'2026-10-17',city:'上海',title:'第一天',events:existing},{id:'d2',date:'2026-10-18',city:'上海',title:'第二天',events:[]}],packing:{extraItems:[],checkedIds:[],hiddenBaseIds:[],notes:''},version:1,updatedAt:1};
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
mkdirSync('.artifacts',{recursive:true});const results=[];
try{for(const [width,height,reduced] of [[1366,900,false],[390,844,false],[375,667,false],[375,667,true]]){
 const page=await browser.newPage({viewport:{width,height},isMobile:width<600,hasTouch:width<600,reducedMotion:reduced?'reduce':'no-preference'});let trip=structuredClone(seed),writes=0;const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.route('**/api/**',async route=>{const p=new URL(route.request().url()).pathname;let body,status=200;
   if(p==='/api/session')body={authenticated:true,username:'test',accountId:'test',role:'friend',csrfToken:'synthetic'};
   else if(p==='/api/trips')body={trips:[trip]};
   else if(p==='/api/trips/'+id&&route.request().method()==='PUT'){writes++;trip={...trip,...route.request().postDataJSON(),version:trip.version+1};body=trip;}
   else if(p==='/api/trips/'+id)body=trip;
   else if(p==='/api/packing-template')body={items:[],notes:'',version:1};
   else {status=503;body={error:'测试不提供地图包'};}
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.route('**/map-style.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({version:8,sources:{},layers:[{id:'bg',type:'background',paint:{'background-color':'#eee'}}]})}));
  await page.goto(url);await page.locator('.journey').waitFor();await page.getByRole('button',{name:'编辑',exact:true}).click();
  for(let n=0;n<2;n++){
   // The second add contracts the previous open form above the new card.
   await page.getByRole('button',{name:'＋ 下午',exact:true}).click();const card=page.locator('.editor-event').last(),heading=card.locator('.editor-event-heading');
   await page.waitForTimeout(380);const box=await heading.boundingBox();assert.ok(box.y>=0&&box.y+box.height<=height,JSON.stringify({width,n,box}));assert.ok(await heading.evaluate(el=>el===document.activeElement),'新活动没有获得焦点');
   assert.equal(await page.locator('.editor-event-heading[aria-expanded=true]').count(),1);await card.getByLabel('名称',{exact:true}).fill('新增 '+n);
   await card.getByRole('button',{name:/地图选点 · 活动位置/}).click();await page.getByLabel('纬度',{exact:true}).fill('31.22');await page.getByLabel('经度',{exact:true}).fill('121.46');await page.getByRole('button',{name:'定位',exact:true}).click();await page.getByRole('button',{name:'确认位置',exact:true}).click();
   assert.equal(await card.locator('.editor-map-link').count(),1);
  }
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.getByRole('button',{name:'保存旅程',exact:true}).click();await page.locator('.journey').waitFor();assert.equal(writes,1);assert.deepEqual(trip.days[0].events.slice(0,14),existing);assert.equal(trip.days[0].events.length,16);assert.equal(trip.days[1].events.length,0);
  await page.reload();await page.locator('.journey').waitFor();await page.getByRole('button',{name:'编辑',exact:true}).click();await page.locator('.editor-event').first().waitFor();assert.equal(await page.locator('.editor-event').count(),16);assert.deepEqual(errors,[]);results.push({width,height,reduced,focusedVisibleAdds:2,previousValuesPreserved:true,saveReload:true});
 }finally{await page.close();}
}}finally{await browser.close();writeFileSync('.artifacts/activity-add-check.json',JSON.stringify({url,apiMock:true,results},null,2));}
console.log(JSON.stringify(results));
