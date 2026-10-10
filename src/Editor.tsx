import {useEffect,useRef,useState} from 'react';
import type {Trip,TripInput} from './api';
import {isAlternative,type Day,type Event} from './model';
import {useConfirmation} from './ConfirmDialog';
import EditorActivities from './EditorActivities';
import TripBasics,{basicsErrors,type BasicsValues} from './TripBasics';
import {readDestination,destinationText} from './destinations';
import {slots,allowed,editorKind} from './editor-options';
import {dates,validateEvents} from './editor-validation';
import './editor.css';

const uid=()=>crypto.randomUUID();
type EditorProps={trip:Trip|null;onSave:(input:TripInput)=>Promise<void>;onCancel:()=>void;onPick?:(lat:number,lng:number,onConfirm:(lat:number,lng:number)=>void)=>void;onDirty?:(dirty:boolean)=>void;onDelete?:()=>void};
export default function Editor({trip,onSave,onCancel,onPick,onDirty,onDelete}:EditorProps){
 const confirm=useConfirmation(),errorRef=useRef<HTMLDivElement>(null);
 const [basics,setBasics]=useState<BasicsValues>(()=>({name:trip?.name||'',destinations:readDestination(trip?.destination||''),start:trip?.startDate||'',end:trip?.endDate||'',timezone:trip?.timezone||''}));
 const [days,setDays]=useState<Day[]>(()=>structuredClone(trip?.days||[]));
 const [selected,setSelected]=useState(0),[open,setOpen]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[submitted,setSubmitted]=useState(false),[applyMessage,setApplyMessage]=useState('');
 const initial=JSON.stringify({name:trip?.name||'',destination:trip?.destination||'',start:trip?.startDate||'',end:trip?.endDate||'',timezone:trip?.timezone||'',days:trip?.days||[]});
 const {name,start,end,timezone}=basics,destination=destinationText(basics.destinations);
 const dirty=JSON.stringify({name,destination,start,end,timezone,days})!==initial;
 useEffect(()=>{onDirty?.(dirty);return()=>onDirty?.(false);},[dirty,onDirty]);
 const day=days[selected];
 function reportError(message:string){setError(message);requestAnimationFrame(()=>{errorRef.current?.scrollIntoView({block:'nearest'});errorRef.current?.focus({preventScroll:true});});}
 function changeBasics(patch:Partial<BasicsValues>){setBasics(b=>({...b,...patch}));if('start'in patch||'end'in patch)setApplyMessage('');}
 async function applyDates(){
  setApplyMessage('');
  const errors=basicsErrors(basics);if(errors.start||errors.end)return;
  try{
   const next=dates(start,end);
   if(days.some(d=>!next.includes(d.date)&&d.events.length)&&!await confirm({title:'缩短旅程日期？',message:'日期范围外的日程将被移除。',confirmLabel:'应用新日期',dangerous:true}))return;
   setDays(next.map(date=>days.find(d=>d.date===date)||{id:uid(),date,city:'',title:'',events:[]}));setSelected(0);setOpen(null);
  }catch(e){setApplyMessage((e as Error).message||'日期未能应用，请重试。');}
 }
 function changeDay(patch:Partial<Day>){if(!day)return;const id=day.id;setDays(ds=>ds.map(d=>d.id===id?{...d,...patch}:d));}
 function changeEvent(id:string,patch:Partial<Event>){
  const current=day?.events.find(e=>e.id===id);if(!current)return;
  if(patch.slot&&patch.alternative===undefined)patch.alternative=isAlternative(current);
  if(patch.slot&&!allowed(patch.slot).includes(editorKind({...current,slot:patch.slot})))patch.kind=allowed(patch.slot)[0];
  if(patch.kind&&!['flight','train','taxi','walk'].includes(patch.kind))patch.to=undefined;
  changeDay({events:day.events.map(e=>e.id===id?{...e,...patch}:e)});
 }
 function add(slot:Event['slot']){
  if(!day)return;if(day.events.length>=40){reportError('每天最多 40 项活动。');return;}
  const event:Event={id:uid(),title:'',kind:['breakfast','lunch','dinner'].includes(slot||'')?'food':slot==='stay'?'hotel':slot==='transport'?'train':'visit',slot,alternative:false,lat:NaN,lng:NaN,note:''};
  changeDay({events:[...day.events,event]});setOpen(event.id);setError('');
 }
 async function save(){
  setSubmitted(true);setError('');setApplyMessage('');
  if(Object.keys(basicsErrors(basics)).length){requestAnimationFrame(()=>{const invalid=document.querySelector<HTMLElement>('.editor-meta [aria-invalid=true]');invalid?.scrollIntoView({block:'nearest'});invalid?.focus({preventScroll:true});});return;}
  try{
   const range=dates(start,end);
   if(range.length!==days.length||range.some((date,i)=>days[i]?.date!==date)){setApplyMessage('日期已变更，请点击“应用”更新日程。');return;}
   validateEvents(days);setBusy(true);
   await onSave({name:name.trim(),destination,startDate:start,endDate:end,timezone:timezone.trim(),days,packing:trip?.packing||{extraItems:[],checkedIds:[],hiddenBaseIds:[],notes:''},...(trip?{version:trip.version}:{})});
  }catch(e){reportError((e as Error).message||'保存失败，草稿已保留。');}finally{setBusy(false);}
 }
 return <section className="trip-editor" aria-label="编辑旅程"><div className="editor-container">
  <div className="editor-heading"><div><h1>{trip?'编辑旅程':'新建旅程'}</h1><p>先定目的地与日期，再安排每天想去与想吃的地方。</p></div><div className="editor-actions"><button disabled={busy} onClick={()=>{if(!busy)onCancel();}}>取消</button><button className="editor-save" disabled={busy} onClick={save}>{busy?'保存中…':'保存旅程'}</button></div></div>
  <TripBasics value={basics} onChange={changeBasics} onApply={applyDates} busy={busy} submitted={submitted} applyMessage={applyMessage} existing={!!trip}/>
  {!day?<div className="editor-start"><h2>开始安排每天的行程</h2><p>选好起止日期，点击“应用”生成每天的安排。</p></div>:<div className="editor-workspace">
   <nav className="editor-dates" aria-label="选择编辑日期">{days.map((d,i)=><button disabled={busy} key={d.id} aria-current={selected===i?'date':undefined} onClick={()=>{setSelected(i);setOpen(null);}}><small>DAY {i+1} · {d.date.slice(5)}</small><strong>{d.city||'待安排'}</strong></button>)}</nav>
   <fieldset disabled={busy} className="editor-day">
    <div className="editor-day-meta"><label>当天城市<input maxLength={200} value={day.city} onChange={e=>changeDay({city:e.target.value})}/></label><label>当天主题<input maxLength={300} value={day.title} onChange={e=>changeDay({title:e.target.value})} placeholder="例如 老城与河畔漫步"/></label></div>
    <div className="editor-add">{slots.map(([slot,label])=><button key={slot} onClick={()=>add(slot)}>＋ {label}</button>)}</div>
    {day.events.length===0&&<p className="editor-empty">这一天还没有活动。可先添加活动与想吃的地方。</p>}
    <EditorActivities key={day.id} events={day.events} open={open} onOpen={setOpen} onOrder={events=>changeDay({events})} onChange={changeEvent} onDelete={id=>{changeDay({events:day.events.filter(e=>e.id!==id)});setOpen(null);}} onPick={onPick} busy={busy}/>

   </fieldset>
  </div>}
  {error&&<div className="editor-status" ref={errorRef} tabIndex={-1} role="alert"><p className="editor-error">{error} <span>输入仍保留在此页。</span></p></div>}
  {onDelete&&<div className="editor-footer"><button disabled={busy} className="editor-delete-trip" onClick={onDelete}>删除这趟旅途</button></div>}
 </div></section>;
}
