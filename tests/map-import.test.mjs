import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mapLinkURL,parseMapPoint,gcjToWgs,importedCoordinate,storedMapLink} from '../src/map-import.ts';
test('Apple unified and legacy place links preserve coordinate order and international locations',()=>{
 const p=parseMapPoint('喜欢这里 https://maps.apple.com/place?coordinate=48.137,11.575&name=Marienplatz');
 assert.equal(p.name,'Marienplatz');assert.deepEqual(importedCoordinate(p),{lat:48.137,lng:11.575});assert.equal(p.provider,'apple');
 const old=parseMapPoint('https://maps.apple.com/?ll=-33.86,151.2&q=Sydney');assert.deepEqual(importedCoordinate(old),{lat:-33.86,lng:151.2});
 const china=parseMapPoint('https://maps.apple.com/place?coordinate=39.9,116.4&name=北京');assert.equal(china.corrected,false);assert.equal(china.canCorrect,true);
});
test('AMap lon-lat markers use correction unless explicitly WGS84; overseas is unchanged',()=>{
 const p=parseMapPoint('https://uri.amap.com/marker?position=116.403243,39.909403&name=天安门');
 const w=importedCoordinate(p);assert.ok(Math.abs(w.lat-39.908)<0.00002);assert.ok(Math.abs(w.lng-116.397)<0.00002);
 const gps=parseMapPoint('https://uri.amap.com/marker?position=116.397,39.908&coordinate=wgs84');assert.deepEqual(importedCoordinate(gps),{lat:39.908,lng:116.397});
 assert.deepEqual(gcjToWgs(48.137,11.575),{lat:48.137,lng:11.575});
 const polar=parseMapPoint('https://maps.apple.com/?ll=0,-180&q=边界');assert.deepEqual(importedCoordinate(polar),{lat:0,lng:-180});
});
test('unresolved links stay unresolved; map centers and routes are never invented as places',()=>{
 assert.equal(parseMapPoint('https://maps.apple/p/abc'),null);assert.equal(parseMapPoint('https://surl.amap.com/abc'),null);
 assert.equal(parseMapPoint('https://maps.apple.com/?ll=30,120'),null);
 for(const u of ['https://maps.apple.com/search?query=pizza&center=30,120','https://maps.apple.com/frame?center=30,120','https://maps.apple.com/?daddr=30,120','https://uri.amap.com/route?position=120,30'])assert.throws(()=>parseMapPoint(u));
});
test('rejects malicious hosts, invalid coordinates, ambiguous parameters and multiple places',()=>{
 for(const u of ['https://maps.apple.com.evil.test/?ll=30,120&q=x','https://maps.apple.com@127.0.0.1/','https://maps.apple.com:8443/','https://evil.test/','javascript:alert(1)','https://maps.apple.com/?ll=91,120&q=x','https://maps.apple.com/?ll=30,120&ll=40,110&q=x','https://uri.amap.com/marker?position=120,30,40','https://m.amap.com/?markers=120,30,A|121,31,B'])assert.throws(()=>parseMapPoint(u),u);
 assert.throws(()=>mapLinkURL('https://maps.apple.com/ https://amap.com/'));
 assert.equal(mapLinkURL('分享 http://surl.amap.com/abc。').href,'https://surl.amap.com/abc');
});

test('real Oriental Pearl Apple H-place and AMap wb share normalize to the same point',()=>{
 const apple=parseMapPoint('https://maps.apple.com/place?coordinate=31.239703,121.499718&name=东方明珠广播电视塔&place-id=H2710I3F80D8C5B11FA');
 const amap=parseMapPoint('https://wb.amap.com/?p='+encodeURIComponent('B00150F6D6,31.23970343070824,121.49971783161163,东方明珠广播电视塔,世纪大道1号'));
 assert.equal(apple.corrected,true);assert.equal(amap.corrected,true);assert.equal(amap.name,apple.name);
 const a=importedCoordinate(apple),b=importedCoordinate(amap);
 assert.ok(Math.abs(a.lat-b.lat)<0.000002);assert.ok(Math.abs(a.lng-b.lng)<0.000002);
 assert.ok(Math.abs(a.lng-121.499718)>0.001);
});

test('long Apple links retain a valid source within the activity field limit',()=>{
 const point=parseMapPoint('https://maps.apple.com/place?coordinate=31.239703,121.499718&name=东方明珠&place-id=H2710I3F80D8C5B11FA&address='+encodeURIComponent('中国上海市浦东新区世纪大道1号'.repeat(20)));
 const stored=storedMapLink(point);assert.ok(stored.length<=500);assert.equal(new URL(stored).searchParams.get('coordinate'),'31.239703,121.499718');assert.equal(new URL(stored).searchParams.get('name'),'东方明珠');
});

test('all share formats clean control characters from final name and address',()=>{
 for(const link of [
  'https://wb.amap.com/?p='+encodeURIComponent('B123,31,121,\0ABC\u0085,\0address\u009f'),
  'https://maps.apple.com/place?coordinate=31,121&name=%00ABC&address=%00address',
  'https://uri.amap.com/marker?position=121,31&name=%00ABC&address=%00address'
 ]){const point=parseMapPoint(link);assert.equal(point.name,'ABC');assert.equal(point.address,'address');}
});

test('imported metadata trims whitespace and keeps Unicode whole at the field limit',()=>{
 const point=parseMapPoint('https://maps.apple.com/place?coordinate=31,121&name='+encodeURIComponent(' '+('名'.repeat(299))+'😀多余 '));
 assert.equal(Array.from(point.name).length,300);assert.ok(point.name.endsWith('😀'));
 assert.equal(parseMapPoint('https://maps.apple.com/place?coordinate=31,121&name=%20%00%20').name,'');
});
