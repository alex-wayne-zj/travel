import type {Event,Kind} from './model';

export const slots=[
 ['breakfast','早餐'],['morning','上午'],['lunch','中餐'],['afternoon','下午'],
 ['dinner','晚餐'],['transport','交通'],['stay','住宿'],
] as const;

export const kinds:Record<Kind,string>={
 sight:'参观',food:'餐饮',walk:'步行',flight:'飞机',train:'火车',taxi:'打车',hotel:'住宿',nature:'自然',visit:'参观',shopping:'逛街',activity:'活动',
};

export function allowed(slot:Event['slot']):Kind[] {
 if(slot==='morning'||slot==='afternoon')return ['nature','visit','shopping','activity'];
 if(slot==='breakfast'||slot==='lunch'||slot==='dinner')return ['food'];
 if(slot==='transport')return ['flight','train','taxi','walk'];
 if(slot==='stay')return ['hotel'];
 return Object.keys(kinds) as Kind[];
}

// Legacy kinds stay in saved trips until the user explicitly changes their type.
export function editorKind(event:Event):Kind {
 const slot=event.slot;
 if(slot==='morning'||slot==='afternoon'||!slot||slot==='alternative'){
  if(event.kind==='sight')return 'visit';
  if(event.kind==='walk')return 'activity';
 }
 return event.kind;
}
