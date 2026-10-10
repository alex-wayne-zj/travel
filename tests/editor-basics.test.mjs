import {test} from 'node:test';
import assert from 'node:assert/strict';
import {destinationText,readDestination,countryZones,fixedZone,countries} from '../src/destinations.ts';
import {dates,validateEvents} from '../src/editor-validation.ts';
import {readFileSync} from 'node:fs';
test('legacy and multi-country destinations preserve their saved text',()=>{
 for(const value of ['德国','德国、法国','日本、加拿大、秘鲁','德国柏林','中国 · 香港','日本、泰国、德国',' 德国 · 柏林 '])assert.equal(destinationText(readDestination(value)),value);
});
test('fixed east/west selections use IANA sign convention and actual offsets',()=>{
 for(const offset of [-12,-8,-1,0,1,8,14]){
  const zone=fixedZone(offset);const hour=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',hourCycle:'h23'}).format(new Date('2026-01-15T12:00:00Z'));
  assert.equal(Number(hour),(12+offset+24)%24);
 }
 assert.equal(countryZones(['DE','JP'])[0].value,'Europe/Berlin');
 for(const c of countries)for(const [zone] of c.zones)assert.doesNotThrow(()=>new Intl.DateTimeFormat('zh-CN',{timeZone:zone}));
});
test('date validation preserves leap days, DST and the 60-day boundary',()=>{
 assert.deepEqual(dates('2028-02-28','2028-03-01'),['2028-02-28','2028-02-29','2028-03-01']);
 assert.equal(dates('2026-10-24','2026-10-26').length,3);
 assert.equal(dates('2026-01-01','2026-03-01').length,60);
 assert.throws(()=>dates('2026-01-01','2026-03-02'));assert.throws(()=>dates('2026-02-29','2026-03-01'));assert.throws(()=>dates('2026-10-12','2026-10-11'));
});
test('extracted event validation keeps map, booking and reference boundaries',()=>{
 const days=JSON.parse(readFileSync(new URL('../src/itinerary.json',import.meta.url)));assert.doesNotThrow(()=>validateEvents(days));
 const clone=()=>structuredClone(days);
 let invalid=clone();invalid[0].events[0].lat=NaN;assert.throws(()=>validateEvents(invalid),/地图/);
 invalid=clone();invalid[0].events[0].sourceUrl='http://example.com';assert.throws(()=>validateEvents(invalid),/HTTPS/);
 invalid=clone();invalid[0].events[0].endTime='00:00';assert.throws(()=>validateEvents(invalid),/结束时间/);
});

test('daytime activity types expose four choices and keep legacy display compatible',async()=>{
 const {allowed,editorKind}=await import('../src/editor-options.ts');
 for(const slot of ['morning','afternoon'])assert.deepEqual(allowed(slot),['nature','visit','shopping','activity']);
 assert.equal(editorKind({kind:'sight',slot:'morning'}),'visit');
 assert.equal(editorKind({kind:'walk',slot:'afternoon'}),'activity');
 assert.equal(editorKind({kind:'walk',slot:'transport'}),'walk');
 assert.ok(allowed('transport').includes('walk'));
});
