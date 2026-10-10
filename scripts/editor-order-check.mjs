import {chromium} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';

process.env.LD_LIBRARY_PATH='/root/.cache/travel-browser-libs';
const url=process.env.TRAVEL_TEST_URL||'http://127.0.0.1:5190/';
const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const makeEvents=(prefix,count)=>Array.from({length:count},(_,i)=>({id:prefix+'-'+i,title:`${prefix} ${String(i+1).padStart(2,'0')} · ${i%5===0?'河畔历史老城与花园慢步 · Riverside Garden and Historic Town Centre':'旅途中的一站'}`,kind:i%2?'food':'sight',slot:i%2?'lunch':'morning',alternative:i%7===0,lat:50.11+i*.0001,lng:8.68,note:'备注保留 '+i,recommendation:'沿途慢慢走，给休息与用餐留一点时间。'}));
const seed={id,name:'活动排序验收',destination:'德国',startDate:'2026-10-12',endDate:'2026-10-13',timezone:'Europe/Berlin',version:3,updatedAt:100,
 days:[{id:'day-a',date:'2026-10-12',city:'法兰克福',title:'第一天',events:makeEvents('第一日',40)},{id:'day-b',date:'2026-10-13',city:'海德堡',title:'第二天',events:makeEvents('第二日',3)}],packing:{baseItems:[],baseNotes:'行李快照保留',extraItems:[],checkedIds:[],hiddenBaseIds:[],notes:'个人提醒保留'}};
const originalA=seed.days[0].events.map(e=>e.title),originalB=seed.days[1].events.map(e=>e.title);
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
mkdirSync('.artifacts',{recursive:true});
const results=[];
const inputSessions=new WeakMap();

