import {useEffect,useId,useLayoutEffect,useRef,useState,type KeyboardEvent} from 'react';
import {createPortal} from 'react-dom';
import {CalendarDays,ChevronLeft,ChevronRight,X} from 'lucide-react';
import AnimatedPanel from './AnimatedPanel';
import {useFieldPopover} from './useFieldPopover';
import './date-picker.css';

const dayMs=86400000;
const iso=(date:Date)=>date.toISOString().slice(0,10);
// setUTCFullYear avoids Date.UTC's special mapping of years 0–99 to 1900–1999.
function utcDate(year:number,month:number,day:number){const d=new Date(0);d.setUTCFullYear(year,month,day);d.setUTCHours(0,0,0,0);return d;}
function parse(value:string){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
 const date=new Date(value+'T00:00:00Z');
 return Number.isFinite(date.getTime())&&iso(date)===value?date:null;
}
function today(){const d=new Date();return utcDate(d.getFullYear(),d.getMonth(),d.getDate());}
const first=(date:Date)=>utcDate(date.getUTCFullYear(),date.getUTCMonth(),1);
function shiftMonth(date:Date,step:number){
 const index=Math.max(0,Math.min(119999,date.getUTCFullYear()*12+date.getUTCMonth()+step));
 const target=utcDate(Math.floor(index/12),index%12,1);
 const last=utcDate(target.getUTCFullYear(),target.getUTCMonth()+1,0).getUTCDate();
 target.setUTCDate(Math.min(date.getUTCDate(),last));return target;
}

export default function DatePicker({label,value,onChange,onValidate,error,rangeStart,rangeEnd,disabled=false}:{label:string;value:string;onChange:(date:string)=>void;onValidate:()=>void;error?:string;rangeStart:string;rangeEnd:string;disabled?:boolean}){
 const id=useId(),{open,present,expanded,setOpen,field,panel,trigger,position,close,panelTab}=useFieldPopover(onValidate);
 const [month,setMonth]=useState(()=>first(today())),[focused,setFocused]=useState(''),[manual,setManual]=useState(false);
 const manualInput=useRef<HTMLInputElement>(null);
 const shouldFocus=useRef(false);
 const currentToday=iso(today()),monthTitle=`${month.getUTCFullYear()}年${month.getUTCMonth()+1}月`;
 const offset=(month.getUTCDay()+6)%7;
 const cells=Array.from({length:42},(_,i)=>new Date(month.getTime()+(i-offset)*dayMs));
 function show(){
  setManual(false);const date=parse(value)||today();setMonth(first(date));setFocused(iso(date));shouldFocus.current=true;setOpen(true);
 }
 function choose(date:string){onChange(date);onValidate();close(true,false);}
 function navigate(step:number){setMonth(m=>shiftMonth(m,step));}
 function moveFocus(date:Date){if(date.getUTCFullYear()<0||date.getUTCFullYear()>9999)return;setFocused(iso(date));setMonth(first(date));shouldFocus.current=true;}
 function keydown(event:KeyboardEvent<HTMLButtonElement>,date:Date){
  let next:Date|undefined;
  const step:Record<string,number>={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7};
  if(event.key in step)next=new Date(date.getTime()+step[event.key]*dayMs);
  else if(event.key==='PageUp'||event.key==='PageDown')next=shiftMonth(date,event.key==='PageUp'?-1:1);
  else if(event.key==='Home'||event.key==='End')next=new Date(date.getTime()+((event.key==='Home'?0:6)-(date.getUTCDay()+6)%7)*dayMs);
  if(next){event.preventDefault();moveFocus(next);}
 }
 useLayoutEffect(()=>{
  if(open&&shouldFocus.current){shouldFocus.current=false;panel.current?.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus({preventScroll:true});}
 },[open,focused,month]);
 useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
 useLayoutEffect(()=>{if(open&&manual)manualInput.current?.focus({preventScroll:true});},[open,manual]);
 const tabDate=cells.some(d=>iso(d)===focused)?focused:iso(month);
 return <div className="date-field" ref={field}>
  <span className="field-label" id={id}>{label}</span>
  <button className="date-value" ref={trigger} type="button" aria-labelledby={id} aria-describedby={id+'-value '+id+'-error'} aria-invalid={!!error} aria-haspopup="dialog" aria-expanded={open} aria-controls={id+'-calendar'} disabled={disabled} onClick={()=>open?close():show()} onBlur={e=>{if(!field.current?.contains(e.relatedTarget)&&!panel.current?.contains(e.relatedTarget))onValidate();}}><span id={id+'-value'} className={!value?'field-placeholder':''}>{value?value.replaceAll('-','/'):'请选择日期'}</span><CalendarDays size={17}/></button>
  <p className="field-feedback" id={id+'-error'} aria-live="polite">{error||' '}</p>
  {present&&createPortal(<div className={`date-calendar motion-popover${expanded?' expanded':''}`} aria-hidden={!open} inert={!open} ref={panel} id={id+'-calendar'} role="dialog" aria-label={`${label}日历`} style={position} onKeyDown={panelTab}>
   <div className="date-calendar-heading"><span>{label}</span><button type="button" aria-label="关闭日历" onClick={()=>close(true)}><X size={16}/></button></div>
   <div className="date-calendar-month"><button type="button" aria-label="上个月" disabled={month.getUTCFullYear()===0&&month.getUTCMonth()===0} onClick={()=>navigate(-1)}><ChevronLeft size={17}/></button><strong aria-live="polite">{monthTitle}</strong><button type="button" aria-label="下个月" disabled={month.getUTCFullYear()===9999&&month.getUTCMonth()===11} onClick={()=>navigate(1)}><ChevronRight size={17}/></button></div>
   <div className="date-calendar-grid" role="grid" aria-label={monthTitle}>
    <div role="row" className="date-calendar-week">{['一','二','三','四','五','六','日'].map(d=><span key={d} role="columnheader">{d}</span>)}</div>
    {Array.from({length:6},(_,week)=><div role="row" key={week} className="date-calendar-row">{cells.slice(week*7,week*7+7).map((d,index)=>{if(d.getUTCFullYear()<0||d.getUTCFullYear()>9999)return <span key={'empty-'+index} aria-hidden="true"/>;const date=iso(d),selected=date===value,inRange=!!parse(rangeStart)&&!!parse(rangeEnd)&&date>=rangeStart&&date<=rangeEnd;return <button type="button" role="gridcell" key={date} data-date={date} aria-label={date} aria-selected={selected} aria-current={date===currentToday?'date':undefined} tabIndex={date===tabDate?0:-1} className={[d.getUTCMonth()!==month.getUTCMonth()?'other-month':'',inRange?'in-range':'',selected?'selected':''].join(' ')} onFocus={()=>setFocused(date)} onKeyDown={e=>keydown(e,d)} onClick={()=>choose(date)}>{d.getUTCDate()}</button>;})}</div>)}
   </div>
   <AnimatedPanel open={manual}><label className="date-manual">手动输入{label}<input ref={manualInput} value={value} placeholder="YYYY-MM-DD" aria-invalid={!!error} onChange={e=>onChange(e.target.value)} onBlur={onValidate}/></label></AnimatedPanel>
   <div className="date-calendar-footer"><button type="button" aria-expanded={manual} onClick={()=>setManual(!manual)}>手动输入</button><button type="button" onClick={()=>choose(currentToday)}>今天</button></div>
  </div>,document.body)}
 </div>;
}
