import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
process.env.LD_LIBRARY_PATH='/root/.cache/travel-browser-libs';
const browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const trip={id:'weather-test',name:'天气验收',destination:'德国',startDate:'2026-10-15',endDate:'2026-10-16',timezone:'Europe/Berlin',version:1,updatedAt:1,packing:{extraItems:[],checkedIds:[],hiddenBaseIds:[],notes:''},days:['慕尼黑','柏林'].map((city,i)=>({id:'day-'+i,date:'2026-10-'+(15+i),city,title:'天气卡片检查',events:[{id:'hotel-'+i,kind:'hotel',title:'老城区花园旅馆 · Garden Hotel',stayLabel:'住宿',lat:48,lng:11,note:''},{id:'train-'+i,kind:'train',title:'中央车站 → 老城火车站',lat:48,lng:11,time:'09:00',endTime:'10:30',note:''}]}))};
mkdirSync('.artifacts',{recursive:true});
const results=[];
try {
 for(const width of [1366,768,390,375]) {
  const page=await browser.newPage({viewport:{width,height:900},isMobile:width<600,hasTouch:width<600});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let status='ready',delay=false,stale=false;
  await page.route('**/api/**',async r=>{
   const path=new URL(r.request().url()).pathname;
   let body,code=200;
   if(path==='/api/session')body={authenticated:true,username:'test',accountId:'admin',role:'admin',csrfToken:'test'};
   else if(path==='/api/trips')body={trips:[trip]};
   else if(path==='/api/packing-template')body={items:[],notes:'',version:1};
   else if(path.includes('/weather/')){const first=path.endsWith('day-0');if(first&&delay)await new Promise(resolve=>setTimeout(resolve,200));if(status==='error'){code=503;body={error:'天气暂不可用'};}else body={status,city:first?'慕尼黑':'柏林',reference:'测试景点',code:first?3:61,low:first?12:6,high:first?19:14,precipitation:first?30:null,updatedAt:1792020000,stale};}
   else if(path.endsWith('/map-pack')){code=503;body={error:'无地图包'};}
   else body=trip;
   await r.fulfill({status:code,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.route('**/map-style.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({version:8,sources:{},layers:[{id:'bg',type:'background',paint:{'background-color':'#e7eee4'}}]})}));
  await page.goto(process.env.TRAVEL_TEST_URL||'http://127.0.0.1:5198/');
  const card=page.getByRole('group',{name:'当天天气'});
  await card.getByText('12–19°C').waitFor();
  assert.match(await card.innerText(),/阴/);assert.match(await card.innerText(),/降水 30%/);
  assert.equal(await card.locator('button,details').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const geometry=await page.locator('.ticket,.stay,.weather-card').evaluateAll(nodes=>nodes.map(n=>({class:n.className,height:n.getBoundingClientRect().height,right:n.getBoundingClientRect().right})));
  assert.ok(geometry.every(g=>g.right<=width+1));
  assert.equal(new Set(geometry.map(g=>Math.round(g.height))).size,1,'卡片高度需一致');
  await page.screenshot({path:`.artifacts/weather-${width}.png`});
  await page.getByRole('button',{name:'后一天',exact:true}).click();await card.getByText('6–14°C').waitFor();assert.match(await card.innerText(),/降水 暂无/);assert.doesNotMatch(await card.innerText(),/19/);
  status='future';await page.getByRole('button',{name:'前一天',exact:true}).click();await card.getByText('尚未进入预报期').waitFor();
  status='past';await page.getByRole('button',{name:'后一天',exact:true}).click();await card.getByText('已过预报日期').waitFor();
  status='no-location';await page.getByRole('button',{name:'前一天',exact:true}).click();await card.getByText('添加地点后显示天气').waitFor();
  status='error';await page.getByRole('button',{name:'后一天',exact:true}).click();await card.getByText('天气暂不可用').waitFor();
  status='ready';delay=true;await page.getByRole('button',{name:'前一天',exact:true}).click();await page.getByRole('button',{name:'后一天',exact:true}).click();await card.getByText('6–14°C').waitFor();await page.waitForTimeout(300);assert.match(await card.innerText(),/6–14°C/);
  trip.timezone='Foo/Bar';stale=true;delay=false;await page.reload();await card.getByText('12–19°C').waitFor();await card.getByText('· 缓存数据',{exact:false}).waitFor();assert.match(await card.getByText('· 缓存数据',{exact:false}).getAttribute('title'),/时间暂不可用/);trip.timezone='Europe/Berlin';
  assert.deepEqual(errors,[]);results.push({width,geometry,states:'ready/future/past/no-location/error/race/invalid-timezone passed'});await page.close();
 }
 writeFileSync('.artifacts/weather-check.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}finally{await browser.close();}
