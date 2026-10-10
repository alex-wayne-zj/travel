import {useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import './motion.css';

// Keep exiting content mounted briefly, but remove it from focus and accessibility immediately.
export function useMotionPresence(open:boolean){
 const [present,setPresent]=useState(open),[expanded,setExpanded]=useState(false);
 useLayoutEffect(()=>{
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  let frame=0,nextFrame=0,timer=0;
  if(open){
   setPresent(true);
   if(reduced)setExpanded(true);
   else frame=requestAnimationFrame(()=>{nextFrame=requestAnimationFrame(()=>setExpanded(true));});
  }else{
   setExpanded(false);
   if(reduced)setPresent(false);
   else timer=window.setTimeout(()=>setPresent(false),260);
  }
  return()=>{cancelAnimationFrame(frame);cancelAnimationFrame(nextFrame);clearTimeout(timer);};
 },[open]);
 return {present:open||present,expanded};
}

export default function AnimatedPanel({open,children,id,className='',contentClassName=''}:{open:boolean;children:ReactNode;id?:string;className?:string;contentClassName?:string}){
 const {present,expanded}=useMotionPresence(open),lastContent=useRef(children);
 if(open)lastContent.current=children;
 return <div id={id} className={`motion-panel${expanded?' expanded':''}${className?' '+className:''}`} aria-hidden={!open} inert={!open} hidden={!present}>
  <div className="motion-panel-clip">{present&&<div className={contentClassName||undefined}>{open?children:lastContent.current}</div>}</div>
 </div>;
}
