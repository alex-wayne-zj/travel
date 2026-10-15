import {api} from './api';
import AnimatedPanel from './AnimatedPanel';
import {mapLinkURL,parseMapPoint,importedCoordinate,storedMapLink,type ImportedPoint,type PickDetails} from './map-import';
import './map-import.css';
import {useTimedMessage} from './useTimedMessage';
import {useEffect,useRef,useState} from 'react';
import {Map,Marker,setWorkerUrl} from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import {OPEN_MAP_STYLE,mapRequest} from './map-resources';
setWorkerUrl(workerUrl);
const parse=(text:string)=>text.trim()&&/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text.trim())?Number(text):NaN;
const valid=(lat:number,lng:number)=>Number.isFinite(lat)&&Math.abs(lat)<=90&&Number.isFinite(lng)&&Math.abs(lng)<=180;

export default function MapPicker({lat,lng,onConfirm,onCancel}:{lat:number;lng:number;onConfirm:(lat:number,lng:number,details?:PickDetails)=>void;onCancel:()=>void}){
 const initial=valid(lat,lng)?{lat,lng}:null;
 const node=useRef<HTMLDivElement>(null),dialog=useRef<HTMLDivElement>(null),map=useRef<Map|null>(null),marker=useRef<Marker|null>(null);
 const [candidate,setCandidate]=useState(initial),[latitude,setLatitude]=useState(initial?String(lat):''),[longitude,setLongitude]=useState(initial?String(lng):'');
 const [touched,setTouched]=useState({lat:false,lng:false}),[error,setError]=useState('');
 const visibleError=useTimedMessage(error);
 const [importText,setImportText]=useState(''),[importError,setImportError]=useState(''),[importBusy,setImportBusy]=useState(false),[imported,setImported]=useState<ImportedPoint|null>(null);
 const importSequence=useRef(0);
 const [manual,setManual]=useState(false),[pasteFallback,setPasteFallback]=useState(false);
 const importInput=useRef<HTMLInputElement>(null);
 const importPending=!!importText.trim()&&!imported;
 function clearImport(){++importSequence.current;setImported(null);setImportText('');setImportError('');setImportBusy(false);}
 function previewImport(place:ImportedPoint){
  const m=map.current;if(!m)throw Error('地图暂不可用，请联网后重新打开选点。');
  const coordinate=importedCoordinate(place);m.stop();select(coordinate,m,true);
  m.flyTo({center:[coordinate.lng,coordinate.lat],zoom:16,duration:matchMedia('(prefers-reduced-motion: reduce)').matches?0:450});setImported(place);
 }
 async function importLink(text=importText){
  const sequence=++importSequence.current;setImportError('');setImported(null);setImportBusy(true);
  try{
   const url=mapLinkURL(text);let place=parseMapPoint(url.href);
   if(!place){const result=await api<{url:string}>('/map-links/resolve','POST',{url:url.href});if(sequence!==importSequence.current)return;place=parseMapPoint(result.url);}
   if(sequence!==importSequence.current)return;
   if(!place)throw Error('链接中没有可提取的地点坐标，请打开原地图复制完整地点链接，或手动选点。');
   previewImport({...place,url:url.href});
  }catch(e){if(sequence===importSequence.current)setImportError((e as Error).message);}
  finally{if(sequence===importSequence.current)setImportBusy(false);}
 }

 async function pasteImport(){
  // Clipboard reads must stay directly in the user's click gesture (including iOS).
  try{
   const text=await navigator.clipboard.readText();
   if(!text.trim())throw Error('剪贴板为空');
   setImportText(text);await importLink(text);
  }catch{
   setPasteFallback(true);setImportError('请在下方输入框长按粘贴，粘贴后会自动读取。');
   requestAnimationFrame(()=>importInput.current?.focus());
  }
 }

 const inputLat=parse(latitude),inputLng=parse(longitude);
 const latOk=Number.isFinite(inputLat)&&Math.abs(inputLat)<=90,lngOk=Number.isFinite(inputLng)&&Math.abs(inputLng)<=180;
 const coordinateError=touched.lat&&!latOk?'纬度须在 −90 至 90 之间':touched.lng&&!lngOk?'经度须在 −180 至 180 之间':'';
 const pending=!candidate||inputLat!==candidate.lat||inputLng!==candidate.lng;
 function select(point:{lat:number;lng:number},m:Map,preserveImport=false){
  if(!preserveImport)clearImport();
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
  const observer=new ResizeObserver(()=>m?.resize());observer.observe(node.current!);
  try{
   m=new Map({container:node.current!,style:OPEN_MAP_STYLE,transformRequest:mapRequest,center:initial?[lng,lat]:[10.5,50.6],zoom:initial?12:4,attributionControl:false});map.current=m;
   if(initial)marker.current=new Marker().setLngLat([lng,lat]).addTo(m);
   m.on('click',e=>{m!.stop();select({lat:Number(e.lngLat.lat.toFixed(6)),lng:Number(e.lngLat.wrap().lng.toFixed(6))},m!);});
   m.on('error',()=>setError('地图加载失败，请取消后联网重试。'));
  }catch{setError('当前浏览器无法显示地图，请换用支持 WebGL 的浏览器。');}
  function key(e:KeyboardEvent){
   if(e.key==='Escape')onCancel();
   if(e.key==='Tab'){
    const els=Array.from(dialog.current!.querySelectorAll<HTMLElement>('button,input,a,select,[tabindex="0"]')).filter(e=>!e.hasAttribute('disabled')&&!e.closest('[inert],[hidden]')&&e.getClientRects().length>0);
    const first=els[0],last=els[els.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
   }
  }
  document.addEventListener('keydown',key);
  return()=>{observer.disconnect();++importSequence.current;document.removeEventListener('keydown',key);viewport?.removeEventListener('resize',resizeViewport);viewport?.removeEventListener('scroll',resizeViewport);marker.current?.remove();m?.remove();map.current=null;nodes.forEach((n,i)=>n.inert=previousInert[i]);previous?.focus();};
 },[]);
 return <div className="picker-backdrop" onClick={e=>{if(e.target===e.currentTarget)onCancel();}}><div className="picker-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="picker-title">
  <div className="picker-heading"><h2 id="picker-title">选择位置</h2><button type="button" aria-label="取消选点" onClick={onCancel}>×</button></div>
  <form className="picker-import" onSubmit={e=>{e.preventDefault();void importLink();}}>
   <div className="picker-import-row"><button type="button" disabled={importBusy} onClick={()=>void pasteImport()}>{importBusy?'读取中…':'粘贴导入链接'}</button></div>
   <AnimatedPanel open={pasteFallback}><label className="picker-paste-fallback">从地图导入<input ref={importInput} id="map-import-link" type="text" inputMode="url" autoComplete="off" maxLength={8192} placeholder="长按粘贴地图分享链接" value={importText} aria-describedby="map-import-status" aria-invalid={!!importError} onChange={e=>{++importSequence.current;setImportText(e.target.value);setImported(null);setImportError('');setImportBusy(false);}} onPaste={e=>{const text=e.clipboardData.getData('text');e.preventDefault();setImportText(text);void importLink(text);}}/></label><button type="submit" disabled={importBusy||!importText.trim()}>读取链接</button></AnimatedPanel>
   <div id="map-import-status" className={`picker-import-status${importError?' invalid':''}`} role="status">{importError||(!imported?'支持地点链接或含链接的分享文字，导入后请核对落点。':<><a href={imported.url} target="_blank" rel="noopener noreferrer">{imported.name||'已导入地点'}</a><span> · {imported.provider==='apple'?'苹果地图':'高德地图'}{imported.corrected?' · 已校正坐标':''}</span></>)}</div>
   {imported?.canCorrect&&<label className="picker-import-correction"><input type="checkbox" checked={imported.corrected} onChange={e=>previewImport({...imported,corrected:e.target.checked})}/>校正国内地图偏移<span>落点偏移时切换并核对</span></label>}
  </form>
  <button type="button" className="picker-manual-toggle" aria-expanded={manual} aria-controls="picker-manual" onClick={()=>setManual(!manual)}>{manual?'收起经纬度选点':'经纬度选点'}</button>
  <AnimatedPanel open={manual} id="picker-manual"><form className="picker-coordinates" onSubmit={e=>{e.preventDefault();locate();}}>
   <div className="picker-coordinate-row">
    <label>纬度<input aria-describedby="picker-coordinate-hint" type="text" inputMode="decimal" autoComplete="off" maxLength={32} value={latitude} placeholder="50.1109" aria-invalid={touched.lat&&!latOk} onChange={e=>{clearImport();setLatitude(e.target.value);}} onBlur={()=>setTouched(t=>({...t,lat:true}))}/></label>
    <label>经度<input aria-describedby="picker-coordinate-hint" type="text" inputMode="decimal" autoComplete="off" maxLength={32} value={longitude} placeholder="8.6821" aria-invalid={touched.lng&&!lngOk} onChange={e=>{clearImport();setLongitude(e.target.value);}} onBlur={()=>setTouched(t=>({...t,lng:true}))}/></label>
    <button type="submit" className="picker-locate">定位</button>
   </div>
   <p id="picker-coordinate-hint" role="status">{coordinateError||'WGS84 十进制度，南纬／西经用负数；也可点地图。'}</p>
  </form></AnimatedPanel>
  <div className="picker-map"><div ref={node}/><div className="map-credit" style={{inset:'auto 4px 2px auto'}}>© <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a></div></div>
  {visibleError&&<p className="picker-warning" role="status">{visibleError}</p>}
  <div className="picker-actions"><span>{pending?'先定位或点击地图，检查标记后确认。':`${candidate!.lat}, ${candidate!.lng}`}</span><button type="button" className="solid" disabled={pending||importBusy||importPending} onClick={()=>candidate&&!pending&&!importBusy&&!importPending&&onConfirm(candidate.lat,candidate.lng,imported?{name:imported.name,address:imported.address,url:storedMapLink(imported)||''}:undefined)}>确认位置</button></div>
 </div></div>;
}
