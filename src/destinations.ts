export interface Country {id:string;name:string;zones:readonly (readonly [string,string])[]}
// A small travel shortlist; each country binds its primary travel timezone.
export const countries:Country[]=[
 {id:'CN',name:'中国',zones:[['Asia/Shanghai','北京时间']]},
 {id:'US',name:'美国',zones:[['America/New_York','纽约']]},
 {id:'JP',name:'日本',zones:[['Asia/Tokyo','东京']]},
 {id:'DE',name:'德国',zones:[['Europe/Berlin','柏林']]},
 {id:'KR',name:'韩国',zones:[['Asia/Seoul','首尔']]},
 {id:'FR',name:'法国',zones:[['Europe/Paris','巴黎']]},
 {id:'GB',name:'英国',zones:[['Europe/London','伦敦']]},
 {id:'CA',name:'加拿大',zones:[['America/Toronto','多伦多']]},
 {id:'AU',name:'澳大利亚',zones:[['Australia/Sydney','悉尼']]},
 {id:'NZ',name:'新西兰',zones:[['Pacific/Auckland','奥克兰']]},
 {id:'SG',name:'新加坡',zones:[['Asia/Singapore','新加坡']]},
 {id:'MY',name:'马来西亚',zones:[['Asia/Kuala_Lumpur','吉隆坡']]},
 {id:'ID',name:'印度尼西亚',zones:[['Asia/Jakarta','雅加达']]},
 {id:'CH',name:'瑞士',zones:[['Europe/Zurich','苏黎世']]},
 {id:'IT',name:'意大利',zones:[['Europe/Rome','罗马']]},
 {id:'IS',name:'冰岛',zones:[['Atlantic/Reykjavik','雷克雅未克']]},
 {id:'ES',name:'西班牙',zones:[['Europe/Madrid','马德里']]},
 {id:'NO',name:'挪威',zones:[['Europe/Oslo','奥斯陆']]},
];
export interface DestinationChoice {ids:string[];other:boolean;otherName:string;original?:string}
export function readDestination(value:string):DestinationChoice {
 const ids:string[]=[],other:string[]=[];
 for(const part of value.split('、').filter(Boolean)){const match=countries.find(c=>c.name===part);if(match)ids.push(match.id);else other.push(part);}
 return {ids,other:other.length>0,otherName:other.join('、'),original:value};
}
export function destinationText(value:DestinationChoice){if(value.original!==undefined)return value.original;return [...value.ids.map(id=>countries.find(c=>c.id===id)?.name||'').filter(Boolean),...(value.other&&value.otherName.trim()?[value.otherName.trim()]:[])].join('、');}
export function countryZones(ids:string[]){return ids.flatMap(id=>{const country=countries.find(c=>c.id===id);return country?.zones.map(([value,city])=>({value,label:`${country.name} · ${city}`}))||[];});}
export function fixedZone(offset:number){return offset===0?'Etc/UTC':`Etc/GMT${offset>0?'-':'+'}${Math.abs(offset)}`;}
export const fixedZones=Array.from({length:27},(_,i)=>{const offset=i-12;return {value:fixedZone(offset),label:offset===0?'零时区 · UTC±00:00':`${offset>0?'东':'西'}${Math.abs(offset)}区 · UTC${offset>0?'+':'−'}${String(Math.abs(offset)).padStart(2,'0')}:00`};});
