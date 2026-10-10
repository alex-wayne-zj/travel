import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {useMotionPresence} from './AnimatedPanel';
export interface Confirmation {title:string;message:string;confirmLabel?:string;dangerous?:boolean}
const Context=createContext<((options:Confirmation)=>Promise<boolean>)|null>(null);
export function useConfirmation(){const confirm=useContext(Context);if(!confirm)throw Error('Confirmation provider missing');return confirm;}
export function ConfirmationProvider({children}:{children:ReactNode}){
 const [pending,setPending]=useState<Confirmation|null>(null),resolve=useRef<((value:boolean)=>void)|null>(null),dialog=useRef<HTMLDivElement>(null);
 const motion=useMotionPresence(!!pending),last=useRef<Confirmation|null>(pending);if(pending)last.current=pending;
 const shown=pending||last.current;
 function finish(value:boolean){const callback=resolve.current;resolve.current=null;setPending(null);callback?.(value);}
 useEffect(()=>{if(!pending)return;const previous=document.activeElement as HTMLElement|null;dialog.current?.querySelector<HTMLElement>('button')?.focus();const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();finish(false);}else if(e.key==='Tab'){const buttons=Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button')||[]);const first=buttons[0],last=buttons[buttons.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);if(previous?.isConnected)previous.focus();};},[pending]);
 useEffect(()=>{const cancel=()=>finish(false);window.addEventListener('travel:reauth',cancel);return()=>{window.removeEventListener('travel:reauth',cancel);resolve.current?.(false);};},[]);
 const request=(options:Confirmation)=>new Promise<boolean>(callback=>{resolve.current?.(false);resolve.current=callback;setPending(options);});
 return <Context.Provider value={request}><div className="confirmation-content" inert={!!pending}>{children}</div>{motion.present&&shown&&<div className={`confirmation-overlay motion-overlay${motion.expanded?' expanded':''}`} aria-hidden={!pending} inert={!pending} onClick={e=>{if(e.target===e.currentTarget)finish(false);}}><div className="confirmation-card" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-message"><h2 id="confirmation-title">{shown.title}</h2><p id="confirmation-message">{shown.message}</p><div className="confirmation-actions"><button onClick={()=>finish(false)}>继续编辑</button><button className={shown.dangerous?'dangerous':'solid'} onClick={()=>finish(true)}>{shown.confirmLabel||'离开页面'}</button></div></div></div>}</Context.Provider>;
}
