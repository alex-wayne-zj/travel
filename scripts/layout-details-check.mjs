import {chromium} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';

process.env.LD_LIBRARY_PATH='/root/.cache/travel-browser-libs';
const url=process.env.TRAVEL_TEST_URL||'http://127.0.0.1:5190/';
const sizes=[[1366,900],[768,900],[390,844],[375,667]];
const ids={a:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',b:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'};
const categories=['证件随身','衣物','电子设备','洗漱用品'];
const ordinary=[['护照','证件随身'],['钱包','证件随身'],['外套','衣物'],['手机','电子设备'],['牙刷','洗漱用品']].map(([label,category],i)=>({id:'base-'+i,label,category}));
const stress=Array.from({length:15},(_,i)=>({id:'stress-'+i,label:['护照','身份证','钱包','机票','薄外套','长裤','短袖','袜子','手机','充电器','转换插头','耳机','牙刷','牙膏','小毛巾'][i],category:categories[Math.floor(i/4)]}));
const event=(id,kind,slot,title)=>({id,kind,slot,title,alternative:false,lat:50.11,lng:8.68,note:'测试日程备注'});
function fixture(key,pressure=false){
 const transport={...event('transport-'+key,'train','transport','法兰克福中央火车站 → 罗滕堡陶伯河畔历史古城车站'),time:'07:00',endTime:'08:15'};
 const stay={...event('stay-'+key,'hotel','stay','罗滕堡陶伯河畔老城区花园旅馆 · Riverside Garden Hotel'),stayLabel:'10/12–13 · 1晚'};
 return {id:ids[key],name:key==='a'?'德法慢旅行':'海边小旅行',destination:'德国',startDate:'2026-10-12',endDate:'2026-10-12',timezone:'Europe/Berlin',version:key==='a'?3:7,updatedAt:key==='a'?200:100,
  days:[{id:'day-'+key,date:'2026-10-12',city:'法兰克福',title:'老城与河畔慢步',events:key==='a'?[transport,stay]:[stay]}],
  packing:{baseItems:structuredClone(pressure==='long'?Array.from({length:48},(_,i)=>({id:'long-'+i,label:'旅行物品 '+(i+1),category:categories[i%4]})):pressure?stress:ordinary),baseNotes:key==='a'?'出发前核对证件，查看天气与交通。':'海边注意防晒与潮汐。',extraItems:[{id:key+'-extra-1',label:key==='a'?'历史转换插头':'防水袋',category:'电子设备'},{id:key+'-extra-2',label:'备用袜',category:'衣物'}],checkedIds:key==='a'?[]:[(pressure?stress:ordinary)[0].id],hiddenBaseIds:[],notes:key==='a'?'A 的个人提醒':'B 的个人提醒'}};
}
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
mkdirSync('.artifacts',{recursive:true});
const results=[];

