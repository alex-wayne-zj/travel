import {useEffect,useState} from 'react';
import {Cloud,CloudDrizzle,CloudFog,CloudLightning,CloudRain,CloudSnow,CloudSun,Sun} from 'lucide-react';
import {api,type Trip} from './api';
import type {Day} from './model';
import './weather.css';

interface DailyWeather {status:'ready'|'past'|'future'|'no-location'|'unavailable';city:string;reference?:string;code?:number;low?:number;high?:number;precipitation?:number|null;updatedAt?:number;stale?:boolean}
export function weatherDescription(code:number):[string,typeof Sun] {
 if(code===0)return ['晴',Sun];
 if(code===1)return ['晴间多云',CloudSun];
 if(code===2)return ['多云',CloudSun];
 if(code===3)return ['阴',Cloud];
 if([45,48].includes(code))return ['雾',CloudFog];
 if([51,53,55].includes(code))return ['毛毛雨',CloudDrizzle];
 if([56,57,66,67].includes(code))return ['冻雨',CloudRain];
 if([61,63,65].includes(code))return [code===61?'小雨':code===63?'中雨':'大雨',CloudRain];
 if([71,73,75,77].includes(code))return ['雪',CloudSnow];
 if([80,81,82].includes(code))return ['阵雨',CloudRain];
 if([85,86].includes(code))return ['阵雪',CloudSnow];
 if([95,96,99].includes(code))return ['雷雨',CloudLightning];
 return ['天气状况未知',Cloud];
}
export default function WeatherCard({trip,day}:{trip:Trip;day:Day}) {
 const key=`${trip.id}/${trip.version}/${day.id}`;
 const [state,setState]=useState<{key:string;data:DailyWeather}|null>(null);
 useEffect(()=>{
  let cancelled=false;
  const load=()=>api<DailyWeather>(`/trips/${encodeURIComponent(trip.id)}/weather/${encodeURIComponent(day.id)}`).then(data=>{if(!cancelled)setState({key,data});}).catch(()=>{if(!cancelled)setState({key,data:{status:'unavailable',city:day.city}});});
  void load();
  const timer=window.setInterval(()=>{if(!document.hidden)void load();},3600000);
  return()=>{cancelled=true;window.clearInterval(timer);};
 },[key]);
 const data=state?.key===key?state.data:null;
 const ready=data?.status==='ready';
 const [description,Icon]=weatherDescription(data?.code??-1);
 const message=!data?'正在获取天气…':data.status==='future'?'尚未进入预报期':data.status==='past'?'已过预报日期':data.status==='no-location'?'添加地点后显示天气':'天气暂不可用';
 let updated='';
 if(data?.stale&&data.updatedAt){try{updated=new Intl.DateTimeFormat('zh-CN',{timeZone:trip.timezone,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(data.updatedAt*1000));}catch{updated='时间暂不可用';}}
 return <div className="weather-card" role="group" aria-label="当天天气" title={data?.reference?`预报参考地点：${data.reference}`:undefined}>
  <Icon size={19} aria-hidden="true"/>
  <div className="weather-content">
   <small className="weather-location" title={day.city}>{day.city||'当天地点'}</small>
   {ready?<><strong>{description}<span>{Math.round(data.low!)}–{Math.round(data.high!)}°C</span></strong><span className="weather-rain">降水 {data.precipitation==null?'暂无':`${Math.round(data.precipitation)}%`}</span></>:<strong className="weather-status" role="status">{message}</strong>}
   <small className="weather-source"><a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a>{data?.stale&&<span title={`最近更新 ${updated}（旅程时区）`}> · 缓存数据</span>}</small>
  </div>
 </div>;
}
