import {useTimedMessage} from './useTimedMessage';
import React,{useEffect,useRef,useState} from 'react';
import {Map,Marker,LngLatBounds,setWorkerUrl,type GeoJSONSource} from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import {Plane,TrainFront,Car,Utensils,Landmark,BedDouble,Footprints,Trees,ShoppingBag,Ticket,Play,Pause,ChevronLeft,ChevronRight,Focus,RefreshCw} from 'lucide-react';
import {renderToStaticMarkup} from 'react-dom/server';
import {api,type Trip} from './api';
import Logo from './Logo';
import WeatherCard from './WeatherCard';
import {OPEN_MAP_STYLE,mapRequest,prepareOnlinePack,type MapPack,type MapPackManifest} from './map-resources';
import {advance,isLastStop,isAlternative,planningSlot,activityStops,dayConnections,route,point,type Cursor,type Day,type Event,type Kind} from './model';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
setWorkerUrl(workerUrl);

const icons={flight:Plane,train:TrainFront,taxi:Car,food:Utensils,sight:Landmark,hotel:BedDouble,walk:Footprints,nature:Trees,visit:Landmark,shopping:ShoppingBag,activity:Ticket};
const labels:Record<Kind,string>={flight:'航班',train:'跨城交通',taxi:'交通',food:'想吃',sight:'想去',hotel:'住宿',walk:'想去',nature:'自然',visit:'参观',shopping:'逛街',activity:'活动'};
const colors:Record<Kind,string>={flight:'#4568ab',train:'#176764',taxi:'#b88228',food:'#b85739',sight:'#176764',hotel:'#776085',walk:'#6a7a60',nature:'#527b53',visit:'#176764',shopping:'#a26e46',activity:'#786789'};
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
function Icon({kind,size=18}:{kind:Kind,size?:number}) {const I=icons[kind];return <I size={size}/>;}
function MapStage({tripId,days,day,event,progress,scope,follow,onFollow,onSelect,onProvider,retry}:{tripId:string,days:Day[],day:Day,event:Event|undefined,progress:number,scope:'day'|'trip'|'event',follow:boolean,onFollow:(x:boolean)=>void,onSelect:(id:string)=>void,onProvider:(provider:'openfreemap'|'protomaps')=>void,retry:number}){
 const container=useRef<HTMLDivElement>(null),map=useRef<Map|null>(null),vehicle=useRef<Marker|null>(null),markers=useRef<Marker[]>([]);
 const [ready,setReady]=useState(false),[error,setError]=useState(''),[manifest,setManifest]=useState<MapPackManifest|null>(null),[styleVersion,setStyleVersion]=useState(0);
 const visibleError=useTimedMessage(error);
 const activeRegion=useRef<MapPack|null>(null);
 const styleLoaded=useRef(false),activePack=useRef<string|null>(null),packRelease=useRef<(()=>void)|null>(null);
 useEffect(()=>{let cancelled=false;setManifest(null);api<MapPackManifest>('/trips/'+encodeURIComponent(tripId)+'/map-pack').then(value=>{if(!cancelled)setManifest(value);}).catch(()=>{/* A pack is an optional acceleration; the interactive provider remains available. */});return()=>{cancelled=true;};},[tripId,retry]);
 const callback=useRef({onFollow,onSelect,onProvider});callback.current={onFollow,onSelect,onProvider};
 useEffect(()=>{styleLoaded.current=false;setReady(false);setError('');let initialLoaded=false;let m:Map;activePack.current=null;activeRegion.current=null;callback.current.onProvider('openfreemap');const initial=new LngLatBounds();day.events.filter(e=>!isAlternative(e)).flatMap(route).forEach(p=>initial.extend(p));const width=container.current!.clientWidth,height=container.current!.clientHeight;try {m=new Map({container:container.current!,style:OPEN_MAP_STYLE,transformRequest:mapRequest,...(initial.isEmpty()?{center:[10.5,50.6] as [number,number],zoom:5.2}:{bounds:initial,fitBoundsOptions:{padding:{top:Math.min(48,height*.2),bottom:Math.min(32,height*.2),left:Math.min(40,width*.1),right:Math.min(40,width*.1)},maxZoom:13}}),maxZoom:18,attributionControl:false});map.current=m;m.on('dragstart',()=>callback.current.onFollow(false));m.on('zoomstart',e=>{if(e.originalEvent)callback.current.onFollow(false);});m.on('style.load',()=>{initialLoaded=true;styleLoaded.current=true;setStyleVersion(v=>v+1);setReady(true);setError('');});m.on('moveend',()=>{const region=activeRegion.current;if(!region)return;const c=m.getCenter(),b=region.bounds;if(m.getZoom()<=region.maxZoom+2&&c.lng>=b[0]&&c.lng<=b[2]&&c.lat>=b[1]&&c.lat<=b[3])return;activePack.current=null;activeRegion.current=null;styleLoaded.current=false;setReady(false);m.setStyle(OPEN_MAP_STYLE);packRelease.current?.();packRelease.current=null;callback.current.onProvider('openfreemap');});m.on('error',()=>{if(activePack.current){activePack.current=null;activeRegion.current=null;styleLoaded.current=false;setReady(false);m.setStyle(OPEN_MAP_STYLE);packRelease.current?.();packRelease.current=null;callback.current.onProvider('openfreemap');}else setError('地图资源加载失败，请检查网络后重试；日程仍可浏览。');});}catch {setError('当前浏览器无法显示地图，请启用 WebGL 或换用支持的浏览器。');return;}
 const timeout=setTimeout(()=>{if(!initialLoaded)setError('地图加载较慢，请检查网络后重试。');},18000);
 const observer=new ResizeObserver(()=>m.resize());observer.observe(container.current!);
 return ()=>{clearTimeout(timeout);observer.disconnect();markers.current.forEach(x=>x.remove());vehicle.current?.remove();m.remove();packRelease.current?.();packRelease.current=null;map.current=null;};},[retry,tripId]);
 useEffect(()=>{const m=map.current;if(!m||!manifest)return;const pack=scope==='trip'?manifest.overview:manifest.days[day.id];let cancelled=false;if(!pack){if(activePack.current){activePack.current=null;activeRegion.current=null;styleLoaded.current=false;setReady(false);m.setStyle(OPEN_MAP_STYLE);packRelease.current?.();packRelease.current=null;callback.current.onProvider('openfreemap');}return;}prepareOnlinePack(pack).then(resource=>{if(cancelled||map.current!==m){resource.release();return;}if(activePack.current===pack.url){resource.release();return;}activePack.current=pack.url;activeRegion.current=pack;styleLoaded.current=false;setReady(false);m.setStyle(resource.style);packRelease.current?.();packRelease.current=resource.release;callback.current.onProvider('protomaps');}).catch(()=>{if(!cancelled&&activePack.current){activePack.current=null;activeRegion.current=null;styleLoaded.current=false;setReady(false);m.setStyle(OPEN_MAP_STYLE);packRelease.current?.();packRelease.current=null;callback.current.onProvider('openfreemap');}});return()=>{cancelled=true;};},[manifest,scope==='trip'?'overview':day.id,retry]);
 useEffect(()=>{const m=map.current;if(!ready||!m||!styleLoaded.current)return;markers.current.forEach(x=>x.remove());markers.current=[];vehicle.current?.remove();
 const events=scope==='trip'?days.flatMap(d=>d.events).filter(e=>!isAlternative(e)):day.events;
 const features=events.filter(e=>e.to&&!isAlternative(e)).map(e=>({type:'Feature' as const,properties:{color:colors[e.kind],kind:e.kind},geometry:{type:'LineString' as const,coordinates:route(e)}}));
 dayConnections(scope==='trip'?days:[day]).forEach(coordinates=>features.push({type:'Feature',properties:{color:'#527b66',kind:'activity'},geometry:{type:'LineString',coordinates}}));
 const data={type:'FeatureCollection' as const,features};
 if(m.getSource('journey'))(m.getSource('journey') as GeoJSONSource).setData(data);else {m.addSource('journey',{type:'geojson',data});m.addLayer({id:'journey',type:'line',source:'journey',paint:{'line-color':['get','color'],'line-width':3,'line-opacity':0.72}});m.addLayer({id:'flight-route',type:'line',source:'journey',filter:['==','kind','flight'],paint:{'line-color':'#f9faf6','line-width':2,'line-dasharray':[2,3]}});m.addLayer({id:'taxi-route',type:'line',source:'journey',filter:['==','kind','taxi'],paint:{'line-color':'#fff','line-width':1.8,'line-dasharray':[1,3]}});}
 events.forEach(e=>{const el=document.createElement('button');el.className=`map-pin ${isAlternative(e)?'alternative':''} ${e.id===event?.id?'selected':''}`;el.style.setProperty('--pin-color',colors[e.kind]);el.setAttribute('aria-label',`${isAlternative(e)?'备选 · ':''}${e.title}`);el.title=e.title;el.innerHTML=renderToStaticMarkup(<Icon kind={e.kind} size={16}/>);el.onclick=()=>callback.current.onSelect(e.id);markers.current.push(new Marker({element:el}).setLngLat([e.lng,e.lat]).addTo(m));});
 const el=document.createElement('div');el.className='vehicle';el.style.display=event?.to?'grid':'none';el.style.background=event?colors[event.kind]:'#176764';el.innerHTML=event?renderToStaticMarkup(<Icon kind={event.kind} size={22}/>):'';el.setAttribute('aria-hidden','true');vehicle.current=event?new Marker({element:el}).setLngLat(point(event,progress)).addTo(m):null;
 },[ready,styleVersion,day,event?.id,scope]);
 useEffect(()=>{if(event)vehicle.current?.setLngLat(point(event,progress));},[event,progress,ready]);
 useEffect(()=>{const m=map.current;if(!m||!ready||!styleLoaded.current||!follow)return;const fit=()=>{const events=scope==='trip'?days.flatMap(d=>d.events).filter(e=>!isAlternative(e)):scope==='event'&&event?[event]:day.events.filter(e=>!isAlternative(e));const bounds=new LngLatBounds();events.flatMap(route).forEach(p=>bounds.extend(p));if(bounds.isEmpty())return;m.fitBounds(bounds,{padding:{top:Math.min(48,m.getContainer().clientHeight*.2),bottom:Math.min(32,m.getContainer().clientHeight*.2),left:Math.min(40,m.getContainer().clientWidth*.1),right:Math.min(40,m.getContainer().clientWidth*.1)},maxZoom:scope==='event'?15:13,duration:reduced()?0:250});};fit();m.on('resize',fit);return ()=>{m.off('resize',fit);};},[ready,styleVersion,day,event?.id,scope,follow]);
 return <><div className="map-canvas" ref={container}/>{!ready&&!error&&<div className="map-message" role="status">正在展开地图…</div>}{visibleError&&<div className="map-message error" role="status">{visibleError}</div>}</>;
}
const slotLabels={breakfast:'早餐',morning:'上午',lunch:'中餐',afternoon:'下午',dinner:'晚餐'};
export default function Journey({trip,onEdit}:{trip:Trip,onEdit:()=>void}) {
 const days=trip.days;
 const [cursor,setCursor]=useState<Cursor>({day:0,event:-1,progress:0});
 const [previewStarted,setPreviewStarted]=useState(false);
 const [playing,setPlaying]=useState(false),[scope,setScope]=useState<'day'|'trip'|'event'>('day');
 const [follow,setFollow]=useState(true),[retry,setRetry]=useState(0),[provider,setProvider]=useState<'openfreemap'|'protomaps'>('openfreemap');
 const dayIndex=cursor.day,day=days[dayIndex],event=day.events[cursor.event];
 const dateRail=useRef<HTMLElement>(null),drag=useRef<{x:number;scroll:number;moved:boolean}|null>(null);
 const transport=day.events.filter(e=>planningSlot(e)==='transport'&&!isAlternative(e)),hotel=day.events.find(e=>e.kind==='hotel'&&!isAlternative(e));
 const primary=activityStops(day);
 const planner=useRef<HTMLElement>(null);
 useEffect(()=>{const card=Array.from(planner.current?.querySelectorAll<HTMLElement>('[data-event]')||[]).find(el=>el.dataset.event===event?.id);if(!card)return;const rail=card.parentElement;if(!rail?.matches('.primary-wishes,.backup-wishes'))return;const a=card.getBoundingClientRect(),b=rail.getBoundingClientRect();if(a.left<b.left||a.right>b.right)rail.scrollBy({left:a.left<b.left?a.left-b.left:a.right-b.right,behavior:reduced()?'instant':'smooth'});},[event?.id]);
 const alternatives=day.events.filter(e=>isAlternative(e));
 function chooseDay(i:number) {
  setCursor({day:i,event:-1,progress:0});setScope('day');setFollow(true);setPlaying(false);setPreviewStarted(false);
 }
 function select(id:string) {
  if(drag.current?.moved)return;
  const di=days.findIndex(d=>d.events.some(e=>e.id===id));if(di<0)return;
  setCursor({day:di,event:days[di].events.findIndex(e=>e.id===id),progress:0});
  setScope('event');setFollow(true);setPlaying(false);setPreviewStarted(false);
 }
 useEffect(()=>{
  const button=dateRail.current?.querySelector<HTMLElement>('[aria-current="date"]');
  if(button&&dateRail.current){const r=dateRail.current;r.scrollTo({left:button.offsetLeft-r.offsetLeft-(r.clientWidth-button.clientWidth)/2,behavior:reduced()?'instant':'smooth'});}
 },[dayIndex]);
 useEffect(()=>{
  if(!playing)return;
  const timer=setInterval(()=>setCursor(c=>advance(days,c,days[c.day].events[c.event]?.to?0.025:0.05).cursor),100);
  return ()=>clearInterval(timer);
 },[playing]);
 useEffect(()=>{if(isLastStop(days,cursor)&&cursor.progress===1)setPlaying(false);},[cursor]);
 useEffect(()=>{
  const pause=()=>{if(document.hidden)setPlaying(false);};document.addEventListener('visibilitychange',pause);
  return ()=>document.removeEventListener('visibilitychange',pause);
 },[]);
 function togglePreview() {
  if(!days.some(d=>d.events.some(e=>!isAlternative(e))))return;
  if(playing){setPlaying(false);return;}
  if(isLastStop(days,cursor)&&cursor.progress===1){const di=days.findIndex(d=>d.events.some(e=>!isAlternative(e)));setCursor({day:di,event:days[di].events.findIndex(e=>!isAlternative(e)),progress:0});}
  else if(!previewStarted||(event&&isAlternative(event))){
   let di=dayIndex;
   if(!days[di].events.some(e=>!isAlternative(e))){di=days.findIndex((d,i)=>i>dayIndex&&d.events.some(e=>!isAlternative(e)));if(di<0)di=days.findIndex(d=>d.events.some(e=>!isAlternative(e)));}
   setCursor({day:di,event:days[di].events.findIndex(e=>!isAlternative(e)),progress:0});
  }
  setPreviewStarted(true);setScope('event');setFollow(true);setPlaying(true);
 }
 function wishButton(e:Event,slot?:string) {
  return <button key={e.id} className={`wish-card meal-${planningSlot(e)} ${isAlternative(e)?'backup-card':''} ${e.id===event?.id?'active':''}`} data-event={e.id} aria-pressed={e.id===event?.id} onClick={()=>select(e.id)}>
   <span className="wish-label"><Icon kind={e.kind} size={15}/>{slot}{slot?' · ':''}{isAlternative(e)?'备选':labels[e.kind]}</span><strong>{e.title}</strong>
  </button>;
 }
 return <main className="journey">
  <header><a className="brand" href="#journey" aria-label="旅途首页"><Logo size={28}/><span>旅途</span></a><div className="trip-title"><h1>{trip.name}</h1><span>{trip.startDate} — {trip.endDate}</span></div><button className="preview" onClick={togglePreview} aria-label={playing?'暂停路线预览':'预览路线'}>{playing?<Pause size={16}/>:<Play size={16}/>}<span>{playing?'暂停':'预览路线'}</span></button></header>
  <section className="map-stage" aria-label="旅程地图">
   <MapStage tripId={trip.id} onProvider={setProvider} days={days} day={day} event={event} progress={cursor.progress} scope={scope} follow={follow} onFollow={setFollow} onSelect={select} retry={retry}/>
   <div className="map-toolbar"><div className="segmented"><button aria-pressed={scope==='trip'} onClick={()=>{chooseDay(dayIndex);setScope('trip');}}>全程</button><button aria-pressed={scope!=='trip'} onClick={()=>chooseDay(dayIndex)}>当天</button></div><button className="follow" aria-label={follow?'跟随行程':'回到行程'} title={follow?'跟随行程':'回到行程'} onClick={()=>{setFollow(true);setScope(event?'event':'day');}}><Focus size={17}/></button><button className="retry" onClick={()=>setRetry(r=>r+1)} aria-label="重新加载地图" title="重新加载地图"><RefreshCw size={16}/></button></div>
   <div className="map-caption"><strong>{day.city}</strong><small>{day.title}</small></div><div className="map-note">路线示意</div><details className="map-info"><summary aria-label="地图数据来源">i</summary><span>数据来自 <a href={provider==='protomaps'?'https://protomaps.com/':'https://openfreemap.org/'} target="_blank" rel="noreferrer">{provider==='protomaps'?'Protomaps':'OpenFreeMap'}</a></span></details><div className="map-credit">© <a href={provider==='protomaps'?'https://protomaps.com/':'https://openmaptiles.org/'} target="_blank" rel="noreferrer">{provider==='protomaps'?'Protomaps':'OpenMapTiles'}</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a></div>
  </section>
  <section className="planner" aria-label="当天行程" ref={planner}>
   <div className="date-nav"><button className="date-arrow" aria-label="前一天" disabled={dayIndex===0} onClick={()=>chooseDay(dayIndex-1)}><ChevronLeft size={18}/></button>
    <nav className="days" aria-label="选择日期" ref={dateRail}
     onPointerDown={e=>{if(e.pointerType==='touch')return;drag.current={x:e.clientX,scroll:dateRail.current!.scrollLeft,moved:false};}}
     onPointerMove={e=>{if(e.buttons!==1){drag.current=null;return;}const d=drag.current;if(!d||!dateRail.current)return;if(Math.abs(e.clientX-d.x)>6){d.moved=true;dateRail.current.setPointerCapture(e.pointerId);dateRail.current.scrollLeft=d.scroll-(e.clientX-d.x);}}}
     onPointerUp={()=>{setTimeout(()=>{drag.current=null;},0);}} onPointerCancel={()=>{drag.current=null;}}>
     {days.map((d,i)=><button key={d.id} aria-current={i===dayIndex?'date':undefined} onClick={()=>{if(!drag.current?.moved)chooseDay(i);}}><span>DAY {String(i+1).padStart(2,'0')}<small>{d.date.slice(5).replace('-','/')}</small></span><strong>{d.city}</strong></button>)}
    </nav><button className="date-arrow" aria-label="后一天" disabled={dayIndex===days.length-1} onClick={()=>chooseDay(dayIndex+1)}><ChevronRight size={18}/></button>
   </div>
   <div className="planner-row"><span className="row-title" aria-label="住宿与交通"><span>住宿</span><span aria-hidden="true">&amp;</span><span>交通</span></span><div className="travel-stay">
    {transport.map(e=><button className={`ticket ${e.id===event?.id?'active':''}`} key={e.id} data-event={e.id} aria-pressed={e.id===event?.id} onClick={()=>select(e.id)}><Icon kind={e.kind} size={20}/><span className="ticket-route"><small>{labels[e.kind]}</small><strong>{e.title}</strong></span><span className="ticket-schedule"><strong>{e.time||'待定'}</strong><small>始发{e.endTime&&` · ${e.endTime} 抵达`}</small></span></button>)}
    {hotel&&<button className={`stay ${hotel.id===event?.id?'active':''}`} data-event={hotel.id} aria-pressed={hotel.id===event?.id} onClick={()=>select(hotel.id)}><BedDouble size={17}/><span><small>{hotel.stayLabel||'住宿待选'}</small><strong>{hotel.title}</strong></span></button>}
    {!hotel&&<button className="stay empty-slot" onClick={onEdit}><BedDouble size={17}/><span><small>住宿</small><strong>＋ 添加住宿</strong></span></button>}
    {transport.length===0&&<button className="ticket empty-slot" onClick={onEdit}><Car size={20}/><span className="ticket-route"><small>交通</small><strong>＋ 添加交通</strong></span></button>}
    <WeatherCard trip={trip} day={day}/>
   </div></div>
   <div className="planner-row"><span className="row-title">行程</span><div className="primary-wishes" role="region" aria-label="想去与想吃" tabIndex={0}>{Object.entries(slotLabels).flatMap(([slot,label])=>{
    const matches=primary.filter(e=>planningSlot(e)===slot);
    return matches.length?matches.map(e=>wishButton(e,label)):slot==='breakfast'?[]:[<button className="wish-card empty-slot" key={slot} onClick={onEdit}><span className="wish-label">{label}</span><strong>＋ 添加{slot==='lunch'||slot==='dinner'?'想吃':'想去'}</strong></button>];
   })}</div></div>
   <div className="planner-row alternatives"><span className="row-title">备选</span><div className="backup-wishes" role="region" aria-label="备选活动" tabIndex={0}>{alternatives.map(e=>wishButton(e,slotLabels[planningSlot(e) as keyof typeof slotLabels]))}{alternatives.length===0&&<button className="wish-card backup-card empty-slot" onClick={onEdit}><span className="wish-label">备选</span><strong>＋ 添加备选</strong></button>}</div></div>

   <aside className="recommendation" aria-label="推荐词" aria-live="polite"><p>{event?(event.recommendation||event.note):'选择一项活动，查看推荐与参考链接。'}</p>{event?.sourceUrl&&<a href={event.sourceUrl} target="_blank" rel="noreferrer">参考链接</a>}</aside>
  </section>
 </main>;
}
