export type Kind = 'flight'|'train'|'bus'|'taxi'|'food'|'sight'|'hotel'|'walk'|'nature'|'visit'|'shopping'|'activity';
// Times are optional booking details, never required for a place or cuisine wish.
export interface Event {id:string;time?:string;endTime?:string;title:string;kind:Kind;lat:number;lng:number;to?:{lat:number;lng:number;name:string};note:string;slot?:'breakfast'|'morning'|'lunch'|'afternoon'|'dinner'|'transport'|'stay'|'alternative';alternative?:boolean;recommendation?:string;sourceUrl?:string;fullName?:string;address?:string;stayLabel?:string;checkInDate?:string;checkOutDate?:string;nights?:number}
// Keep legacy "alternative" slots readable; backup status is now independent of time slots.
export function isAlternative(e:Event):boolean {return e.alternative??(e.slot==='alternative');}
export function planningSlot(e:Event):Exclude<Event['slot'],'alternative'|undefined> {
 if(e.slot&&e.slot!=='alternative')return e.slot;
 return e.kind==='food'?'dinner':e.kind==='hotel'?'stay':['flight','train','bus','taxi'].includes(e.kind)?'transport':'morning';
}
export interface Day {id:string;date:string;city:string;title:string;events:Event[]}
// The editable event order is the itinerary order; backups never enter the route.
export function activityStops(day:Day):Event[] {
 return day.events.filter(e=>!isAlternative(e)&&['sight','food','walk','nature','visit','shopping','activity'].includes(e.kind)&&planningSlot(e)!=='transport');
}
export function dayConnections(days:Day[]):[number,number][][] {
 return days.map(d=>activityStops(d).map(e=>[e.lng,e.lat] as [number,number])).filter(points=>points.length>1);
}
export interface Cursor {day:number;event:number;progress:number}
// Preview progress is an animation fraction, not the itinerary's elapsed time.
export function isLastStop(days:Day[],cursor:Cursor):boolean {
 return !days.some((d,di)=>di>=cursor.day&&d.events.some((e,ei)=>!isAlternative(e)&&(di>cursor.day||ei>cursor.event)));
}
export function advance(days:Day[],cursor:Cursor,step:number):{cursor:Cursor;done:boolean} {
 const progress=Math.min(1,cursor.progress+step);
 if(progress<1&&days[cursor.day]?.events[cursor.event])return {cursor:{...cursor,progress},done:false};
 for(let di=cursor.day;di<days.length;di++){
  const ei=days[di].events.findIndex((e,i)=>!isAlternative(e)&&(di>cursor.day||i>cursor.event));
  if(ei>=0)return {cursor:{day:di,event:ei,progress:0},done:false};
 }
 return {cursor:{...cursor,progress:1},done:true};
}
export function route(e:Event):[number,number][] {if(!e.to)return [[e.lng,e.lat]]; const result:[number,number][]=[];for(let i=0;i<=40;i++){const t=i/40;result.push([e.lng+(e.to.lng-e.lng)*t,e.lat+(e.to.lat-e.lat)*t+(e.kind==='flight'? Math.sin(t*Math.PI)*Math.abs(e.to.lng-e.lng)*0.18:0)]);}return result;}
export function point(e:Event,progress:number):[number,number] {const r=route(e);const pos=Math.max(0,Math.min(1,progress))*(r.length-1);const i=Math.floor(pos);const next=r[Math.min(i+1,r.length-1)];return [r[i][0]+(next[0]-r[i][0])*(pos-i),r[i][1]+(next[1]-r[i][1])*(pos-i)];}
