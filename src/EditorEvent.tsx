import {isAlternative,planningSlot,type Event,type Kind} from './model';
import {allowed,editorKind,kinds,slots} from './editor-options';
import LocationEditor from './LocationEditor';
import AnimatedEventBody from './AnimatedEventBody';
import {useConfirmation} from './ConfirmDialog';

interface Props {
 event:Event;
 open:boolean;
 onToggle:()=>void;
 onChange:(patch:Partial<Event>)=>void;
 onDelete:()=>void;
 handle?:React.ReactNode;
 dragging?:boolean;
 onPick?:(lat:number,lng:number,onConfirm:(lat:number,lng:number)=>void)=>void;
}

export default function EditorEvent({event:e,open,onToggle,onChange,onDelete,onPick,handle,dragging}:Props){
 const confirm=useConfirmation();
 const slot=planningSlot(e);
 async function remove(){
  if(await confirm({
   title:'删除活动？',message:`删除“${e.title||'新活动'}”后，保存旅程时才会同步。`,
   confirmLabel:'移除活动',dangerous:true,
  }))onDelete();
 }

 return <article className={`editor-event${dragging?' sorting':''}`} data-event-id={e.id}>
  <div className="editor-event-header">{handle}
  <button className="editor-event-heading" aria-expanded={open} aria-controls={`event-body-${e.id}`} onClick={onToggle}>
   <span>{slots.find(s=>s[0]===slot)?.[1]||kinds[e.kind]}{isAlternative(e)?' · 备选':''}</span>
   <strong>{e.title||'新活动 · 待填写'}</strong><span>{open?'−':'＋'}</span>
  </button></div>
  <AnimatedEventBody open={open} id={`event-body-${e.id}`}><div className="editor-event-fields">
   <label className="editor-wide">名称
    <input maxLength={300} value={e.title} onChange={x=>onChange({title:x.target.value})}/>
   </label>
   <label>类型
    <select aria-label="类型" value={editorKind(e)} onChange={x=>onChange({kind:x.target.value as Kind})}>
     {allowed(slot).map(k=><option key={k} value={k}>{kinds[k]}</option>)}
    </select>
   </label>
   <label>时段
    <select aria-label="时段" value={slot} onChange={x=>onChange({slot:x.target.value as Event['slot']})}>
     {slots.map(([k,v])=><option key={k} value={k}>{v}</option>)}
    </select>
   </label>
   <label className="editor-wide editor-checkbox editor-backup">
    <input type="checkbox" checked={isAlternative(e)} onChange={x=>onChange({alternative:x.target.checked,slot})}/>
    作为备选<small>备选不会加入路线预览</small>
   </label>
   <LocationEditor lat={e.lat} lng={e.lng} label="活动位置" onChange={(lat,lng)=>onChange({lat,lng})} onPick={onPick}/>
   <label>开始时间（可选）
    <input type="time" value={e.time||''} onChange={x=>onChange({time:x.target.value||undefined})}/>
   </label>
   <label>结束时间（可选）
    <input type="time" value={e.endTime||''} onChange={x=>onChange({endTime:x.target.value||undefined})}/>
   </label>
   <label className="editor-wide">推荐词
    <textarea maxLength={5000} rows={2} value={e.recommendation||''} onChange={x=>onChange({recommendation:x.target.value})}/>
   </label>
   <label className="editor-wide">备注
    <textarea maxLength={5000} rows={2} value={e.note} onChange={x=>onChange({note:x.target.value})}/>
   </label>
   <label className="editor-wide">参考链接
    <input type="url" maxLength={500} value={e.sourceUrl||''} onChange={x=>onChange({sourceUrl:x.target.value||undefined})}/>
   </label>
   {['flight','train','taxi','walk'].includes(e.kind)&&<>
    <label className="editor-wide editor-checkbox">
     <input type="checkbox" checked={!!e.to} onChange={x=>onChange({to:x.target.checked?{name:'',lat:NaN,lng:NaN}:undefined})}/>
     添加交通终点
    </label>
    {e.to&&<>
     <label className="editor-wide">终点名称
      <input maxLength={300} value={e.to.name} onChange={x=>onChange({to:{...e.to!,name:x.target.value}})}/>
     </label>
     <LocationEditor lat={e.to.lat} lng={e.to.lng} label="交通终点" onChange={(lat,lng)=>onChange({to:{...e.to!,lat,lng}})} onPick={onPick}/>
    </>}
   </>}
   {e.kind==='hotel'&&<>
    <label>住宿状态
     <input maxLength={500} value={e.stayLabel||''} onChange={x=>onChange({stayLabel:x.target.value})} placeholder="待预订"/>
    </label>
    <label>全名
     <input maxLength={500} value={e.fullName||''} onChange={x=>onChange({fullName:x.target.value})}/>
    </label>
    <label className="editor-wide">地址
     <input maxLength={500} value={e.address||''} onChange={x=>onChange({address:x.target.value})}/>
    </label>
    <label>入住
     <input type="date" value={e.checkInDate||''} onChange={x=>onChange({checkInDate:x.target.value||undefined})}/>
    </label>
    <label>退房
     <input type="date" value={e.checkOutDate||''} onChange={x=>onChange({checkOutDate:x.target.value||undefined})}/>
    </label>
    <label>晚数
     <input type="number" min="1" max="60" value={e.nights??''} onChange={x=>onChange({nights:x.target.value?Number(x.target.value):undefined})}/>
    </label>
   </>}
   <button className="editor-delete editor-wide" onClick={()=>void remove()}>删除活动</button>
  </div></AnimatedEventBody>
 </article>;
}
