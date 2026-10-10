import {useEffect,useLayoutEffect,useRef,useState,type KeyboardEvent} from 'react';

import {useMotionPresence} from './AnimatedPanel';

// Shared only by field popovers: position in viewport, close on outside focus, keep Tab natural.
export function useFieldPopover(onLeave?:()=>void){
 const [open,setOpen]=useState(false),[position,setPosition]=useState<{left:number;top:number;maxHeight?:number;maxWidth?:number}>({left:16,top:16});
 const motion=useMotionPresence(open);
 const field=useRef<HTMLDivElement>(null),panel=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const leave=useRef(onLeave);leave.current=onLeave;
 function close(restore=false,notify=true){setOpen(false);if(notify)leave.current?.();if(restore)trigger.current?.focus();}
 useLayoutEffect(()=>{
  if(!open)return;
  function place(){
   const anchor=trigger.current?.getBoundingClientRect()||field.current?.getBoundingClientRect(),popup=panel.current?.getBoundingClientRect();if(!anchor||!popup)return;
   const viewport=window.visualViewport,leftEdge=viewport?.offsetLeft||0,topEdge=viewport?.offsetTop||0;
   const width=viewport?.width||window.innerWidth,height=viewport?.height||window.innerHeight;
   const left=Math.max(leftEdge+16,Math.min(anchor.left,leftEdge+width-popup.width-16));
   const below=anchor.bottom+8,bottom=topEdge+height-16;
   const top=below+popup.height<=bottom?below:anchor.top-popup.height-8>=topEdge+16?anchor.top-popup.height-8:Math.max(topEdge+16,Math.min(below,bottom-popup.height));
   setPosition({left,top,maxHeight:height-32,maxWidth:width-32});
  }
  const viewport=window.visualViewport;viewport?.addEventListener('resize',place);viewport?.addEventListener('scroll',place);
  place();const observer=new ResizeObserver(place);if(panel.current)observer.observe(panel.current);window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
  return()=>{observer.disconnect();viewport?.removeEventListener('resize',place);viewport?.removeEventListener('scroll',place);window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
 },[open]);
 useEffect(()=>{
  if(!open)return;
  const outside=(event:Event)=>{const target=event.target as Node;if(!field.current?.contains(target)&&!panel.current?.contains(target))close();};
  const escape=(event:globalThis.KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close(true);}};
  const reauth=()=>close();
  document.addEventListener('pointerdown',outside);document.addEventListener('focusin',outside);document.addEventListener('keydown',escape);window.addEventListener('travel:reauth',reauth);
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('focusin',outside);document.removeEventListener('keydown',escape);window.removeEventListener('travel:reauth',reauth);};
 },[open]);
 function panelTab(event:KeyboardEvent){
  if(event.key!=='Tab')return;
  const items=Array.from(panel.current?.querySelectorAll<HTMLElement>('button,input,select')||[]).filter(el=>el.tabIndex>=0&&!el.hasAttribute('disabled')&&!el.closest('[inert],[hidden]'));
  if(event.target===(event.shiftKey?items[0]:items.at(-1)))close(true);
 }
 return {open,present:motion.present,expanded:motion.expanded,setOpen,position,field,panel,trigger,close,panelTab};
}
