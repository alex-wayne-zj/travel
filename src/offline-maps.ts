import {Map as GLMap,setWorkerUrl} from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import {api,type Trip} from './api';
import {preparePack,type MapPack,type MapPackManifest} from './map-resources';
import type {OfflineMapAssets,OfflineSnapshot} from './offline-template';
setWorkerUrl(workerUrl);
async function capture(pack:MapPack):Promise<OfflineSnapshot>{const resource=await preparePack(pack);const node=document.createElement('div');Object.assign(node.style,{position:'fixed',left:'-2000px',top:'0',width:'900px',height:'560px',pointerEvents:'none'});node.setAttribute('aria-hidden','true');document.body.append(node);let map:GLMap|undefined;try{map=new GLMap({container:node,style:resource.style,bounds:[[pack.bounds[0],pack.bounds[1]],[pack.bounds[2],pack.bounds[3]]],fitBoundsOptions:{padding:0,maxZoom:pack.maxZoom},maxZoom:pack.maxZoom,interactive:false,attributionControl:false,canvasContextAttributes:{preserveDrawingBuffer:true},pixelRatio:1,fadeDuration:0});const m=map;await new Promise<void>((resolve,reject)=>{let done=false;const cleanup=()=>{clearTimeout(timer);m.off('idle',idle);m.off('error',fail);};const finish=(error?:Error)=>{if(done)return;done=true;cleanup();error?reject(error):resolve();};const idle=()=>finish();const fail=(e:{error:{message:string}})=>finish(Error('底图渲染失败：'+e.error.message));const timer=setTimeout(()=>finish(Error('底图渲染超过 30 秒，请联网后重试')),30000);m.on('idle',idle);m.on('error',fail);});const bounds=map.getBounds(),canvas=map.getCanvas();return {dataUrl:canvas.toDataURL('image/png'),width:canvas.width,height:canvas.height,bounds:[bounds.getWest(),bounds.getSouth(),bounds.getEast(),bounds.getNorth()],attribution:'© Protomaps · © OpenStreetMap'};}finally{map?.remove();node.remove();resource.release();}}
export async function getOfflineMaps(trip:Trip,onProgress?:(text:string)=>void):Promise<OfflineMapAssets>{
 const result:OfflineMapAssets={days:{},failures:[]};if(!trip.days.some(d=>d.events.length))return result;
 onProgress?.('正在预加载本旅程有限区域地图…');
 const manifest=await api<MapPackManifest>('/trips/'+encodeURIComponent(trip.id)+'/map-pack','POST',{});
 const snapshots=new Map<string,Promise<OfflineSnapshot>>();
 const snapshot=(pack:MapPack)=>{let pending=snapshots.get(pack.url);if(!pending){pending=capture(pack);snapshots.set(pack.url,pending);}return pending;};
 const record=async(label:string,pack:MapPack|undefined|null):Promise<OfflineSnapshot|undefined>=>{try{if(!pack)throw Error('底图尚未生成');return await snapshot(pack);}catch(e){result.failures!.push(label+'：'+(e instanceof Error?e.message:'底图制作失败'));return undefined;}};
 onProgress?.('正在制作全程真实底图…');result.overview=await record('全程',manifest.overview);
 for(const [i,day] of trip.days.entries()){if(!day.events.length)continue;onProgress?.('正在制作每日底图 '+(i+1)+' / '+trip.days.length+'…');const image=await record(day.date,manifest.days[day.id]);if(image)result.days[day.id]=image;}
 return result;
}
