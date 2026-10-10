import type {Day} from './model';
export interface PackingItem {id:string;label:string;category:string}
export interface Packing {baseItems?:PackingItem[];baseNotes?:string;extraItems:PackingItem[];checkedIds:string[];hiddenBaseIds:string[];notes:string}
export interface TripInput {name:string;destination:string;startDate:string;endDate:string;timezone:string;days:Day[];packing:Packing;version?:number}
export interface Trip extends TripInput {id:string;version:number;updatedAt:number}
export interface TripSummary {id:string;name:string;destination:string;startDate:string;endDate:string;version:number;updatedAt:number}
export interface Template {items:PackingItem[];notes:string;version:number}
export interface Session {authenticated:boolean;username?:string;accountId?:string;displayName?:string;role?:'admin'|'friend';csrfToken?:string}
let csrf='';
export function sessionToken(s:Session){csrf=s.csrfToken||'';}
export class ApiError extends Error {constructor(message:string,public status:number,public retryAfterSeconds?:number){super(message);}}
export async function api<T>(path:string,method='GET',body?:unknown):Promise<T>{
 const requestSession=csrf;
 const response=await fetch('/api'+path,{method,credentials:'same-origin',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(method==='GET'?{}:{'X-CSRF-Token':csrf})},body:body===undefined?undefined:JSON.stringify(body)});
 if(!response.ok){const error=await response.json().catch(()=>({error:'请求失败，请稍后重试'}));if(requestSession===csrf&&response.status===401&&path!=='/login'&&path!=='/invite-login'&&path!=='/session'&&path!=='/logout'&&!(path==='/password'&&['用户名或密码错误','当前凭证错误'].includes(error.error)))window.dispatchEvent(new Event('travel:reauth'));throw new ApiError(response.status===409?(path.startsWith('/invites')?'朋友信息已被其他页面更新，请重新打开此页面后重试。':'此旅程已被其他页面更新，请保留草稿并重新加载。'):response.status===401?(path==='/password'&&['用户名或密码错误','当前凭证错误'].includes(error.error)?'当前密码不正确':(path==='/login'||path==='/invite-login')?'名字或登录凭据不正确':'登录已过期，请重新登录'):response.status===429?`请求过于频繁，请${error.retryAfterSeconds?Math.ceil(error.retryAfterSeconds/60)+' 分钟后':'稍后'}重试。`:error.error||'请求失败',response.status,error.retryAfterSeconds);}
 return response.status===204?undefined as T:await response.json() as T;
}
export function tripInput(t:Trip):TripInput {const {id,updatedAt,...input}=t;return input;}