async function setup(width,height,reducedMotion='no-preference'){
 const page=await browser.newPage({viewport:{width,height},isMobile:width<600,hasTouch:width<600,reducedMotion});
 const state={trip:structuredClone(seed),saved:[],errors:[]};page.on('pageerror',e=>state.errors.push(e.message));
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname,method=route.request().method();let status=200,body;
  if(path==='/api/session')body={authenticated:true,username:'order',accountId:'order',role:'friend',csrfToken:'test'};
  else if(path==='/api/trips')body={trips:[state.trip]};
  else if(path==='/api/packing-template')body={items:[],notes:'',version:1};
  else if(path==='/api/trips/'+id&&method==='PUT'){const payload=route.request().postDataJSON();state.saved.push(structuredClone(payload));body={...state.trip,...payload,version:state.trip.version+1,updatedAt:state.trip.updatedAt+1};state.trip=body;}
  else if(path==='/api/trips/'+id)body=state.trip;
  else if(path.endsWith('/map-pack')){status=503;body={error:'地图仅使用测试 mock'};}
  else{status=404;body={error:'未预期接口 '+path};state.errors.push(body.error);}
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.route('**/map-style.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({version:8,sources:{},layers:[{id:'bg',type:'background',paint:{'background-color':'#e7eee4'}}]})}));
 await page.goto(url);await page.locator('.journey').waitFor();await edit(page);return {page,state};
}
async function edit(page){await page.getByRole('button',{name:'编辑',exact:true}).click();await page.locator('.editor-event').first().waitFor();}
const articles=page=>page.locator('.editor-events .editor-event');
const heading=card=>card.locator('.editor-event-heading');
const handle=card=>card.getByRole('button',{name:/调整顺序|拖动|排序/});
async function order(page){return articles(page).locator('.editor-event-heading strong').allTextContents();}
async function expectOrder(page,expected){try{await page.waitForFunction(expected=>JSON.stringify([...document.querySelectorAll('.editor-events .editor-event-heading strong')].map(n=>n.textContent))===JSON.stringify(expected),expected,{timeout:5000});}catch(error){console.error(JSON.stringify({expected:expected.slice(0,6),actual:(await order(page)).slice(0,6),sorting:await page.locator('.editor-event.sorting').count()}));throw error;}}
async function closed(page){await page.waitForFunction(()=>![...document.querySelectorAll('.editor-event-heading')].some(n=>n.getAttribute('aria-expanded')==='true')&&!document.querySelector('.editor-event-fields'));}
async function screenshot(page,name){await page.screenshot({path:'.artifacts/editor-order-'+name+'.png'});}
async function visibleTargets(page,from,to){
 await articles(page).nth(from).scrollIntoViewIfNeeded();
 await articles(page).nth(from).evaluate(card=>{const scroller=card.closest('.workspace');scroller.scrollTop+=card.getBoundingClientRect().top-120;});
 await articles(page).nth(to).scrollIntoViewIfNeeded();
 const source=await handle(articles(page).nth(from)).boundingBox(),target=await articles(page).nth(to).boundingBox();
 assert.ok(source&&target);return {x:source.x+source.width/2,y:source.y+source.height/2,tx:source.x+source.width/2,ty:target.y+target.height-3};
}
async function mouseStart(page,from,to){const pos=await visibleTargets(page,from,to);await page.mouse.move(pos.x,pos.y);await page.mouse.down();await page.mouse.move(pos.tx,pos.ty,{steps:12});return pos;}
async function touch(page,type,points=[]){let session=inputSessions.get(page);if(!session){session=await page.context().newCDPSession(page);inputSessions.set(page,session);}await session.send('Input.dispatchTouchEvent',{type,touchPoints:points});}
async function touchStart(page,from,to){const pos=await visibleTargets(page,from,to);await touch(page,'touchStart',[{x:pos.x,y:pos.y}]);for(let i=1;i<=6;i++)await touch(page,'touchMove',[{x:pos.x,y:pos.y+(pos.ty-pos.y)*i/6}]);return pos;}
async function assertLift(page,pointer,isTouch=false){
 const layer=page.locator('.editor-drag-layer');await layer.waitFor();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const lifted=await layer.evaluate(n=>({inert:n.inert,hidden:n.getAttribute('aria-hidden'),y:n.getBoundingClientRect().top,handleY:n.querySelector('.editor-sort-handle').getBoundingClientRect().top+n.querySelector('.editor-sort-handle').getBoundingClientRect().height/2,shadow:getComputedStyle(n.querySelector('.editor-drag-card')).boxShadow}));
 assert.equal(lifted.inert,true);assert.equal(lifted.hidden,'true');assert.notEqual(lifted.shadow,'none');const move=async y=>isTouch?touch(page,'touchMove',[{x:pointer.tx,y}]):page.mouse.move(pointer.tx,y);
 await move(pointer.ty+12);await page.waitForFunction(y=>Math.abs(document.querySelector('.editor-drag-layer').getBoundingClientRect().top-y-12)<2,lifted.y,{timeout:2000});await move(pointer.ty);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await page.locator('.editor-events .sorting .editor-event-header').evaluate(n=>getComputedStyle(n).opacity),'0','没有显示原位占位');
}
function moved(values,from,to){const next=[...values],value=next.splice(from,1)[0];next.splice(to,0,value);return next;}
async function motionSample(page,index,open){
 return articles(page).nth(index).evaluate((card,open)=>new Promise(resolve=>{
  const heading=card.querySelector('.editor-event-heading'),frames=[];let start;
  function frame(time){if(start===undefined)start=time;frames.push({time:time-start,height:card.getBoundingClientRect().height,y:heading.getBoundingClientRect().top,scroll:document.querySelector('.workspace').scrollTop});if(time-start<380)requestAnimationFrame(frame);else resolve(frames);}
  frames.push({time:-1,height:card.getBoundingClientRect().height,y:heading.getBoundingClientRect().top,scroll:document.querySelector('.workspace').scrollTop});
  if((heading.getAttribute('aria-expanded')==='true')!==open)heading.click();requestAnimationFrame(frame);
 }),open);
}
function motionMetrics(frames){const heights=frames.map(f=>f.height),ys=frames.map(f=>f.y);return {first:heights[0],last:heights.at(-1),intermediate:heights.some(h=>h>Math.min(heights[0],heights.at(-1))+5&&h<Math.max(heights[0],heights.at(-1))-5),maxFrameJump:Math.max(...ys.slice(1).map((y,i)=>Math.abs(y-ys[i])),0),frameCount:frames.length};}

