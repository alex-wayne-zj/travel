import {useEffect,useState} from 'react';

const parse=(text:string)=>text.trim()&&/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text.trim())?Number(text):NaN;
const valid=(value:number,max:number)=>Number.isFinite(value)&&Math.abs(value)<=max;
const display=(value:number)=>Number.isFinite(value)?String(value):'';

export default function LocationEditor({lat,lng,label,onChange,onPick}:{lat:number;lng:number;label:string;onChange:(lat:number,lng:number)=>void;onPick?:(lat:number,lng:number,onConfirm:(lat:number,lng:number)=>void)=>void}){
 const [latitude,setLatitude]=useState(()=>display(lat)),[longitude,setLongitude]=useState(()=>display(lng));
 const [touched,setTouched]=useState({lat:false,lng:false});
 // Preserve partial typing, but reflect a replacement point chosen on the map.
 useEffect(()=>{setLatitude(text=>Object.is(parse(text),lat)?text:display(lat));},[lat]);
 useEffect(()=>{setLongitude(text=>Object.is(parse(text),lng)?text:display(lng));},[lng]);
 const latOk=valid(lat,90),lngOk=valid(lng,180),located=latOk&&lngOk;
 const error=touched.lat&&!latOk?'纬度须在 −90 至 90 之间':touched.lng&&!lngOk?'经度须在 −180 至 180 之间':'';
 return <div className="editor-location editor-wide">
  {onPick&&<button type="button" className="editor-pick" onClick={()=>onPick(located?lat:NaN,located?lng:NaN,onChange)}><span>地图选点 · {label}</span><small>{located?'已选位置 · 点击更换':'尚未选点'}</small></button>}
  <details className="editor-coordinates"><summary>输入经纬度</summary><div className="editor-coordinate-fields">
   <label>{label}纬度<input type="text" inputMode="decimal" autoComplete="off" value={latitude} maxLength={32} placeholder="例如 50.1109" aria-invalid={touched.lat&&!latOk} onBlur={()=>setTouched(t=>({...t,lat:true}))} onChange={e=>{setLatitude(e.target.value);onChange(parse(e.target.value),lng);}}/></label>
   <label>{label}经度<input type="text" inputMode="decimal" autoComplete="off" value={longitude} maxLength={32} placeholder="例如 8.6821" aria-invalid={touched.lng&&!lngOk} onBlur={()=>setTouched(t=>({...t,lng:true}))} onChange={e=>{setLongitude(e.target.value);onChange(lat,parse(e.target.value));}}/></label>
  </div><p className="editor-coordinate-status" role="status">{error||'WGS84 十进制度；南纬、西经填负数。'}</p></details>
  {located&&<a className="editor-map-link" href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`} target="_blank" rel="noopener noreferrer">在 OpenStreetMap 打开 ↗</a>}
 </div>;
}
