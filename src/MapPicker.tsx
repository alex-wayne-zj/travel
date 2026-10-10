import {useTimedMessage} from './useTimedMessage';
import {useEffect,useRef,useState} from 'react';
import {Map,Marker,setWorkerUrl} from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import {OPEN_MAP_STYLE,mapRequest} from './map-resources';
setWorkerUrl(workerUrl);
const parse=(text:string)=>text.trim()&&/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text.trim())?Number(text):NaN;
const valid=(lat:number,lng:number)=>Number.isFinite(lat)&&Math.abs(lat)<=90&&Number.isFinite(lng)&&Math.abs(lng)<=180;

export default function MapPicker({lat,lng,onConfirm,onCancel}:{lat:number;lng:number;onConfirm:(lat:number,lng:number)=>void;onCancel:()=>void}){
 const initial=valid(lat,lng)?{lat,lng}:null;
 const node=useRef<HTMLDivElement>(null),dialog=useRef<HTMLDivElement>(null),map=useRef<Map|null>(null),marker=useRef<Marker|null>(null);
 const [candidate,setCandidate]=useState(initial),[latitude,setLatitude]=useState(initial?String(lat):''),[longitude,setLongitude]=useState(initial?String(lng):'');
 const [touched,setTouched]=useState({lat:false,lng:false}),[error,setError]=useState('');
 const visibleError=useTimedMessage(error);
 const inputLat=parse(latitude),inputLng=parse(longitude);
 const latOk=Number.isFinite(inputLat)&&Math.abs(inputLat)<=90,lngOk=Number.isFinite(inputLng)&&Math.abs(inputLng)<=180;
 const coordinateError=touched.lat&&!latOk?'纬度须在 −90 至 90 之间':touched.lng&&!lngOk?'经度须在 −180 至 180 之间':'';
 const pending=!candidate||inputLat!==candidate.lat||inputLng!==candidate.lng;
 function select(point:{lat:number;lng:number},m:Map){
  marker.current?.remove();marker.current=new Marker().setLngLat([point.lng,point.lat]).addTo(m);
  setCandidate(point);setLatitude(String(point.lat));setLongitude(String(point.lng));setTouched({lat:false,lng:false});
 }
 function locate(){
  setTouched({lat:true,lng:true});if(!latOk||!lngOk)return;
  const m=map.current;if(!m){setError('当前浏览器无法显示地图，请换用支持 WebGL 的浏览器。');return;}
  select({lat:inputLat,lng:inputLng},m);
  m.flyTo({center:[inputLng,inputLat],zoom:Math.max(m.getZoom(),15),duration:matchMedia('(prefers-reduced-motion: reduce)').matches?0:450});
 }
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement,overlay=dialog.current!.parentElement!;
  const nodes=[...Array.from(overlay.parentElement!.children),...Array.from(document.querySelectorAll('.history'))].filter((n):n is HTMLElement=>n instanceof HTMLElement&&n!==overlay);
  const previousInert=nodes.map(n=>n.inert);nodes.forEach(n=>n.inert=true);dialog.current?.querySelector<HTMLElement>('button')?.focus();
  // Keep the whole dialog scrollable above mobile keyboards.
  const viewport=window.visualViewport;
  function resizeViewport(){if(viewport){overlay.style.height=viewport.height+'px';overlay.style.top=viewport.offsetTop+'px';overlay.style.bottom='auto';dialog.current?.style.setProperty('--picker-view-height',viewport.height+'px');map.current?.resize();}}
  resizeViewport();viewport?.addEventListener('resize',resizeViewport);viewport?.addEventListener('scroll',resizeViewport);
  let m:Map|undefined;
  try{
   m=new Map({container:node.current!,style:OPEN_MAP_STYLE,transformRequest:mapRequest,center:initial?[lng,lat]:[10.5,50.6],zoom:initial?12:4,attributionControl:false});map.current=m;
   if(initial)marker.current=new Marker().setLngLat([lng,lat]).addTo(m);
   m.on('click',e=>{m!.stop();select({lat:Number(e.lngLat.lat.toFixed(6)),lng:Number(e.lngLat.wrap().lng.toFixed(6))},m!);});
   m.on('error',()=>setError('地图加载失败，请取消后联网重试。'));
  }catch{setError('当前浏览器无法显示地图，请换用支持 WebGL 的浏览器。');}
  function key(e:KeyboardEvent){
   if(e.key==='Escape')onCancel();
   if(e.key==='Tab'){
    const els=Array.from(dialog.current!.querySelectorAll<HTMLElement>('button,input,a,[tabindex="0"]')).filter(e=>!e.hasAttribute('disabled'));
    const first=els[0],last=els[els.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
   }
  }
  document.addEventListener('keydown',key);
  return()=>{document.removeEventListener('keydown',key);viewport?.removeEventListener('resize',resizeViewport);viewport?.removeEventListener('scroll',resizeViewport);marker.current?.remove();m?.remove();map.current=null;nodes.forEach((n,i)=>n.inert=previousInert[i]);previous?.focus();};
 },[]);
 return <div className="picker-backdrop" onClick={e=>{if(e.target===e.currentTarget)onCancel();}}><div className="picker-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="picker-title">
  <div className="picker-heading"><h2 id="picker-title">选择位置</h2><button type="button" aria-label="取消选点" onClick={onCancel}>×</button></div>
  <form className="picker-coordinates" onSubmit={e=>{e.preventDefault();locate();}}>
   <div className="picker-coordinate-row">
    <label>纬度<input aria-describedby="picker-coordinate-hint" type="text" inputMode="decimal" autoComplete="off" maxLength={32} value={latitude} placeholder="50.1109" aria-invalid={touched.lat&&!latOk} onChange={e=>setLatitude(e.target.value)} onBlur={()=>setTouched(t=>({...t,lat:true}))}/></label>
    <label>经度<input aria-describedby="picker-coordinate-hint" type="text" inputMode="decimal" autoComplete="off" maxLength={32} value={longitude} placeholder="8.6821" aria-invalid={touched.lng&&!lngOk} onChange={e=>setLongitude(e.target.value)} onBlur={()=>setTouched(t=>({...t,lng:true}))}/></label>
    <button type="submit" className="picker-locate">定位</button>
   </div>
   <p id="picker-coordinate-hint" role="status">{coordinateError||'WGS84 十进制度，南纬／西经用负数；也可点地图。'}</p>
  </form>
  <div className="picker-map"><div ref={node}/><div className="map-credit" style={{inset:'auto 4px 2px auto'}}>© <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a></div></div>
  {visibleError&&<p className="picker-warning" role="status">{visibleError}</p>}
  <div className="picker-actions"><span>{pending?'先定位或点击地图，检查标记后确认。':`${candidate!.lat}, ${candidate!.lng}`}</span><button type="button" className="solid" disabled={pending} onClick={()=>candidate&&!pending&&onConfirm(candidate.lat,candidate.lng)}>确认位置</button></div>
 </div></div>;
}
