import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {advance,isLastStop,point,route} from '../src/model.ts';
const days=JSON.parse(readFileSync(new URL('../src/itinerary.json',import.meta.url)));
test('all ten days contain four primary slots and exactly two alternative sights and a restaurant',()=>{
 assert.equal(days.length,10);const ids=new Set();
 for(const day of days){
  for(const [slot,kind] of [['morning','sight'],['lunch','food'],['afternoon','sight'],['dinner','food']]){const events=day.events.filter(e=>e.slot===slot);assert.equal(events.length,1);assert.equal(events[0].kind,kind);assert.equal(events[0].time,undefined);}
  const backup=day.events.filter(e=>e.alternative);assert.equal(backup.filter(e=>e.kind==='sight').length,2);assert.equal(backup.filter(e=>e.kind==='food').length,1);assert.equal(new Set(day.events.map(e=>e.title)).size,day.events.length);
  for(const e of day.events){assert.ok(!ids.has(e.id));ids.add(e.id);assert.ok(e.recommendation.length>=40);if(e.kind==='sight'||e.kind==='food')assert.ok(e.sourceUrl.startsWith('https://'));for(const p of [e,e.to].filter(Boolean)){assert.ok(p.lat>=47&&p.lat<=54);assert.ok(p.lng>=4&&p.lng<=15);}}
 }
 for(const day of days.slice(0,-1))assert.ok(day.events.some(e=>e.kind==='hotel'));
});
test('virtual hotels cover nine nights across four real properties with coherent dates',()=>{
 const stays=new Map();
 for(const day of days.slice(0,-1)){const e=day.events.find(e=>e.kind==='hotel');assert.ok(e.sourceUrl.startsWith('https://'));assert.ok(e.fullName&&e.address&&e.stayLabel);assert.ok(e.checkInDate<=day.date&&day.date<e.checkOutDate);stays.set(e.sourceUrl,e.nights);}
 assert.equal(stays.size,4);assert.equal([...stays.values()].reduce((a,b)=>a+b,0),9);
});
test('flight and ICE tickets have departure and arrival times; return flight follows dinner',()=>{
 const tickets=days.flatMap(d=>d.events).filter(e=>e.kind==='flight'||e.kind==='train');assert.equal(tickets.length,6);
 for(const e of tickets){assert.match(e.time,/^\d{2}:\d{2}$/);assert.match(e.endTime,/^\d{2}:\d{2}$/);assert.ok(e.to);assert.ok(e.time<e.endTime);}
 assert.ok(days[9].events.findIndex(e=>e.kind==='flight')>days[9].events.findIndex(e=>e.slot==='dinner'));
});
test('route preview visits every primary stop, skips alternatives and stops at the final flight',()=>{
 let cursor={day:0,event:0,progress:0};const primary=days.flatMap(d=>d.events).filter(e=>!e.alternative),visited=[];
 for(let i=0;i<primary.length;i++){visited.push(days[cursor.day].events[cursor.event].id);const next=advance(days,cursor,1);cursor=next.cursor;assert.equal(next.done,i===primary.length-1);}
 assert.deepEqual(visited,primary.map(e=>e.id));assert.ok(isLastStop(days,cursor));assert.equal(cursor.progress,1);assert.equal(advance(days,cursor,1).done,true);
});
test('transport interpolation clamps endpoints and is finite without minute-level scheduling',()=>{
 for(const e of days.flatMap(d=>d.events).filter(e=>e.to)){assert.deepEqual(point(e,-1),[e.lng,e.lat]);assert.ok(Math.abs(point(e,2)[0]-e.to.lng)<1e-8);assert.ok(Math.abs(point(e,2)[1]-e.to.lat)<1e-8);assert.ok(point(e,.5).every(Number.isFinite));assert.equal(route(e).length,41);}
 const e=days[0].events.find(e=>!e.to);assert.deepEqual(point(e,.5),[e.lng,e.lat]);
});
test('preview crosses empty days and skips alternative-only days without invalid indexes',()=>{
 const source=days[0].events.find(e=>!e.alternative);
 const draft=[{...days[0],events:[]},{...days[0],events:[{...source,alternative:true}]},{...days[0],events:[source]},{...days[0],events:[]}];
 const next=advance(draft,{day:0,event:0,progress:0},1);
 assert.deepEqual(next,{cursor:{day:2,event:0,progress:0},done:false});assert.equal(isLastStop(draft,next.cursor),true);
 assert.equal(advance(draft,next.cursor,1).done,true);assert.equal(advance([{...days[0],events:[]}],{day:0,event:0,progress:0},1).done,true);
});

test('backup status is independent of breakfast and preserves legacy choices',async()=>{
 const {isAlternative,planningSlot}=await import('../src/model.ts');
 const event={...days[0].events.find(e=>e.kind==='food'),slot:'breakfast',alternative:false};
 assert.equal(isAlternative(event),false);assert.equal(planningSlot(event),'breakfast');
 assert.equal(isAlternative({...event,alternative:true}),true);
 const legacy={...event,slot:'alternative',alternative:undefined};
 assert.equal(isAlternative(legacy),true);assert.equal(planningSlot(legacy),'dinner');
 assert.equal(isAlternative({...legacy,alternative:false}),false);
 assert.equal(planningSlot({...legacy,kind:'sight'}),'morning');
 const schedule=[{...days[0],events:[event,legacy,{...event,id:'last'}]}];
 assert.equal(advance(schedule,{day:0,event:0,progress:0},1).cursor.event,2);
});
