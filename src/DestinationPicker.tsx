import {useId,useState,useLayoutEffect} from 'react';
import {createPortal} from 'react-dom';
import {ChevronDown,X} from 'lucide-react';
import {countries,destinationText,type DestinationChoice} from './destinations';
import {useFieldPopover} from './useFieldPopover';

export default function DestinationPicker({value,onChange,onBlur,error}:{value:DestinationChoice;onChange:(value:DestinationChoice)=>void;onBlur:()=>void;error?:string}){
 const id=useId(),[query,setQuery]=useState(''),popup=useFieldPopover(onBlur);
 function toggle(country:string){onChange({...value,ids:value.ids.includes(country)?value.ids.filter(id=>id!==country):[...value.ids,country]});}
 useLayoutEffect(()=>{if(popup.open){const selector=window.innerWidth<=700||window.matchMedia('(pointer: coarse)').matches?'button':'input[type=search]';popup.panel.current?.querySelector<HTMLElement>(selector)?.focus();}},[popup.open]);
 const label=destinationText(value),matches=countries.filter(c=>c.name.includes(query.trim()));
 return <div className="destination-field" ref={popup.field}>
  <span className="field-label" id={id}>目的地国家 <small>可多选</small></span>
  <button ref={popup.trigger} className="country-trigger" type="button" aria-labelledby={id} aria-haspopup="dialog" aria-expanded={popup.open} aria-controls={id+'-options'} aria-invalid={!!error} aria-describedby={id+'-value '+id+'-error'} onClick={()=>popup.open?popup.close():popup.setOpen(true)} onBlur={e=>{if(!popup.field.current?.contains(e.relatedTarget)&&!popup.panel.current?.contains(e.relatedTarget))onBlur();}}><span id={id+'-value'} className={!label?'field-placeholder':'selected-countries'}>{label?label.split('、').map((name,index)=><span className="country-chip" key={index}>{name}</span>):'选择出行国家'}</span><ChevronDown size={16}/></button>
  {value.other&&<label className="other-destination">其他国家<input maxLength={160} value={value.otherName} onChange={e=>onChange({...value,otherName:e.target.value})} onBlur={onBlur} placeholder="例如 泰国、中国"/></label>}
  <p className="field-feedback" id={id+'-error'} aria-live="polite">{error||' '}</p>
  {popup.open&&createPortal(<div className="country-popover field-popover" ref={popup.panel} role="dialog" aria-label="选择目的地国家" id={id+'-options'} style={popup.position} onKeyDown={popup.panelTab}>
   <div className="popover-heading"><strong>想去哪些国家？</strong><button type="button" aria-label="关闭国家选择" onClick={()=>popup.close(true)}><X size={16}/></button></div>
   <input className="country-search" type="search" aria-label="查找国家" placeholder="搜索常用国家" value={query} onChange={e=>setQuery(e.target.value)}/>
   <div className="country-options">{matches.map(c=><label key={c.id}><input type="checkbox" checked={value.ids.includes(c.id)} onChange={()=>toggle(c.id)}/>{c.name}</label>)}{matches.length===0&&<p className="country-empty">未找到常用国家，可选择“其他国家”。</p>}</div>
   <div className="country-popover-footer"><label><input type="checkbox" checked={value.other} onChange={e=>onChange({...value,other:e.target.checked})}/>其他国家</label><button className="popover-done" type="button" onClick={()=>popup.close(true)}>完成</button></div>
  </div>,document.body)}
 </div>;
}
