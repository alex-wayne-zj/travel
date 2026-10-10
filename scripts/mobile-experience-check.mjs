import {chromium} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';

process.env.LD_LIBRARY_PATH='/root/.cache/travel-browser-libs';
const url=process.env.TRAVEL_TEST_URL||'http://127.0.0.1:5190/';
const trip={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',name:'布局验收',destination:'德国',timezone:'Europe/Berlin',startDate:'2026-10-12',endDate:'2026-10-13',version:1,updatedAt:1,
 days:[{id:'day1',date:'2026-10-12',city:'柏林',title:'城市漫步',events:[{id:'stop1',title:'上午活动',kind:'visit',slot:'morning',lat:52.5,lng:13.4,note:'',recommendation:'沿河散步'}]},{id:'day2',date:'2026-10-13',city:'柏林',title:'第二天',events:[]}],
 packing:{baseItems:[{id:'item1',category:'日用',label:'雨伞'}],extraItems:[],baseNotes:'出发前检查证件',notes:'',checkedIds:[],hiddenBaseIds:[]}};
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
mkdirSync('.artifacts',{recursive:true});const results=[];
async function setup(width,reducedMotion='no-preference'){
 const context=await browser.newContext({viewport:{width,height:width===375?667:844},isMobile:width<600,hasTouch:width<600,reducedMotion}),page=await context.newPage(),state={loggedIn:false,errors:[]};
 page.on('pageerror',e=>state.errors.push(e.message));
 await page.route('**/api/**',async r=>{const path=new URL(r.request().url()).pathname;let body,status=200;
  if(path==='/api/session')body=state.loggedIn?{authenticated:true,username:'test',accountId:'admin',role:'admin',csrfToken:'test'}:{authenticated:false};
  else if(path==='/api/login'){state.loggedIn=true;body={authenticated:true,username:'test',accountId:'admin',role:'admin',csrfToken:'test'};}
  else if(path==='/api/trips')body={trips:[trip]};
  else if(path==='/api/trips/'+trip.id)body=trip;
  else if(path==='/api/packing-template')body={items:[{id:'template1',category:'日用',label:'纸巾'}],notes:'检查证件',version:1};
  else if(path==='/api/invites')body={invites:[{id:'friend1',name:'朋友甲',enabled:true,hasCode:true,version:1}]};
  else{status=503;body={error:'测试中不提供可选地图包'};}
  await r.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.route('**/map-style.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({version:8,sources:{},layers:[{id:'bg',type:'background',paint:{'background-color':'#e7eee4'}}]})}));
 await page.goto(url);return {page,context,state};
}
async function noOverflow(page){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.ok(await page.locator('.workspace').evaluate(n=>n.scrollWidth<=n.clientWidth+1));}
async function login(page){await page.locator('input[name=password]').fill('synthetic-password');await page.getByRole('button',{name:'进入我的旅途',exact:true}).click();await page.locator('.journey').waitFor();}
async function panelMotion(page,button,panel,reduced){
 await button.click();await panel.waitFor({state:'visible'});await page.waitForTimeout(300);
 const full=await panel.evaluate(n=>n.getBoundingClientRect().height);assert.ok(full>0);
 await button.click();assert.equal(await panel.evaluate(n=>n.inert&&n.getAttribute('aria-hidden')==='true'),true);
 if(!reduced){await page.waitForTimeout(70);const between=await panel.evaluate(n=>n.getBoundingClientRect().height);assert.ok(between>0&&between<full,'关闭没有中间高度：'+JSON.stringify({full,between}));}
 await page.waitForTimeout(300);assert.equal(await panel.isVisible(),false);
 await button.click();await page.waitForTimeout(35);await button.click();await button.click();await page.waitForTimeout(320);assert.equal(await panel.isVisible(),true,'快速重开被旧定时器关闭');
 await button.click();await page.waitForTimeout(300);return full;
}
try{
 for(const [width,reduced] of [[390,false],[375,false],[375,true]]){
  const {page,context,state}=await setup(width,reduced?'reduce':'no-preference');
  try{
   for(const name of ['username','password']){const input=page.locator('input[name='+name+']');await input.focus();assert.ok(await input.evaluate(n=>parseFloat(getComputedStyle(n).fontSize)>=16));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.equal(await page.evaluate(()=>visualViewport.scale),1);}
   assert.ok(!/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/.test(await page.locator('meta[name=viewport]').getAttribute('content')));await page.waitForTimeout(300);await page.screenshot({path:`.artifacts/mobile-login-${width}-${reduced}.png`});
   await login(page);await noOverflow(page);await page.waitForTimeout(300);await page.screenshot({path:`.artifacts/mobile-empty-${width}-${reduced}.png`});assert.equal(await page.locator('.maplibregl-ctrl-zoom-in,.maplibregl-ctrl-zoom-out').count(),0);
   for(const name of ['＋ 添加住宿','＋ 添加交通','＋ 添加备选'])assert.equal(await page.getByRole('button',{name:new RegExp(name.replace('＋','\\＋'))}).count(),1);
   const addBackup=page.locator('.backup-card.empty-slot strong');assert.equal(await addBackup.evaluate(n=>getComputedStyle(n).fontSize),'13px');await page.getByRole('button',{name:/添加住宿/}).click();await page.locator('.trip-editor').waitFor();await page.getByRole('button',{name:'取消',exact:true}).click();await page.locator('.journey').waitFor();
   await page.getByRole('button',{name:'行李与提醒',exact:true}).click();const adjust=page.getByRole('button',{name:'调整本次行李',exact:true}),manage=page.getByRole('button',{name:'管理共用模板',exact:true});
   const extraHeight=await panelMotion(page,adjust,page.locator('#packing-adjust-body'),reduced),templateHeight=await panelMotion(page,manage,page.locator('#packing-template-body'),reduced);
   await adjust.click();await page.getByRole('button',{name:'＋ 添加物品',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'补充物品',exact:true}).evaluate(n=>getComputedStyle(n).fontSize),'16px');await page.getByRole('textbox',{name:'补充物品',exact:true}).fill('验收雨具');await manage.click();await page.getByRole('button',{name:'＋ 添加模板物品',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'模板分类',exact:true}).last().inputValue(),'日用');await page.getByRole('textbox',{name:'模板物品',exact:true}).last().fill('验收用品');
   await page.getByRole('button',{name:'行程',exact:true}).click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'放弃修改并离开',exact:true}).click();await page.locator('.journey').waitFor();
   await page.getByRole('button',{name:'创建新旅途',exact:true}).click();await page.getByRole('button',{name:'开始日期',exact:true}).click();const calendar=page.getByRole('dialog',{name:'开始日期日历',exact:true});await calendar.waitFor();await page.getByRole('button',{name:'关闭日历',exact:true}).click();if(!reduced)assert.equal(await page.locator('.date-calendar').evaluate(n=>n.inert),true);await page.waitForTimeout(300);assert.equal(await page.locator('.date-calendar').count(),0);await noOverflow(page);
   assert.deepEqual(state.errors,[]);results.push({width,reduced,loginFont16:true,viewportScale:1,emptyActions:true,mapZoomButtons:false,extraHeight,templateHeight,motion:true,defaultCategory:'日用',calendarExit:true});
  }finally{await context.close();}
 }
}finally{await browser.close();writeFileSync('.artifacts/mobile-experience-check.json',JSON.stringify({url,apiMock:true,results},null,2)+'\n');}
console.log(JSON.stringify(results));
