import {ApiError,type Trip} from './api';
import {getOfflineMaps} from './offline-maps';
import {renderOfflineTrip,normalizeOfflineMaps,type OfflineMapAssets} from './offline-template';
export type OfflineMapProvider=(trip:Trip,onProgress?:(text:string)=>void)=>Promise<OfflineMapAssets>;
let provider:OfflineMapProvider=getOfflineMaps;
// Tests can substitute deterministic snapshots; production uses the authenticated map-pack loader.
export function setOfflineMapProvider(next:OfflineMapProvider):void {provider=next;}
export interface OfflineDownload {url:string;filename:string;warning:string}
export async function exportOfflineTrip(trip:Trip,onProgress?:(text:string)=>void,isCurrent:()=>boolean=()=>true):Promise<OfflineDownload|undefined> {
 const snapshot=structuredClone(trip);
 onProgress?.('正在准备全程与每天的离线地图…');
 let maps:OfflineMapAssets;
 try{maps=normalizeOfflineMaps(await provider(snapshot,onProgress));}catch(e){
  if(e instanceof ApiError&&(e.status===401||e.status===403||e.status===404))throw e;
  maps={days:{},failures:[e instanceof Error?e.message:'地图准备失败']};
 }
 if(!isCurrent())return;
 const missing=snapshot.days.filter(d=>d.events.length&&!maps.days[d.id]);
 const incomplete=(snapshot.days.some(d=>d.events.length)&&!maps.overview)||missing.length>0;
 const warning=incomplete?'地图未完整载入：已生成日程与行李副本，缺失范围没有底图。'+(maps.failures?.length?' '+maps.failures.join('；'):''):'';
 onProgress?.('正在打包日程、地图与行李清单…');
 const html=renderOfflineTrip(snapshot,maps);
 const url=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'}));
 const anchor=document.createElement('a');
 anchor.href=url;anchor.download=(snapshot.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,100)||'旅程')+'-离线.html';
 anchor.hidden=true;document.body.append(anchor);
 try{anchor.click();onProgress?.('离线 HTML 已生成，请保存下载的文件。');}finally{anchor.remove();}
 return {url,filename:anchor.download,warning};
}