try{
 for(const [width,height] of (process.argv.includes('--reduced-only')?[]:[[1366,900],[390,844],[375,667]])){
  const {page,state}=await setup(width,height);const result={width,height};
  try{
   assert.equal(await articles(page).count(),40);await closed(page);assert.equal(await handle(articles(page).first()).count(),1);
   assert.ok(await page.locator('.workspace').evaluate(n=>n.scrollWidth<=n.clientWidth+1),'活动列表横向溢出');await screenshot(page,'collapsed-'+width);
   await articles(page).first().scrollIntoViewIfNeeded();const expanded=motionMetrics(await motionSample(page,0,true));
   assert.ok(expanded.last>expanded.first+200,'展开没有显示完整表单');assert.equal(expanded.intermediate,true,'展开没有中间高度，发生瞬跳');
   assert.equal(await handle(articles(page).first()).count(),0,'展开时排序把手仍可操作');
   await articles(page).first().getByRole('textbox',{name:'名称',exact:true}).focus();
   const closedFrames=motionMetrics(await motionSample(page,0,false));await closed(page);
   assert.equal(await heading(articles(page).first()).evaluate(n=>n===document.activeElement),true,'收起后焦点没有返回标题');assert.equal(closedFrames.intermediate,true,'收起没有中间高度');result.motion={expanded,collapsed:closedFrames};
   // A mixed-slot drag reorders the actual array instead of regrouping by slot.
   let expected=[...originalA];const pointer=await mouseStart(page,0,2);await assertLift(page,pointer);result.liftFollowsPointer=true;await screenshot(page,'mouse-drag-'+width);await page.mouse.up();expected=moved(expected,0,2);await expectOrder(page,expected);await page.waitForFunction(()=>!document.querySelector('.editor-drag-layer'));
   await handle(articles(page).nth(2)).focus();await page.keyboard.press('ArrowUp');expected=moved(expected,2,1);await expectOrder(page,expected);await page.keyboard.press('ArrowDown');expected=moved(expected,1,2);await expectOrder(page,expected);
   await handle(articles(page).first()).focus();await page.keyboard.press('ArrowUp');await expectOrder(page,expected);await page.keyboard.press('End');expected=moved(expected,0,39);await expectOrder(page,expected);await page.keyboard.press('Home');expected=moved(expected,39,0);await expectOrder(page,expected);result.keyboard=true;
   const beforeCancel=[...expected];await mouseStart(page,0,2);await page.keyboard.press('Escape');await page.mouse.up();await expectOrder(page,beforeCancel);result.escapeCancels=true;
   await touchStart(page,0,2);await touch(page,'touchCancel');await expectOrder(page,beforeCancel);result.pointerCancel=true;
   const touchPointer=await touchStart(page,0,2);await assertLift(page,touchPointer,true);await touch(page,'touchEnd');expected=moved(expected,0,2);await expectOrder(page,expected);result.touch=true;
   if(width<600){
    await handle(articles(page).first()).scrollIntoViewIfNeeded();const grip=await handle(articles(page).first()).boundingBox();const beforeScroll=await page.locator('.workspace').evaluate(n=>n.scrollTop);
    await touch(page,'touchStart',[{x:grip.x+grip.width/2,y:grip.y+grip.height/2}]);await touch(page,'touchMove',[{x:grip.x+grip.width/2,y:height-18}]);await page.waitForTimeout(650);
    const afterScroll=await page.locator('.workspace').evaluate(n=>n.scrollTop);assert.ok(afterScroll>beforeScroll+40,'触屏拖到下缘没有自动滚动');
    await touch(page,'touchCancel');await expectOrder(page,expected);result.edgeAutoScroll=Math.round(afterScroll-beforeScroll);
   }
   // Switching day while a pointer is down must cancel, never affect the new day.
   await mouseStart(page,0,2);await page.locator('.editor-dates button').nth(1).evaluate(n=>n.click());await page.mouse.up();await expectOrder(page,originalB);await page.locator('.editor-dates button').first().click();await expectOrder(page,expected);result.dayIsolation=true;
   // Close the final long form from near the scroll limit; record frame-by-frame clamp.
   const last=articles(page).last();await heading(last).click();await last.locator('.editor-event-fields').waitFor();await page.waitForTimeout(300);await page.locator('.workspace').evaluate(n=>{n.scrollTop=n.scrollHeight;});
   const bottomFrames=await motionSample(page,39,false);writeFileSync('.artifacts/editor-order-bottom-'+width+'.json',JSON.stringify(bottomFrames,null,2));const bottomClose=motionMetrics(bottomFrames);await closed(page);assert.ok(bottomClose.maxFrameJump<120,'页面底收起发生明显单帧跳变：'+JSON.stringify(bottomClose));result.bottomClose=bottomClose;
   await screenshot(page,'closed-bottom-'+width);
   await page.getByRole('button',{name:'保存旅程',exact:true}).click();await page.locator('.journey').waitFor();assert.equal(state.saved.length,1);assert.equal(state.saved[0].version,3);assert.deepEqual(state.saved[0].days[0].events.map(e=>e.title),expected);assert.deepEqual(state.saved[0].days[1].events,seed.days[1].events);assert.deepEqual(state.saved[0].packing,seed.packing);
   await page.reload();await page.locator('.journey').waitFor();await edit(page);await expectOrder(page,expected);result.saveReload=true;assert.deepEqual(state.errors,[]);results.push(result);console.log(JSON.stringify(result));
  }finally{await page.close();}
 }
 const reduced=await setup(375,667,'reduce');
 try{const card=articles(reduced.page).first();await card.scrollIntoViewIfNeeded();await heading(card).click();await reduced.page.waitForTimeout(35);assert.equal(await card.locator('.editor-event-fields').count(),1);await heading(card).click();await reduced.page.waitForTimeout(35);assert.equal(await card.locator('.editor-event-fields').count(),0,'减弱动画仍等待完整240ms');await reduced.page.locator('.editor-dates button').nth(1).click();await expectOrder(reduced.page,originalB);await mouseStart(reduced.page,0,2);await reduced.page.locator('.editor-add button').first().evaluate(n=>n.click());await reduced.page.mouse.up();await reduced.page.waitForFunction(()=>document.querySelectorAll('.editor-events .editor-event').length===4);assert.deepEqual((await order(reduced.page)).slice(0,3),originalB,'新增导致取消时旧活动顺序未恢复');const ids=await articles(reduced.page).evaluateAll(nodes=>nodes.map(n=>n.dataset.eventId));assert.equal(new Set(ids).size,4,'新增ID丢失或重复');assert.deepEqual(ids.slice(0,3),seed.days[1].events.map(e=>e.id));await heading(articles(reduced.page).last()).click();await closed(reduced.page);assert.equal(await articles(reduced.page).count(),4);assert.deepEqual(reduced.state.errors,[]);results.push({width:375,reducedMotion:true,addingCancelsAndPreservesNewId:true});}finally{await reduced.page.close();}
}finally{await browser.close();writeFileSync(process.argv.includes('--reduced-only')?'.artifacts/editor-order-extra.json':'.artifacts/editor-order-check.json',JSON.stringify({url,mapMock:true,results},null,2)+'\n');}
console.log('活动动画、鼠标/触屏/键盘排序、取消、保存与日期隔离验收完成');
