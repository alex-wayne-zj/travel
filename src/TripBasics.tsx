import {useState} from 'react';
import AnimatedPanel from './AnimatedPanel';
import DatePicker from './DatePicker';
import DestinationPicker from './DestinationPicker';
import TimezonePicker,{validTimezone} from './TimezonePicker';
import {countryZones,fixedZones,destinationText,type DestinationChoice} from './destinations';
import {dates} from './editor-validation';
import './trip-basics.css';

export interface BasicsValues {name:string;destinations:DestinationChoice;start:string;end:string;timezone:string}
export type BasicsErrors=Partial<Record<keyof BasicsValues,string>>;
export function basicsErrors(value:BasicsValues):BasicsErrors {
 const errors:BasicsErrors={};
 if(!value.name.trim())errors.name='请填写旅程名称。';
 if(!destinationText(value.destinations))errors.destinations='请选择至少一个目的地国家。';
 if(value.destinations.other&&!value.destinations.otherName.trim())errors.destinations='请填写其他国家名称。';
 if(destinationText(value.destinations).length>200)errors.destinations='目的地名称合计不能超过 200 字。';
 for(const field of ['start','end'] as const){if(!value[field])errors[field]=`请选择${field==='start'?'开始':'结束'}日期。`;else try{dates(value[field],value[field]);}catch{errors[field]='请选择有效日期。';}}
 if(!errors.start&&!errors.end){if(value.end<value.start)errors.end='结束日期不能早于开始日期。';else try{dates(value.start,value.end);}catch{errors.end='旅程最多安排 60 天。';}}
 if(!validTimezone(value.timezone))errors.timezone='请选择有效的行程时区。';
 return errors;
}

export default function TripBasics({value,onChange,onApply,busy,submitted,applyMessage}:{value:BasicsValues;onChange:(patch:Partial<BasicsValues>)=>void;onApply:()=>void;busy:boolean;submitted:boolean;applyMessage:string;existing:boolean}){
 const [touched,setTouched]=useState<Partial<Record<keyof BasicsValues,boolean>>>({});
 const errors=basicsErrors(value),feedback=(key:keyof BasicsValues)=>submitted||touched[key]?errors[key]:undefined;
 const touch=(key:keyof BasicsValues)=>setTouched(t=>({...t,[key]:true}));
 function destinations(selection:DestinationChoice){
  const next={...selection,original:undefined};
  const patch:Partial<BasicsValues>={destinations:next};
  patch.timezone=next.ids.length===1&&!next.other?countryZones(next.ids)[0]?.value||'':
   next.ids.length||next.other?(fixedZones.some(zone=>zone.value===value.timezone)?value.timezone:'Etc/UTC'):'';
  onChange(patch);
 }
 const showTimezone=value.destinations.ids.length>0||value.destinations.other;
 return <fieldset disabled={busy} className="editor-meta" aria-label="旅程基本信息">
  <div className="basic-name"><label>旅程名称<input maxLength={160} value={value.name} onChange={e=>onChange({name:e.target.value})} onBlur={()=>touch('name')} aria-invalid={!!feedback('name')} aria-describedby="name-feedback" placeholder="例如 德国十日"/></label><p className="field-feedback" id="name-feedback" aria-live="polite">{feedback('name')||' '}</p></div>
  <DestinationPicker value={value.destinations} onChange={destinations} onBlur={()=>touch('destinations')} error={feedback('destinations')}/>
  <div className="basics-dates"><DatePicker label="开始日期" value={value.start} onChange={start=>{onChange({start});if(value.end)touch('end');}} onValidate={()=>touch('start')} error={feedback('start')} rangeStart={value.start} rangeEnd={value.end} disabled={busy}/><DatePicker label="结束日期" value={value.end} onChange={end=>onChange({end})} onValidate={()=>touch('end')} error={feedback('end')} rangeStart={value.start} rangeEnd={value.end} disabled={busy}/></div>
  <AnimatedPanel open={showTimezone} className="timezone-reveal"><TimezonePicker value={value.timezone} onChange={timezone=>{onChange({timezone});touch('timezone');}} date={value.start} countryIds={value.destinations.ids} other={value.destinations.other} error={feedback('timezone')} onBlur={()=>touch('timezone')}/></AnimatedPanel>
  <div className="basics-apply"><p className="apply-feedback" aria-live="polite">{applyMessage||' '}</p><button type="button" onClick={()=>{touch('start');touch('end');onApply();}}>应用</button></div>
 </fieldset>;
}
