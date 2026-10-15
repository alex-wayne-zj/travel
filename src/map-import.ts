export interface PickDetails {name:string;address:string;url:string}
export type LocationPick=(lat:number,lng:number,onConfirm:(lat:number,lng:number,details?:PickDetails)=>void)=>void;
export interface ImportedPoint {lat:number;lng:number;name:string;address:string;url:string;provider:'apple'|'amap';corrected:boolean;canCorrect:boolean}
const hosts=new Set(['maps.apple.com','maps.apple','surl.amap.com','uri.amap.com','www.amap.com','amap.com','m.amap.com','wb.amap.com']);
export function mapLinkURL(text:string):URL {
 if(text.length>8192)throw Error('分享内容过长，请只粘贴地点链接。');
 const links=text.match(/https?:\/\/[^\s<>"“”]+/gi)||[];
 if(links.length!==1)throw Error('请粘贴一个苹果地图或高德地图地点链接。');
 let url:URL;
 try{url=new URL(links[0].replace(/[。，；！）》」』]+$/u,''));}catch{throw Error('地图链接格式不正确。');}
 if(!hosts.has(url.hostname)||url.username||url.password||url.port||!['http:','https:'].includes(url.protocol))throw Error('仅支持苹果地图和高德地图的官方地点链接。');
 url.protocol='https:';
 if(url.href.length>4096)throw Error('地点链接过长，请重新复制分享链接。');
 return url;
}
const metadata=(text:string,max:number)=>Array.from(text.replace(/[\u0000-\u001f\u007f-\u009f]/g,'').trim()).slice(0,max).join('');
const number=(s:string)=>/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s.trim())?Number(s):NaN;
function pair(value:string,reverse=false):{lat:number;lng:number} {
 const parts=value.split(',');
 if(parts.length!==2)throw Error('链接中包含多个地点或无效坐标，请分享单个地点。');
 const a=number(parts[0]),b=number(parts[1]);const lat=reverse?b:a,lng=reverse?a:b;
 if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)throw Error('地点经纬度无效，请重新分享或手动选点。');
 return {lat,lng};
}
// This only gates the optional correction control, not a country/border determination.
export const correctionArea=(lat:number,lng:number)=>lat>=0.8293&&lat<=55.8271&&lng>=72.004&&lng<=137.8347;
function offset(lat:number,lng:number):{lat:number;lng:number} {
 const x=lng-105,y=lat-35,pi=Math.PI;
 let a=-100+2*x+3*y+.2*y*y+.1*x*y+.2*Math.sqrt(Math.abs(x));
 a+=(20*Math.sin(6*x*pi)+20*Math.sin(2*x*pi))*2/3;
 a+=(20*Math.sin(y*pi)+40*Math.sin(y*pi/3))*2/3;
 a+=(160*Math.sin(y*pi/12)+320*Math.sin(y*pi/30))*2/3;
 let b=300+x+2*y+.1*x*x+.1*x*y+.1*Math.sqrt(Math.abs(x));
 b+=(20*Math.sin(6*x*pi)+20*Math.sin(2*x*pi))*2/3;
 b+=(20*Math.sin(x*pi)+40*Math.sin(x*pi/3))*2/3;
 b+=(150*Math.sin(x*pi/12)+300*Math.sin(x*pi/30))*2/3;
 const rad=lat*pi/180,sin=Math.sin(rad),magic=1-.006693421622965943*sin*sin,sqrt=Math.sqrt(magic);
 return {lat:a*180/((6378245*(1-.006693421622965943))/(magic*sqrt)*pi),lng:b*180/(6378245/sqrt*Math.cos(rad)*pi)};
}
export function gcjToWgs(lat:number,lng:number):{lat:number;lng:number} {
 if(!correctionArea(lat,lng))return {lat,lng};
 let a=lat,b=lng;
 for(let i=0;i<8;i++){const delta=offset(a,b),dy=a+delta.lat-lat,dx=b+delta.lng-lng;a-=dy;b-=dx;if(Math.abs(dy)+Math.abs(dx)<1e-9)break;}
 return {lat:Number(a.toFixed(6)),lng:Number(b.toFixed(6))};
}
export function parseMapPoint(text:string):ImportedPoint|null {
 const url=mapLinkURL(text),p=url.searchParams,apple=url.hostname.startsWith('maps.apple');
 // Duplicate fields have ambiguous precedence across map applications; reject them.
 for(const key of ['coordinate','position','ll','lat','lon','lng','markers','p'])if(p.getAll(key).length>1)throw Error('链接中存在重复位置参数，请重新分享单个地点。');
 let point:{lat:number;lng:number}|undefined;
 let corrected=false;
 let address=p.get('address')||'';
 let name=p.get('name')||p.get('q')||p.get('poiname')||'';
 if(apple){
  if(['/frame','/search','/directions','/look-around'].includes(url.pathname)||p.has('saddr')||p.has('daddr')||p.has('sll'))throw Error('这是地图视野、搜索或路线链接，请分享具体地点。');
  if(p.has('coordinate')&&['/place','/',''].includes(url.pathname))point=pair(p.get('coordinate')!);
  else if(p.has('ll')&&(p.has('q')||p.has('name')||p.has('auid')||p.has('address')))point=pair(p.get('ll')!);
  // Verified mainland H-place share links carry AMap coordinates; other Apple links remain unshifted.
  corrected=/^H[A-Z0-9]+$/i.test(p.get('place-id')||'');
 }else{
  if(/(?:direction|navigation|route)/i.test(url.pathname))throw Error('请分享具体地点，暂不导入导航路线。');
  if(url.hostname==='wb.amap.com'&&p.has('p')){
   const parts=p.get('p')!.split(',');
   if(parts.length<4||!/^B[A-Z0-9]+$/i.test(parts[0]))throw Error('高德地点分享信息不完整，请重新分享。');
   point=pair(`${parts[1]},${parts[2]}`);name=parts[3];address=parts.slice(4).join(',');
  }else if(p.has('position'))point=pair(p.get('position')!,true);
  else if(p.has('markers')){
   const marker=p.get('markers')!;if(marker.includes('|'))throw Error('请一次导入一个地点。');
   const parts=marker.split(',');if(parts.length<2)throw Error('地点坐标不完整。');point=pair(parts.slice(0,2).join(','),true);
  }else if(p.has('lat')&&(p.has('lon')||p.has('lng')))point=pair(`${p.get('lat')},${p.get('lon')||p.get('lng')}`);
  const system=p.get('coordinate');
  if(system&&!['gaode','gcj02','wgs84'].includes(system.toLowerCase()))throw Error('无法确定链接的坐标类型，请手动选点。');
  corrected=system?.toLowerCase()!=='wgs84';
 }
 if(!point)return null;
 const canCorrect=correctionArea(point.lat,point.lng);
 return {...point,name:metadata(name,300),address:metadata(address,500),url:url.href,provider:apple?'apple':'amap',corrected:corrected&&canCorrect,canCorrect};
}
export function importedCoordinate(point:ImportedPoint,corrected=point.corrected){return corrected?gcjToWgs(point.lat,point.lng):{lat:point.lat,lng:point.lng};}

export function storedMapLink(place:ImportedPoint):string|undefined {
 if(place.url.length<=500)return place.url;
 const url=new URL(place.url);
 for(const key of ['address','_ext','commonBizInfo','map','lsp','spn'])url.searchParams.delete(key);
 return url.href.length<=500?url.href:undefined;
}
