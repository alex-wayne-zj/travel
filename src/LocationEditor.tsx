export default function LocationEditor({lat,lng,label,onChange,onPick}:{lat:number;lng:number;label:string;onChange:(lat:number,lng:number)=>void;onPick?:(lat:number,lng:number,onConfirm:(lat:number,lng:number)=>void)=>void}){
 const located=Number.isFinite(lat)&&Math.abs(lat)<=90&&Number.isFinite(lng)&&Math.abs(lng)<=180;
 return <div className="editor-location editor-wide">
  {onPick&&<button type="button" className="editor-pick" onClick={()=>onPick(located?lat:NaN,located?lng:NaN,onChange)}><span>地图选点 · {label}</span><small>{located?'已选位置 · 点击更换':'尚未选点'}</small></button>}
  {located&&<a className="editor-map-link" href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`} target="_blank" rel="noopener noreferrer">在 OpenStreetMap 打开 ↗</a>}
 </div>;
}