async function setup(width,height,pressure=false){
 const page=await browser.newPage({viewport:{width,height},isMobile:width<600,hasTouch:width<600});
 const trips=new Map(['a','b'].map(key=>[ids[key],fixture(key,pressure)]));
 const template={items:[{id:'template-only',label:'模板独有物品',category:'新模板'}],notes:'模板的新提醒不会覆盖已有旅行。',version:8};
 const state={trips,successful:[],attempts:[],failNext:false,errors:[]};
 page.on('pageerror',e=>state.errors.push(e.message));
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname,method=route.request().method();let status=200,body;
  if(path==='/api/session')body={authenticated:true,username:'layout',accountId:'layout',role:'friend',csrfToken:'test'};
  else if(path==='/api/trips'&&method==='GET')body={trips:[...trips.values()]};
  else if(path==='/api/packing-template'&&method==='GET')body=template;
  else if(path.endsWith('/map-pack')){status=503;body={error:'测试仅检查布局，底图使用 mock'};}
  else if(path.startsWith('/api/trips/')&&trips.has(path.slice('/api/trips/'.length))){
   const id=path.slice('/api/trips/'.length);
   if(method==='PUT'){
    const payload=route.request().postDataJSON();state.attempts.push({id,payload:structuredClone(payload)});
    if(state.failNext){state.failNext=false;status=500;body={error:'模拟保存失败，请保留草稿'};}
    else{const previous=trips.get(id);body={...previous,...payload,version:previous.version+1,updatedAt:previous.updatedAt+1};trips.set(id,body);state.successful.push({id,payload:structuredClone(payload)});}
   }else body=trips.get(id);
  }else{status=404;body={error:'未预期测试接口 '+method+' '+path};state.errors.push(body.error);}
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.route('**/map-style.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#e7eee4'}}]})}));
 await page.goto(url);await page.locator('.journey').waitFor();
 return {page,state};
}
async function selectTrip(page,name){
 const trigger=page.getByRole('button',{name:'展开旅途列表',exact:true});
 if(await trigger.getAttribute('aria-expanded')!=='true')await trigger.click();
 await page.locator('.history-list button').filter({hasText:name}).click();
 await page.locator('.journey').waitFor();
 if(await trigger.getAttribute('aria-expanded')==='true')await page.locator('.history').getByRole('button',{name:'关闭旅途列表',exact:true}).click();
}
async function packing(page){await page.getByRole('button',{name:'行李与提醒',exact:true}).click();await page.locator('.packing-overview').waitFor();}
async function noOverflow(page){
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'页面横向溢出');
 const clipped=await page.locator('.ticket,.stay,.packing-card,.packing-reminders').evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().right>innerWidth+1||n.getBoundingClientRect().left< -1).map(n=>n.className));
 assert.deepEqual(clipped,[],'内容卡被视口截断');
}
async function screen(page,name){await page.screenshot({path:'.artifacts/layout-details-'+name+'.png'});}
async function packingFit(page,height){
 const rect=await page.locator('.packing-container').boundingBox();
 const geometry=await page.evaluate(()=>{
  const n=document.querySelector('.workspace'),shell=document.querySelector('.app-shell'),packing=document.querySelector('.packing-page');
  return {scrollPixels:Math.max(0,n.scrollHeight-n.clientHeight),workspaceHeight:n.clientHeight,shellHeight:shell.clientHeight,documentScrollPixels:document.documentElement.scrollHeight-innerHeight,packingScrollPixels:packing.scrollHeight-packing.clientHeight,packingOverflow:getComputedStyle(packing).overflowY};
 });
 return {oneScreen:rect.y+rect.height<=height+1,bottom:Math.round(rect.y+rect.height),viewport:height,...geometry};
}
async function savePacking(page){await page.getByRole('button',{name:'保存清单',exact:true}).click();await page.getByRole('status').filter({hasText:/^已保存$/}).waitFor();}

