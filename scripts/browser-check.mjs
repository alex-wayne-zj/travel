import {chromium} from '@playwright/test';
import {mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const url=process.env.TRAVEL_TEST_URL||'http://127.0.0.1:5175/';
const days=JSON.parse(readFileSync('src/itinerary.json'));
mkdirSync('.artifacts',{recursive:true});
if(existsSync('/root/.cache/travel-browser-libs'))process.env.LD_LIBRARY_PATH='/root/.cache/travel-browser-libs'+(process.env.LD_LIBRARY_PATH?':'+process.env.LD_LIBRARY_PATH:'');
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:1366,height:768}});const errors=[],layouts=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url,{waitUntil:'domcontentloaded'});if(process.env.TRAVEL_TEST_PASSWORD_FILE){await page.locator('input[name=username]').fill('admin');await page.locator('input[name=password]').fill(readFileSync(process.env.TRAVEL_TEST_PASSWORD_FILE,'utf8').trim());await page.getByRole('button',{name:'进入我的旅途'}).click();await page.locator('.journey').waitFor();await page.getByRole('button',{name:'展开旅途列表'}).click();await page.locator('.history-list button').filter({hasText:'德国双人之旅'}).click();await page.locator('.history').getByRole('button',{name:'关闭旅途列表'}).click();}await page.waitForSelector('.map-pin',{timeout:60000});
 await page.emulateMedia({reducedMotion:'reduce'});assert.ok(await page.locator('.map-canvas').evaluate(e=>e.clientHeight)>0,'map canvas has real height after lazy CSS load');
 for(const viewport of [{width:1366,height:768},{width:390,height:844},{width:375,height:667}]){
  await page.setViewportSize(viewport);
  for(let i=0;i<days.length;i++){
   await page.locator('.days button').nth(i).click();
   assert.equal(await page.locator('.primary-wishes .wish-card').count(),4);
   assert.equal(await page.locator('.backup-card').count(),3);
   assert.equal(await page.locator('input[type=range]').count(),0);
   for(const e of days[i].events.filter(e=>e.slot==='transport')){
    const ticket=page.locator(`.ticket[data-event="${e.id}"]`);assert.ok((await ticket.innerText()).includes(e.time));
    assert.ok(await ticket.locator('.ticket-schedule strong').evaluate(e=>parseFloat(getComputedStyle(e).fontSize))>=18);
   }
   const longest=days[i].events.filter(e=>e.recommendation).sort((a,b)=>b.recommendation.length-a.recommendation.length)[0];
   await page.locator(`[data-event="${longest.id}"]`).click();assert.equal(await page.locator('.recommendation p').innerText(),longest.recommendation);
   const geometry=await page.evaluate(()=>({height:document.documentElement.scrollHeight,width:document.documentElement.scrollWidth,viewport:innerHeight,bottom:document.querySelector('.planner').getBoundingClientRect().bottom}));
   assert.ok(geometry.width<=viewport.width,JSON.stringify({i,viewport,geometry}));
   assert.ok(geometry.height<=viewport.height+1,JSON.stringify({i,viewport,geometry}));
   const controls=await page.locator('.primary-wishes .wish-card,.backup-card,.ticket,.stay,.recommendation').all();
   for(const c of controls){const box=await c.boundingBox();assert.ok(box.y>=0&&box.y+box.height<=viewport.height+1,'all day content fits screen');}
   layouts.push({day:i+1,...viewport,...geometry});
  }
  await page.locator('.days button').first().click();await page.screenshot({path:`.artifacts/compact-${viewport.width}x${viewport.height}.png`,fullPage:true});
 }
 await page.setViewportSize({width:1366,height:768});await page.locator('.days button').first().click();
 const before=await page.locator('.recommendation p').innerText();await page.locator('.primary-wishes .wish-card').nth(1).click();assert.notEqual(await page.locator('.recommendation p').innerText(),before);
 await page.locator('.backup-card').first().click();assert.equal(await page.locator('.backup-card').first().getAttribute('aria-pressed'),'true');assert.equal(await page.locator('.recommendation-title').count(),0);
 await page.locator('.primary-wishes .wish-card').nth(2).focus();await page.keyboard.press('Enter');assert.equal(await page.locator('.primary-wishes .wish-card').nth(2).getAttribute('aria-pressed'),'true');
 await page.locator('.days button').first().click();await page.getByRole('button',{name:'预览路线',exact:true}).click();
 assert.equal(await page.locator('.ticket').first().getAttribute('aria-pressed'),'true','preview includes early flight');
 await page.waitForTimeout(200);const transform=await page.locator('.vehicle').evaluate(e=>e.style.transform);await page.waitForTimeout(400);assert.notEqual(await page.locator('.vehicle').evaluate(e=>e.style.transform),transform);
 await page.getByRole('button',{name:'暂停路线预览'}).click();const paused=await page.locator('.vehicle').evaluate(e=>e.style.transform);await page.waitForTimeout(250);assert.equal(await page.locator('.vehicle').evaluate(e=>e.style.transform),paused);
 await page.getByRole('button',{name:'预览路线',exact:true}).click();await page.waitForTimeout(200);assert.equal(await page.locator('.ticket').first().getAttribute('aria-pressed'),'true','resume does not reset to a sightseeing stop');await page.getByRole('button',{name:'暂停路线预览'}).click();
 await page.getByRole('button',{name:'全程',exact:true}).click();assert.equal(await page.locator('.map-pin').count(),55);
 await page.setViewportSize({width:390,height:844});await page.locator('.days button').first().click();const rail=page.locator('.days');const box=await rail.boundingBox();await page.waitForTimeout(100);
 await page.mouse.move(box.x+250,box.y+20);await page.mouse.down();await page.mouse.move(box.x+40,box.y+20,{steps:8});await page.mouse.up();assert.ok(await rail.evaluate(e=>e.scrollLeft)>100,'day rail drags');
 await page.mouse.move(box.x+100,box.y+20);await page.mouse.down();await page.mouse.move(box.x+100,box.y-20);await page.mouse.up();const saved=await rail.evaluate(e=>e.scrollLeft);await page.mouse.move(box.x+200,box.y+20);assert.equal(await rail.evaluate(e=>e.scrollLeft),saved);
 await page.locator('.days button').nth(9).click();const selected=await page.locator('.days button').nth(9).boundingBox();assert.ok(selected.x>=box.x&&selected.x+selected.width<=box.x+box.width+1);
 assert.equal(await page.locator('.days button').first().evaluate(e=>getComputedStyle(e,'::after').width),'1px');
 await page.close();const failurePage=await browser.newPage();await failurePage.route('**/map-assets/**',r=>r.abort());await failurePage.route('**/map-packs/**',r=>r.abort());await failurePage.goto(url,{waitUntil:'domcontentloaded'});if(process.env.TRAVEL_TEST_PASSWORD_FILE){await failurePage.locator('input[name=password]').fill(readFileSync(process.env.TRAVEL_TEST_PASSWORD_FILE,'utf8').trim());await failurePage.getByRole('button',{name:'进入我的旅途'}).click();await failurePage.locator('.journey').waitFor();await failurePage.getByRole('button',{name:'展开旅途列表'}).click();await failurePage.locator('.history-list button').filter({hasText:'德国双人之旅'}).click();await failurePage.locator('.history').getByRole('button',{name:'关闭旅途列表'}).click();}await failurePage.waitForSelector('.error',{timeout:25000});assert.equal(await failurePage.locator('.primary-wishes .wish-card').count(),4);await failurePage.locator('.backup-card').first().click();assert.ok((await failurePage.locator('.recommendation-title').innerText()).includes('备选'));
 await failurePage.unroute('**/map-assets/**');await failurePage.unroute('**/map-packs/**');await failurePage.getByRole('button',{name:'重新加载地图'}).click();await failurePage.waitForSelector('.map-pin',{timeout:60000});
 assert.deepEqual(errors,[]);writeFileSync('.artifacts/compact-browser-result.json',JSON.stringify({url,passed:true,errors,layouts,checks:['10 days x 3 viewport sizes fit one screen','four primary slots plus three alternatives','prominent ticket times','recommendations follow sightseeing cuisine and backup selection','keyboard and map controls','early transport preview and pause resume','date separators and dragging','all primary stops on trip map','map failure and recovery']},null,2));console.log('Compact itinerary browser checks OK');
}finally{await browser.close();}
