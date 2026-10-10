import {chromium} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
process.env.LD_LIBRARY_PATH='/root/.cache/travel-browser-libs';
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[],responses=[];
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text().slice(0,300));});
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',r=>{if(r.url().includes('/map-pack'))responses.push({path:new URL(r.url()).pathname,status:r.status()});});
 await page.goto((process.env.TRAVEL_TEST_URL||'http://127.0.0.1:5190/'));
 await page.locator('input[name=password]').fill(readFileSync(process.env.TRAVEL_TEST_PASSWORD_FILE||(()=>{throw Error('Set TRAVEL_TEST_PASSWORD_FILE to a private test credential file');})(),'utf8').trim());
 await page.getByRole('button',{name:'进入我的旅途',exact:true}).click();await page.locator('.journey').waitFor();
 const progressTimer=setInterval(async()=>{try{console.log(JSON.stringify({progress:await page.locator('.export-progress').allTextContents(),error:await page.locator('.app-error').allTextContents()}));}catch{}},10000);
 const download=page.waitForEvent('download',{timeout:230000}).catch(()=>null);
 await page.getByRole('button',{name:'导出离线 HTML',exact:true}).click();
 const file=await download;clearInterval(progressTimer);
 if(file){await file.saveAs('.artifacts/download-live.html');const html=readFileSync('.artifacts/download-live.html','utf8');assert.ok(html.includes('trip-data'));const off=await browser.newPage();await off.context().setOffline(true);await off.goto('file://'+process.cwd()+'/.artifacts/download-live.html');await off.locator('#map img').waitFor();assert.equal(await off.locator('#dates button').count(),11);for(let i=0;i<11;i++){await off.locator('#dates button').nth(i).click();assert.ok(await off.locator('#map img').evaluate(e=>e.complete&&e.naturalWidth===900));}await off.locator('#packing-toggle').click();await off.locator('#packing').waitFor();await off.close();console.log(JSON.stringify({download:true,bytes:html.length,mapCount:(html.match(/data:image\/png;base64,/g)||[]).length,responses,errors}));}
 else{console.log(JSON.stringify({download:false,error:await page.locator('.app-error').allTextContents(),responses,errors}));}
 writeFileSync('.artifacts/download-live-result.json',JSON.stringify({download:!!file,responses,errors},null,2));
}finally{await browser.close();}
