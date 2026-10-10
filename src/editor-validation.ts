import type {Day} from './model';

const dayMs=86400000;

export function dates(start:string,end:string):string[] {
 const a=Date.parse(`${start}T00:00:00Z`),b=Date.parse(`${end}T00:00:00Z`);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||
    !Number.isFinite(a)||!Number.isFinite(b)||
    new Date(a).toISOString().slice(0,10)!==start||new Date(b).toISOString().slice(0,10)!==end)
  throw Error('请填写有效的起止日期。');
 const count=(b-a)/dayMs+1;
 if(count<1||count>60)throw Error('旅程日期必须连续，长度为 1 至 60 天。');
 // All dates are calendar days; UTC keeps daylight-saving changes from shifting the range.
 return Array.from({length:count},(_,i)=>new Date(a+i*dayMs).toISOString().slice(0,10));
}

function validLocation(lat:number,lng:number):boolean {
 return Number.isFinite(lat)&&lat>=-90&&lat<=90&&Number.isFinite(lng)&&lng>=-180&&lng<=180;
}

export function validateEvents(days:Day[]):void {
 for(const day of days){
  for(const event of day.events){
   const prefix=`${day.date} · ${event.title||'未命名活动'}`;
   if(!event.title.trim())throw Error(`${prefix}：请填写名称。`);
   if(!validLocation(event.lat,event.lng))throw Error(`${prefix}：请在地图上选择活动位置。`);
   if(event.to&&(!event.to.name.trim()||!validLocation(event.to.lat,event.to.lng)))
    throw Error(`${prefix}：请填写终点名称并在地图上选择终点。`);
   if((event.time&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(event.time))||
      (event.endTime&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(event.endTime)))
    throw Error(`${prefix}：时间格式应为 HH:mm。`);
   if(event.time&&event.endTime&&event.endTime<event.time)
    throw Error(`${prefix}：结束时间不能早于开始时间。`);
   if(event.nights!==undefined&&(!Number.isInteger(event.nights)||event.nights<1||event.nights>60))
    throw Error(`${prefix}：住宿晚数应为 1 至 60。`);
   if(event.checkInDate)dates(event.checkInDate,event.checkInDate);
   if(event.checkOutDate)dates(event.checkOutDate,event.checkOutDate);
   if(event.checkInDate&&event.checkOutDate){
    const nights=(Date.parse(event.checkOutDate+'T00:00:00Z')-Date.parse(event.checkInDate+'T00:00:00Z'))/dayMs;
    if(nights<=0)throw Error(`${prefix}：退房日期必须晚于入住日期。`);
    if(event.nights!==undefined&&event.nights!==nights)
     throw Error(`${prefix}：晚数应与入住、退房日期一致（${nights} 晚）。`);
   }
   if(event.sourceUrl){
    try{
     const url=new URL(event.sourceUrl);
     if(url.protocol!=='https:'||url.username||url.password)throw Error();
    }catch{throw Error(`${prefix}：参考链接必须是完整 HTTPS 地址。`);}
   }
  }
 }
}
