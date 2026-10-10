import {chromium} from '@playwright/test';
import {existsSync,readFileSync,mkdirSync} from 'node:fs';
// Rasterize the existing vector brand; the opaque square lets iOS apply its own corner mask.
if(existsSync('/root/.cache/travel-browser-libs'))process.env.LD_LIBRARY_PATH='/root/.cache/travel-browser-libs'+(process.env.LD_LIBRARY_PATH?':'+process.env.LD_LIBRARY_PATH:'');
const executable='/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell';
const browser=await chromium.launch({...(existsSync(executable)?{executablePath:executable}:{}),args:['--no-sandbox']});
const svg=readFileSync(new URL('../public/brand.svg',import.meta.url),'utf8');
try{for(const [size,file] of [[16,'icons/favicon-16.png'],[32,'icons/favicon-32.png'],[180,'apple-touch-icon.png'],[192,'icons/icon-192.png'],[512,'icons/icon-512.png']]){
 const page=await browser.newPage({viewport:{width:size,height:size},deviceScaleFactor:1});
 await page.setContent(`<html><head><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:#f4f6ed}body{display:grid;place-items:center}svg{display:block;width:72%;height:72%}</style></head><body>${svg}</body></html>`);
 const target=new URL('../public/'+file,import.meta.url);mkdirSync(new URL('.',target),{recursive:true});await page.screenshot({path:target.pathname,omitBackground:false});await page.close();console.log('Generated '+file+' ('+size+'×'+size+')');
}}finally{await browser.close();}
