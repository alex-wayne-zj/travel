import type {Event,Kind} from './model';

export const slots=[
 ['breakfast','早餐'],['morning','上午'],['lunch','中餐'],['afternoon','下午'],
 ['dinner','晚餐'],['transport','交通'],['stay','住宿'],
] as const;

export const kinds:Record<Kind,string>={
 sight:'景点',food:'餐饮',walk:'步行',flight:'飞机',train:'火车',taxi:'打车',hotel:'住宿',
};

export function allowed(slot:Event['slot']):Kind[] {
 if(slot==='morning'||slot==='afternoon')return ['sight','walk'];
 if(slot==='breakfast'||slot==='lunch'||slot==='dinner')return ['food'];
 if(slot==='transport')return ['flight','train','taxi','walk'];
 if(slot==='stay')return ['hotel'];
 return Object.keys(kinds) as Kind[];
}
