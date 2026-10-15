import type {PickDetails} from './map-import';
import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Menu,Plus,Luggage,Map,PenLine,LogOut,Settings,X,Download,Users} from 'lucide-react';
import {api,sessionToken,tripInput,type Session,type Trip,type TripSummary,type Template,type TripInput} from './api';
import PackingPage from './Packing';
import AnimatedPanel from './AnimatedPanel';
import InviteSettings from './InviteSettings';
import Logo from './Logo';
import {ConfirmationProvider,useConfirmation} from './ConfirmDialog';
import {useTimedMessage} from './useTimedMessage';
import './style.css';
import './app.css';
const Journey=lazy(()=>import('./Journey'));
const Editor=lazy(()=>import('./Editor'));
const MapPicker=lazy(()=>import('./MapPicker'));
type View='journey'|'packing'|'edit'|'new'|'settings'|'invites';
function Login({onLogin,initialSession}:{onLogin:(s:Session)=>void;initialSession?:Session}){
 const [mode,setMode]=useState<'admin'|'friend'>(initialSession?.role||'admin');
 const [username,setUsername]=useState(initialSession?.username||'admin'),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 return <div className="login-page"><form className="login-card" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{onLogin(await api<Session>(mode==='admin'?'/login':'/invite-login','POST',mode==='admin'?{username,password}:{name:username,code:password}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}><Logo size={48}/><small>YOUR OWN LITTLE ATLAS</small><h1>把期待，写成旅途。</h1><p>想去的地方，想吃的味道，<br/>和那些值得提前记下的小事。</p><div className="login-modes" aria-label="登录方式">{(['admin','friend'] as const).map(m=><button type="button" key={m} aria-pressed={mode===m} onClick={()=>{setMode(m);setUsername(m==='admin'?'admin':'');setPassword('');setError('');}}>{m==='friend'?'朋友入口':'管理员'}</button>)}</div><label>{mode==='friend'?'朋友的名字':'账号'}<input name="username" autoComplete="username" required maxLength={80} value={username} onChange={e=>setUsername(e.target.value)}/></label><label>{mode==='friend'?'邀请码':'密码'}<input name="password" type="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={e=>setPassword(e.target.value)}/></label><AnimatedPanel open={!!error}><p className="error" role="alert">{error}</p></AnimatedPanel><button className="solid" disabled={busy}>{busy?'正在进入…':'进入我的旅途'}</button><small>连续 5 次登录失败，将锁定 15 分钟。</small></form></div>;
}
function PasswordPage({onSession,session}:{onSession:(s:Session)=>void;session:Session}){
 const minimum=session.role==='friend'?8:12;
 const [current,setCurrent]=useState(''),[next,setNext]=useState(''),[repeat,setRepeat]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[success,setSuccess]=useState(false);
 return <section className="page-content"><form className="settings-form" onSubmit={async e=>{e.preventDefault();if(next!==repeat){setError('两次输入的新密码不一致');return;}setBusy(true);setError('');try{onSession(await api<Session>('/password','POST',{currentPassword:current,newPassword:next}));setCurrent('');setNext('');setRepeat('');setSuccess(true);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}><h1>账号设置</h1><p>修改密码后，其他设备的登录会失效。</p><label>当前密码<input type="password" autoComplete="current-password" required value={current} onChange={e=>setCurrent(e.target.value)}/></label><label>新{session.role==='friend'?'邀请码':'密码'} · 至少 {minimum} 字符<input type="password" autoComplete="new-password" minLength={minimum} maxLength={1024} required value={next} onChange={e=>setNext(e.target.value)}/></label><label>再次输入<input type="password" autoComplete="new-password" minLength={minimum} maxLength={1024} required value={repeat} onChange={e=>setRepeat(e.target.value)}/></label><AnimatedPanel open={!!error}><p className="error" role="alert">{error}</p></AnimatedPanel><AnimatedPanel open={success}><p role="status">密码已更新</p></AnimatedPanel><button className="solid" disabled={busy}>{busy?'保存中…':'更新密码'}</button></form></section>;
}
function App(){
 const confirm=useConfirmation();
 const [editorDirty,setEditorDirty]=useState(false);
 const [session,setSession]=useState<Session|null>(null),[trips,setTrips]=useState<TripSummary[]>([]),[trip,setTrip]=useState<Trip|null>(null),[template,setTemplate]=useState<Template|null>(null),[view,setView]=useState<View>('journey'),[sidebar,setSidebar]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const [reauth,setReauth]=useState(false);
 const transientError=useTimedMessage(error);
 const displayedError=/地图|底图|map resource/i.test(error)?transientError:error;
 const [download,setDownload]=useState<import('./offline-export').OfflineDownload|null>(null);
 const visibleDownload=useTimedMessage(download?.url||'');
 useEffect(()=>()=>{if(download)URL.revokeObjectURL(download.url);},[download]);
 const [exporting,setExporting]=useState(false),[exportProgress,setExportProgress]=useState('');
 const identity=useRef(''),generation=useRef(0),exportSequence=useRef(0);
 function clearDownload(){++exportSequence.current;setDownload(null);setExporting(false);setExportProgress('');}
 const renderGeneration=generation.current;
 const sessionIdentity=session?.authenticated?session.accountId||`${session.role||'admin'}:${session.username}`:'';
 const [packingDirty,setPackingDirty]=useState(false);
 const [pick,setPick]=useState<{lat:number;lng:number;onConfirm:(lat:number,lng:number,details?:PickDetails)=>void}|null>(null);
 const workspace=useRef<HTMLDivElement>(null),drawer=useRef<HTMLElement>(null),trigger=useRef<HTMLButtonElement>(null),sequence=useRef(0);
 const [mobile,setMobile]=useState(()=>matchMedia('(max-width:900px)').matches);
 useEffect(()=>{const m=matchMedia('(max-width:900px)');const change=()=>setMobile(m.matches);m.addEventListener('change',change);return()=>m.removeEventListener('change',change);},[]);
 function accept(s:Session){const next=s.authenticated?s.accountId||`${s.role||'admin'}:${s.username}`:'';if(next!==identity.current){identity.current=next;++generation.current;++sequence.current;clearDownload();setTrips([]);setTrip(null);setTemplate(null);setSidebar(false);setPick(null);setPackingDirty(false);setEditorDirty(false);setView('journey');setLoading(false);setError('');}sessionToken(s);setReauth(false);setSession(s);}
 useEffect(()=>{const handler=()=>{setSidebar(false);setReauth(true);};window.addEventListener('travel:reauth',handler);return()=>window.removeEventListener('travel:reauth',handler);},[]);
 useEffect(()=>{if(!reauth)return;const nodes=[workspace.current].filter((x):x is HTMLDivElement=>!!x);for(const n of nodes)n.inert=true;const form=document.querySelector<HTMLElement>('.reauth-dialog form');form?.querySelector<HTMLElement>('input')?.focus();function key(e:KeyboardEvent){if(e.key!=='Tab'||!form)return;const els=Array.from(form.querySelectorAll<HTMLElement>('input,button')).filter(x=>!x.hasAttribute('disabled'));const first=els[0],last=els[els.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}document.addEventListener('keydown',key);return()=>{for(const n of nodes)n.inert=false;document.removeEventListener('keydown',key);};},[reauth]);
 useEffect(()=>{api<Session>('/session').then(accept).catch(e=>{setError((e as Error).message);setSession({authenticated:false});});},[]);
 async function load(id:string){const request=++sequence.current;clearDownload();setLoading(true);setError('');try{const t=await api<Trip>('/trips/'+id);if(request===sequence.current){setTrip(t);setView('journey');}}catch(e){if(request===sequence.current)setError((e as Error).message);}finally{if(request===sequence.current)setLoading(false);}}
 async function refresh(select?:string){const owner=identity.current,epoch=generation.current;try{const [list,base]=await Promise.all([api<{trips:TripSummary[]}>('/trips'),api<Template>('/packing-template')]);if(owner!==identity.current||epoch!==generation.current)return;setTrips(list.trips);setTemplate(base);if(select||list.trips[0])await load(select||list.trips[0].id);else setTrip(null);}catch(e){if(owner===identity.current&&epoch===generation.current)setError((e as Error).message);}}
 useEffect(()=>{if(session?.authenticated)void refresh();},[sessionIdentity]);
 useEffect(()=>{if(!(sidebar&&mobile)||reauth)return;const previous=document.activeElement as HTMLElement;const background=workspace.current!;background.inert=true;drawer.current?.querySelector<HTMLElement>('button')?.focus();function key(e:KeyboardEvent){if(document.querySelector('.confirmation-overlay'))return;if(e.key==='Escape'){setSidebar(false);return;}if(e.key==='Tab'){const elements=Array.from(drawer.current!.querySelectorAll<HTMLElement>('button,a,input')).filter(e=>!e.hasAttribute('disabled'));const first=elements[0],last=elements[elements.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}}document.addEventListener('keydown',key);return()=>{background.inert=false;document.removeEventListener('keydown',key);previous?.focus();};},[sidebar,mobile,reauth]);
 function changed(t:Trip){if(identity.current!==sessionIdentity||generation.current!==renderGeneration)return;clearDownload();setTrip(t);setTrips(old=>[...old.filter(x=>x.id!==t.id),t].sort((a,b)=>b.updatedAt-a.updatedAt));}
 async function guardLeave(action:()=>void|Promise<void>,message='未保存的修改会丢失。你可以继续编辑，或放弃修改后离开。'){const epoch=generation.current;if((editorDirty||packingDirty)&&!await confirm({title:'离开编辑页？',message,confirmLabel:'放弃修改并离开'}))return;if(epoch!==generation.current)return;await action();}
 function go(v:View){if(v===view)return;void guardLeave(()=>{setEditorDirty(false);setPackingDirty(false);setView(v);if(mobile)setSidebar(false);});}
 async function save(input:TripInput){if(view==='new'&&template)input={...input,packing:{...input.packing,baseItems:structuredClone(template.items),baseNotes:template.notes}};const t=await api<Trip>(view==='new'?'/trips':'/trips/'+trip!.id,view==='new'?'POST':'PUT',input);if(identity.current!==sessionIdentity||generation.current!==renderGeneration)return;changed(t);setView('journey');}
 async function remove(){if(!trip||!await confirm({title:'删除这趟旅途？',message:`将删除「${trip.name}」及其行李记录，此操作无法撤销。`,confirmLabel:'删除旅途',dangerous:true}))return;const owner=identity.current,epoch=generation.current;setLoading(true);setError('');try{await api('/trips/'+trip.id,'DELETE',{version:trip.version});if(owner!==identity.current||epoch!==generation.current)return;setTrip(null);await refresh();}catch(e){if(owner===identity.current&&epoch===generation.current)setError((e as Error).message);}finally{if(owner===identity.current&&epoch===generation.current)setLoading(false);}}
 async function exportPlan(){
  if(!trip||exporting)return;
  const owner=identity.current,epoch=generation.current,ticket=++exportSequence.current;
  const current=()=>identity.current===owner&&generation.current===epoch&&exportSequence.current===ticket;
  setExporting(true);setExportProgress('正在打包离线行程…');setError('');setDownload(null);
  try{const {exportOfflineTrip}=await import('./offline-export');if(!current())return;
   const file=await exportOfflineTrip(trip,p=>{if(current())setExportProgress(p);},current);
   if(file){if(current()){setDownload(file);if(file.warning)setError(file.warning);}else URL.revokeObjectURL(file.url);}
  }catch(e){if(current())setError((e as Error).message);}
  finally{if(current()){setExporting(false);setExportProgress('');}}
 }

 if(!session)return <div className="center-message" role="status">正在打开旅途…</div>;
 if(!session.authenticated)return <><Login onLogin={accept}/>{error&&<p className="login-error" role="alert">{error}</p>}</>;
 return <div className={`app-shell ${sidebar?'sidebar-open':''}`}>
 {mobile&&<button className="drawer-backdrop" aria-label="关闭旅途列表" disabled={!sidebar} aria-hidden={!sidebar} onClick={()=>setSidebar(false)}/>}
 {<aside inert={!sidebar||reauth} aria-hidden={!sidebar} className="history" ref={drawer} aria-label="旅途列表"><div className="history-heading"><span><Logo size={25}/> 我的旅途</span><button aria-label="关闭旅途列表" onClick={()=>setSidebar(false)}><X size={18}/></button></div><button className="new-trip" onClick={()=>go('new')}><Plus size={16}/> 新的旅途</button><div className="history-list">{trips.map(t=><button key={t.id} aria-current={t.id===trip?.id?'true':undefined} onClick={()=>void guardLeave(async()=>{setEditorDirty(false);setPackingDirty(false);await load(t.id);if(mobile)setSidebar(false);})}><strong>{t.name}</strong><small>{t.startDate} — {t.endDate}</small></button>)}{!trips.length&&<p>还没有旅途，写下第一份期待吧。</p>}</div><div className="history-footer"><small className="account-name">{session.displayName||session.username} · 私人空间</small>{session.role==='admin'&&<button onClick={()=>go('invites')}><Users size={16}/> 朋友与邀请码</button>}<button onClick={()=>go('settings')}><Settings size={16}/> 账号设置</button><button onClick={()=>void guardLeave(async()=>{const epoch=generation.current;try{await api('/logout','POST');if(epoch===generation.current)accept({authenticated:false});}catch(e){if(epoch!==generation.current)return;if((e as {status?:number}).status===401)accept({authenticated:false});else setError((e as Error).message);}})}><LogOut size={16}/> 退出登录</button></div></aside>}
 <div className="workspace" ref={workspace}><nav className="app-nav" aria-label="旅途导航"><button ref={trigger} aria-label="展开旅途列表" aria-expanded={sidebar} onClick={()=>setSidebar(!sidebar)}><Menu size={18}/></button><button className={view==='journey'?'selected':''} onClick={()=>go('journey')}><Map size={15}/> 行程</button><button disabled={!trip} className={view==='packing'?'selected':''} onClick={()=>go('packing')}><Luggage size={15}/> 行李与提醒</button><button disabled={!trip} className={view==='edit'?'selected':''} onClick={()=>go('edit')}><PenLine size={15}/> 编辑</button><button className="nav-export" aria-label="导出离线 HTML" title="导出离线 HTML" disabled={!trip||exporting||view!=='journey'} onClick={()=>void exportPlan()}><Download size={17}/></button><button className="nav-new" aria-label="创建新旅途" onClick={()=>go('new')}><Plus size={17}/></button></nav>
 <AnimatedPanel open={!!download&&visibleDownload===download.url} className="app-notice">{download&&<div className="export-ready" role="status"><span>离线行程已生成，包含每天活动、备选与行李</span><a href={download.url} download={download.filename}>保存离线文件</a><span>iPhone 可打开后通过分享存到“文件”。</span></div>}</AnimatedPanel><AnimatedPanel open={exporting} className="app-notice"><div className="export-progress" role="status">{exportProgress}</div></AnimatedPanel><AnimatedPanel open={!!displayedError} className="app-notice"><div className="app-error" role="alert">{displayedError}<button onClick={()=>void guardLeave(()=>refresh(trip?.id))}>重试</button></div></AnimatedPanel>
 {loading?<div className="center-message" role="status">正在整理旅途…</div>:<Suspense fallback={<div className="center-message" role="status">正在展开页面…</div>}>
 {view==='invites'&&session.role==='admin'?<InviteSettings/>:view==='settings'?<PasswordPage onSession={accept} session={session}/>:view==='new'||view==='edit'?<><Editor key={view+'-'+(view==='edit'?trip?.id:'new')} trip={view==='new'?null:trip} onSave={save} onCancel={()=>go('journey')} onDirty={setEditorDirty} onDelete={view==='edit'?()=>void remove():undefined} onPick={(lat,lng,onConfirm)=>setPick({lat,lng,onConfirm})}/></>:trip?view==='packing'&&template?<PackingPage key={trip.id} trip={trip} template={template} onSaved={changed} onTemplate={t=>{if(identity.current===sessionIdentity&&generation.current===renderGeneration)setTemplate(t);}} onDirty={setPackingDirty}/>:<Journey key={trip.id+'-'+trip.version} trip={trip} onEdit={()=>go('edit')}/>:<section className="empty-trip"><Logo size={55}/><h1>旅途，从一个念头开始。</h1><p>不必安排每一分钟，先写下想去和想吃。</p><button className="solid" onClick={()=>go('new')}>创建第一趟旅途</button></section>}
 </Suspense>}{pick&&<Suspense fallback={<div className="picker-loading" role="status">正在加载选点地图…</div>}><MapPicker lat={pick.lat} lng={pick.lng} onCancel={()=>setPick(null)} onConfirm={(lat,lng,details)=>{pick.onConfirm(lat,lng,details);setPick(null);}}/></Suspense>}</div>{reauth&&<div className="reauth-dialog" role="dialog" aria-modal="true" aria-label="登录过期，请重新登录，草稿已保留"><Login onLogin={accept} initialSession={session}/></div>}</div>;
}
createRoot(document.getElementById('root')!).render(<ConfirmationProvider><App/></ConfirmationProvider>);
