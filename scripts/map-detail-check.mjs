import {chromium} from '@playwright/test';
import {writeFileSync,readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
process.env.LD_LIBRARY_PATH='/root/.cache/travel-browser-libs';
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}});const tiles=[];
 page.on('response',r=>{if(r.url().includes('.pbf')&&r.status()===200)tiles.push(r.url());});
 await page.goto(process.env.TRAVEL_TEST_URL||'http://127.0.0.1:5190/',{waitUntil:'domcontentloaded'});if(process.env.TRAVEL_TEST_PASSWORD_FILE){await page.locator('input[name=password]').fill(readFileSync(process.env.TRAVEL_TEST_PASSWORD_FILE,'utf8').trim());await page.getByRole('button',{name:'进入我的旅途'}).click();}await page.waitForSelector('.map-pin',{timeout:60000});
 await page.locator('.days button').nth(4).click();await page.locator('.primary-wishes .wish-card').first().click();
 await page.waitForTimeout(12000);assert.ok(tiles.length>0,'vector tiles loaded');assert.equal(await page.locator('.error').count(),0);
 await page.screenshot({path:'.artifacts/mobile-streets.png',fullPage:true});
 await page.setViewportSize({width:844,height:390});await page.waitForTimeout(1800);
 const pin=await page.locator('.map-pin.selected').boundingBox(),map=await page.locator('.map-stage').boundingBox();assert.ok(pin.x>map.x&&pin.x+pin.width<map.x+map.width&&pin.y>map.y&&pin.y+pin.height<map.y+map.height,'selected location remains inside map after orientation change');
 await page.setViewportSize({width:390,height:844});page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'编辑',exact:true}).click();await page.locator('.editor-event-heading').first().click();const original=await page.getByLabel('纬度',{exact:true}).inputValue();await page.getByRole('button',{name:'地图选点 · 活动位置',exact:true}).first().click();const picker=page.locator('.picker-map .maplibregl-canvas');await picker.waitFor();const box=await picker.boundingBox();await picker.click({position:{x:box.width*.6,y:box.height*.55}});await page.getByRole('button',{name:'确认位置',exact:true}).click();assert.notEqual(await page.getByLabel('纬度',{exact:true}).inputValue(),original);assert.ok(Number.isFinite(Number(await page.getByLabel('纬度',{exact:true}).inputValue())));await page.getByRole('button',{name:'取消',exact:true}).click();await page.locator('.journey').waitFor();
 writeFileSync('.artifacts/map-detail-result.json',JSON.stringify({passed:true,tiles:tiles.length,checks:['mobile detailed streets','automatic fit after orientation change','map point confirmation updates draft without saving production data']},null,2));console.log('Map detail checks OK');
}finally{await browser.close();}
