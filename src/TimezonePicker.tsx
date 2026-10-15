import {countryZones,fixedZones} from './destinations';

export function validTimezone(value:string){try{if(!value)return false;new Intl.DateTimeFormat('zh-CN',{timeZone:value});return true;}catch{return false;}}
function offsetLabel(value:string,date:string){
 if(!validTimezone(value))return 'GMT+00:00';
 const parsed=new Date(`${date}T12:00:00Z`);
 const label=new Intl.DateTimeFormat('en-US',{timeZone:value,timeZoneName:'longOffset',hour:'2-digit'}).formatToParts(Number.isFinite(parsed.getTime())?parsed:new Date()).find(p=>p.type==='timeZoneName')?.value;
 return label==='GMT'?'GMT+00:00':label||'GMT+00:00';
}
export default function TimezonePicker({value,onChange,date,countryIds,other,error,onBlur}:{value:string;onChange:(zone:string)=>void;date:string;countryIds:string[];other:boolean;error?:string;onBlur:()=>void}){
 const local=countryIds.length===1&&!other;
 const options=[...fixedZones];
 // Existing trips keep their stored timezone until a destination or timezone is explicitly changed.
 if(value&&!options.some(zone=>zone.value===value))options.unshift({value,label:offsetLabel(value,date)});
 const label=countryZones(countryIds).find(zone=>zone.value===value)?.label||value;
 return <section className="timezone-field" aria-label="行程时区">
  <div className="timezone-heading"><span className="field-label">行程时区<span className="required-mark" aria-hidden="true">必填</span></span><span className="field-label">{local?'当地时区':'东 / 西时区'}</span></div>
  {local?<output className="timezone-value" aria-label="绑定时区">{label}</output>:<select aria-label="行程时区" aria-invalid={!!error} aria-describedby="timezone-feedback" value={value} onBlur={onBlur} onChange={e=>onChange(e.target.value)}><option value="" disabled>请选择时区</option>{options.map(zone=><option key={zone.value} value={zone.value}>{zone.label}</option>)}</select>}
  <div className="timezone-help">{offsetLabel(value,date)}；此旅程统一使用一个时区。</div>
  <p className="field-feedback" id="timezone-feedback" aria-live="polite">{error||' '}</p>
 </section>;
}
