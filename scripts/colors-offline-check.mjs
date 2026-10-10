import {chromium} from '@playwright/test';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';

process.env.LD_LIBRARY_PATH='/root/.cache/travel-browser-libs';
const url=process.env.TRAVEL_TEST_URL||'http://127.0.0.1:5190/';
const ids=['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'];
const items=Array.from({length:17},(_,i)=>({id:'item-'+i,label:'行李'+(i+1),category:['证件','衣物','洗漱','电子'][i%4]}));
const event=(id,kind,slot,alternative=false)=>({id,title:id,kind,slot,alternative,lat:50.1,lng:8.6,note:id+'备注',recommendation:id+'说明',sourceUrl:'https://example.com/blog',time:'09:00',endTime:'10:00'});
const fixture=(id,index)=>({id,name:'旅行'+index,destination:'德国',timezone:'Europe/Berlin',startDate:'2026-10-12',endDate:'2026-10-13',version:3,updatedAt:1,
 days:[{id:'day-a',date:'2026-10-12',city:'法兰克福',title:'沿河漫步',events:[event('自然主选','nature','morning'),...['breakfast','lunch','dinner'].flatMap((slot,i)=>[event(['早餐','中餐','晚餐'][i],'food',slot),event(['早餐','中餐','晚餐'][i]+'备选','food',slot,true)]),{...event('住宿信息','hotel','stay'),stayLabel:'已预订',fullName:'河畔旅馆全名',address:'主街1号',checkInDate:'2026-10-12',checkOutDate:'2026-10-14',nights:2},{...event('火车信息','train','transport'),to:{name:'海德堡终点',lat:49.4,lng:8.7}}]},{id:'day-b',date:'2026-10-13',city:'海德堡',title:'公园与集市',events:[event('第二日活动','activity','afternoon'),event('第二日备选','shopping','afternoon',true)]}],
 packing:{baseItems:structuredClone(items),baseNotes:'检查证件。',extraItems:[],checkedIds:[],hiddenBaseIds:[],notes:'旅行'+index+'注意事项'}});
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
mkdirSync('.artifacts',{recursive:true});const results=[];
async function setup(width){
 const context=await browser.newContext({viewport:{width,height:width===375?667:width===390?844:900},isMobile:width<600,hasTouch:width<600,reducedMotion:'reduce'}),page=await context.newPage();
 const state={trips:new Map(ids.map((id,i)=>[id,fixture(id,i+1)])),template:{items:[{id:'shared',label:'模板物品',category:'模板分类'}],notes:'模板原提醒',version:8},tripPuts:[],templatePuts:[],deletes:[],forbidden:[],errors:[]};page.on('pageerror',e=>state.errors.push(e.message));
 await page.route('**/api/**',async r=>{const path=new URL(r.request().url()).pathname,method=r.request().method();let body,status=200;
  if(path==='/api/session')body={authenticated:true,username:'test',accountId:'test',role:'friend',csrfToken:'test'};
  else if(path==='/api/trips')body={trips:[...state.trips.values()]};
  else if(path==='/api/packing-template'){if(method==='PUT'){const payload=r.request().postDataJSON();state.templatePuts.push(structuredClone(payload));state.template={...payload,version:state.template.version+1};}body=state.template;}
  else if(path.endsWith('/map-pack')&&method==='GET'){status=503;body={error:'测试底图使用mock'};}
  else if(path.endsWith('/map-pack')||path.includes('/map-packs/')){state.forbidden.push(method+' '+path);status=503;body={error:'导出不得请求地图'};}
  else if(state.trips.has(path.slice('/api/trips/'.length))){const id=path.slice('/api/trips/'.length);if(method==='PUT'){const payload=r.request().postDataJSON();state.tripPuts.push({id,payload:structuredClone(payload)});state.trips.set(id,{...state.trips.get(id),...payload,version:state.trips.get(id).version+1});}if(method==='DELETE')state.deletes.push(id);body=state.trips.get(id);}
  else{status=404;body={error:'Unexpected '+method+' '+path};state.errors.push(body.error);}
  await r.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.route('**/map-packs/**',r=>{state.forbidden.push(r.request().method()+' '+new URL(r.request().url()).pathname);return r.abort();});
 await page.route('**/map-style.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({version:8,sources:{},layers:[{id:'bg',type:'background',paint:{'background-color':'#e7eee4'}}]})}));
 await page.goto(url);await page.locator('.journey').waitFor();return {page,context,state};
}
const wish=(page,title)=>page.locator('.wish-card').filter({has:page.locator('strong').filter({hasText:new RegExp('^'+title+'$')})});
async function color(locator){return locator.evaluate(n=>({background:getComputedStyle(n).backgroundColor,text:getComputedStyle(n).color,border:getComputedStyle(n).borderTopColor}));}
async function selected(locator){const c=await color(locator);assert.equal(c.background,'rgb(23, 62, 66)');assert.equal(c.text,'rgb(255, 255, 255)');for(const n of await locator.locator('small,span,strong,svg').all()){assert.equal(await n.evaluate(e=>getComputedStyle(e).color),'rgb(255, 255, 255)','选中子元素仍使用旧色');}}
async function selectTrip(page,name){const menu=page.getByRole('button',{name:'展开旅途列表',exact:true});if(await menu.getAttribute('aria-expanded')!=='true')await menu.click();await page.locator('.history-list button').filter({hasText:name}).click();await page.locator('.journey').waitFor();}

try{for(const width of [1366,390,375]){
 const {page,context,state}=await setup(width);
 try{
  const mealColors=[];for(const title of ['早餐','中餐','晚餐']){const main=await color(wish(page,title)),backup=await color(wish(page,title+'备选'));assert.equal(main.background,backup.background);assert.notEqual(main.background,'rgb(255, 255, 255)');mealColors.push(main.background);}
  const stay=page.locator('.stay'),stayColor=await color(stay);assert.equal(new Set([...mealColors,stayColor.background]).size,4,'三餐/住宿浅色未区分');
  for(const title of ['早餐','中餐','晚餐','早餐备选']){const card=wish(page,title);await card.click();await selected(card);}await stay.click();await selected(stay);await page.locator('.ticket').click();await selected(page.locator('.ticket'));
  await page.screenshot({path:'.artifacts/colors-journey-'+width+'.png'});
  await page.getByRole('button',{name:'行李与提醒',exact:true}).click();await page.locator('.packing-page').waitFor();assert.equal(await page.getByRole('textbox',{name:'注意事项',exact:true}).count(),1);assert.equal(await page.getByText('个人提醒',{exact:true}).count(),0);
  const adjust=page.getByRole('button',{name:'调整本次行李',exact:true}),manage=page.getByRole('button',{name:'管理共用模板',exact:true});assert.equal(await adjust.count(),1);assert.equal(await manage.count(),1);
  const overview=await page.locator('.packing-container').evaluate(n=>({bottom:n.getBoundingClientRect().bottom,workspaceScroll:n.closest('.workspace').scrollHeight-n.closest('.workspace').clientHeight}));if(width===375)assert.ok(overview.bottom<=667+1,'17项短屏按钮未接近一屏：'+JSON.stringify(overview));assert.ok(await page.locator('.workspace').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
  await page.screenshot({path:'.artifacts/colors-packing-'+width+'.png'});
  await adjust.click();await page.getByRole('button',{name:'＋ 添加物品',exact:true}).click();await page.getByRole('textbox',{name:'补充物品',exact:true}).last().fill('特殊雨具');await page.getByRole('textbox',{name:'注意事项',exact:true}).fill('雨天防滑注意事项');await manage.click();await page.getByRole('textbox',{name:'共用提醒',exact:true}).fill('新旅程模板注意事项');
  await page.getByRole('button',{name:'保存共用模板',exact:true}).click();await page.locator('.packing-feedback[role=status]').filter({hasText:'共用模板已保存'}).waitFor();assert.equal(state.templatePuts.length,1);assert.equal(state.tripPuts.length,0,'保存模板误保存本次草稿');assert.equal(state.trips.get(ids[0]).packing.notes,'旅行1注意事项');
  await page.getByRole('button',{name:'行程',exact:true}).click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'继续编辑',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'注意事项',exact:true}).inputValue(),'雨天防滑注意事项');
  await page.getByRole('button',{name:'保存清单',exact:true}).click();await page.getByText('已保存',{exact:true}).waitFor();assert.equal(state.tripPuts.length,1);assert.equal(state.templatePuts.length,1);assert.equal(state.trips.get(ids[0]).packing.extraItems[0].label,'特殊雨具');assert.deepEqual(state.trips.get(ids[0]).packing.baseItems,items);assert.equal(state.trips.get(ids[0]).packing.baseNotes,'检查证件。');
  await page.getByRole('button',{name:'行程',exact:true}).click();await page.locator('.journey').waitFor();await selectTrip(page,'旅行2');await page.getByRole('button',{name:'行李与提醒',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'注意事项',exact:true}).inputValue(),'旅行2注意事项');assert.equal(await page.getByText('特殊雨具',{exact:true}).count(),0);await page.getByRole('button',{name:'行程',exact:true}).click();await selectTrip(page,'旅行1');
  await page.getByRole('button',{name:'编辑',exact:true}).click();const remove=page.getByRole('button',{name:'删除这趟旅途',exact:true}),red=await color(remove);assert.equal(red.text,'rgb(255, 255, 255)');const rgb=red.background.match(/\d+/g).map(Number);assert.ok(rgb[0]>rgb[1]*1.5&&rgb[0]>rgb[2]*1.5,'删除按钮非红底');await remove.click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'继续编辑',exact:true}).click();assert.equal(state.deletes.length,0);await page.getByRole('button',{name:'取消',exact:true}).click();await page.locator('.journey').waitFor();
  const waiting=page.waitForEvent('download');await page.getByRole('button',{name:'导出离线 HTML',exact:true}).click();const download=await waiting,path=resolve('.artifacts/colors-offline-'+width+'.html');await download.saveAs(path);const html=readFileSync(path,'utf8');assert.ok(Buffer.byteLength(html)<150*1024,'离线文件仍过大');assert.deepEqual(state.forbidden,[]);assert.ok(!html.includes('正在展开离线地图')&&!html.includes('部分地图未载入'));
  const offlineContext=await browser.newContext({viewport:{width,height:width===375?667:844}}),offline=await offlineContext.newPage(),requests=[];offline.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});await offline.route('https://**',r=>r.abort());await offline.route('http://**',r=>r.abort());await offline.goto(pathToFileURL(path).href);await offline.locator('#day-content article').first().waitFor();assert.equal(await offline.locator('#map,.map,#coverage').count(),0);assert.equal(await offline.getByRole('button',{name:'定位',exact:true}).count(),0);
  const trip=state.trips.get(ids[0]);assert.deepEqual(await offline.locator('#day-content article h3').allTextContents(),trip.days[0].events.map(e=>e.title));await offline.getByRole('button',{name:'全程',exact:true}).click();assert.deepEqual(await offline.locator('#day-content article h3').allTextContents(),trip.days.flatMap(d=>d.events.map(e=>e.title)));for(const e of trip.days.flatMap(d=>d.events)){const card=offline.locator(`article[data-id="${e.id}"]`),text=await card.textContent();assert.ok(text.includes(e.note)&&text.includes(e.recommendation)&&text.includes(e.time)&&text.includes(e.endTime));assert.equal(await card.getByRole('link',{name:/参考链接/}).getAttribute('href'),e.sourceUrl);if(e.alternative)assert.ok(text.includes('备选'));}
  const lodging=await offline.locator('article[data-id="住宿信息"]').textContent();for(const text of ['河畔旅馆全名','主街1号','已预订','2026-10-12','2026-10-14','2 晚'])assert.ok(lodging.includes(text));assert.ok((await offline.locator('article[data-id="火车信息"]').textContent()).includes('海德堡终点'));
  await offline.locator('#dates button').nth(2).click();assert.deepEqual(await offline.locator('#day-content article h3').allTextContents(),trip.days[1].events.map(e=>e.title));await offline.getByRole('button',{name:'全程',exact:true}).click();assert.equal(await offline.locator('#day-content article').count(),11);
  await offline.getByRole('button',{name:'行李与提醒',exact:true}).click();assert.equal(await offline.locator('#trip-notes').textContent(),'雨天防滑注意事项');const checkbox=offline.getByRole('checkbox').first();await checkbox.check();await offline.reload();await offline.getByRole('button',{name:'行李与提醒',exact:true}).click();assert.equal(await offline.getByRole('checkbox').first().isChecked(),true,'离线勾选未保留');assert.deepEqual(requests,[]);await offlineContext.close();assert.deepEqual(state.errors,[]);results.push({width,mealColors,stayColor:stayColor.background,selected:true,packingOverview:overview,packingIsolation:true,deleteCancel:true,offlineBytes:Buffer.byteLength(html),offlineNoMap:true,offlineLocalChecks:true});console.log(JSON.stringify(results.at(-1)));
 }finally{await context.close();}
}}finally{await browser.close();writeFileSync('.artifacts/colors-offline-check.json',JSON.stringify({url,mapMock:true,results},null,2)+'\n');}