try{
 for(const [width,height] of sizes){
  const {page,state}=await setup(width,height);const result={width,height};
  try{
   const ticket=await page.locator('.ticket').boundingBox(),row=await page.locator('.travel-stay').boundingBox();
   if(width>=600){assert.ok(ticket.width<=395,'桌面交通卡过宽');assert.ok(ticket.width<row.width-10,'交通卡撑满整行');}
   await noOverflow(page);await screen(page,'transport-'+width);result.transport={width:Math.round(ticket.width),height:Math.round(ticket.height)};
   await packing(page);
   assert.equal(await page.locator('.check-item').count(),7);assert.equal(await page.getByText('模板独有物品',{exact:true}).count(),0);
   assert.equal(await page.getByRole('button',{name:'调整本次行李',exact:true}).evaluate(n=>n.getAttribute('aria-expanded')==='true'),false);assert.equal(await page.getByRole('button',{name:'管理共用模板',exact:true}).evaluate(n=>n.getAttribute('aria-expanded')==='true'),false);
   assert.equal(await page.getByText('这次旅行，多带一点',{exact:true}).count(),0);
   result.ordinary=await packingFit(page,height);assert.equal(result.ordinary.oneScreen,true,'常见7项清单与简短提醒未在一屏展示');
   await noOverflow(page);await screen(page,'packing-7-'+width);
   await page.getByRole('checkbox',{name:'历史转换插头',exact:true}).check();
   await page.getByRole('textbox',{name:'注意事项',exact:true}).fill('A 私有提醒更新');
   await page.getByRole('button',{name:'调整本次行李',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'补充物品',exact:true}).count(),2);await page.getByRole('button',{name:'调整本次行李',exact:true}).click();
   await page.getByRole('button',{name:'管理共用模板',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'模板物品',exact:true}).inputValue(),'模板独有物品');await page.getByRole('button',{name:'管理共用模板',exact:true}).click();
   const before=structuredClone(state.trips.get(ids.a));await savePacking(page);
   const captured=state.successful.at(-1);assert.equal(captured.id,ids.a);assert.equal(captured.payload.version,before.version);
   assert.deepEqual(captured.payload.packing.baseItems,before.packing.baseItems);assert.equal(captured.payload.packing.baseNotes,before.packing.baseNotes);assert.deepEqual(captured.payload.packing.extraItems,before.packing.extraItems);assert.ok(captured.payload.packing.checkedIds.includes('a-extra-1'));
   assert.equal(captured.payload.packing.notes,'A 私有提醒更新');
   await selectTrip(page,'海边小旅行');
   const stay=await page.locator('.stay').boundingBox();assert.ok(stay.width<=245,'单住宿卡过宽');assert.ok(stay.height>=76,'单住宿卡过矮');
   await noOverflow(page);await screen(page,'single-stay-'+width);result.stay={width:Math.round(stay.width),height:Math.round(stay.height)};
   await packing(page);assert.equal(await page.getByRole('textbox',{name:'注意事项',exact:true}).inputValue(),'B 的个人提醒');assert.equal(await page.getByRole('checkbox',{name:'防水袋',exact:true}).isChecked(),false);assert.equal(await page.getByRole('checkbox',{name:'护照',exact:true}).isChecked(),true);
   await selectTrip(page,'德法慢旅行');await packing(page);assert.equal(await page.getByRole('checkbox',{name:'历史转换插头',exact:true}).isChecked(),true);assert.equal(await page.getByRole('textbox',{name:'注意事项',exact:true}).inputValue(),'A 私有提醒更新');
   state.failNext=true;await page.getByRole('textbox',{name:'注意事项',exact:true}).fill('失败后仍保留的草稿');await page.getByRole('button',{name:'保存清单',exact:true}).click();await page.getByRole('alert').filter({hasText:'模拟保存失败'}).waitFor();
   assert.equal(await page.getByRole('status').filter({hasText:/^已保存$/}).count(),0,'保存失败仍显示成功');assert.equal(await page.getByRole('textbox',{name:'注意事项',exact:true}).inputValue(),'失败后仍保留的草稿');assert.equal(state.trips.get(ids.a).packing.notes,'A 私有提醒更新');
   const failureAlert=await page.getByRole('alert').filter({hasText:'模拟保存失败'}).boundingBox();assert.ok(failureAlert.y>=0&&failureAlert.y+failureAlert.height<=height,'保存错误未在视口内显示');
   assert.equal(await page.getByRole('alert').filter({hasText:'模拟保存失败'}).evaluate(n=>n===document.activeElement),true,'保存错误未获得焦点');
   await savePacking(page);assert.equal(state.trips.get(ids.a).packing.notes,'失败后仍保留的草稿');result.dataIsolation=true;result.saveFailureRetainsDraft=true;result.savedVersion=true;assert.deepEqual(state.errors,[]);
  }finally{await page.close();}
  const stressRun=await setup(width,height,true);
  try{await packing(stressRun.page);assert.equal(await stressRun.page.locator('.check-item').count(),17);assert.equal(await stressRun.page.locator('.packing-card').count(),4);await noOverflow(stressRun.page);result.pressure=await packingFit(stressRun.page,height);await screen(stressRun.page,'packing-17-'+width);assert.equal(result.pressure.oneScreen,true,'17项短提醒未在一屏展示：'+JSON.stringify(result.pressure));assert.deepEqual(stressRun.state.errors,[]);}finally{await stressRun.page.close();}
  if(width===375){
   const longRun=await setup(width,height,'long');
   try{
    await packing(longRun.page);assert.equal(await longRun.page.locator('.check-item').count(),50);result.long=await packingFit(longRun.page,height);assert.ok(result.long.scrollPixels>0,'极长清单不能在workspace正常滚动');
    await longRun.page.locator('.workspace').evaluate(n=>{n.scrollTop=n.scrollHeight;});
    const footer=await longRun.page.getByRole('button',{name:'管理共用模板',exact:true}).boundingBox();assert.ok(footer.y>=0&&footer.y+footer.height<=height,'长清单底部被裁切');
    await noOverflow(longRun.page);await screen(longRun.page,'packing-50-bottom-'+width);result.long.bottomReachable=true;
   }finally{await longRun.page.close();}
  }
  results.push(result);console.log(JSON.stringify(result));
 }
}finally{await browser.close();writeFileSync('.artifacts/layout-details-check.json',JSON.stringify({url,mapMock:true,results},null,2)+'\n');}
console.log('Journey/Packing 布局、隔离与保存故障验收完成');
