import type {Trip} from './api';
import {renderOfflineTrip} from './offline-template';
export interface OfflineDownload {url:string;filename:string;warning:string}
export async function exportOfflineTrip(trip:Trip,onProgress?:(text:string)=>void,isCurrent:()=>boolean=()=>true):Promise<OfflineDownload|undefined> {
 const snapshot=structuredClone(trip);
 if(!isCurrent())return;
 const warning='';
 onProgress?.('正在打包每天的活动、备选与行李清单…');
 const html=renderOfflineTrip(snapshot);
 if(!isCurrent())return;
 const url=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'}));
 const anchor=document.createElement('a');
 anchor.href=url;anchor.download=(snapshot.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,100)||'旅程')+'-离线.html';
 anchor.hidden=true;document.body.append(anchor);
 try{anchor.click();onProgress?.('离线 HTML 已生成，请保存下载的文件。');}finally{anchor.remove();}
 return {url,filename:anchor.download,warning};
}
