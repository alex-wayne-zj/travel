import {useLayoutEffect,useState,type ReactNode} from 'react';

export default function AnimatedEventBody({open,children,id}:{open:boolean;children:ReactNode;id:string}){
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
 return <div id={id} className={`editor-event-reveal${expanded?' expanded':''}`} aria-hidden={!open} inert={!open} onTransitionEnd={e=>{if(e.target===e.currentTarget&&e.propertyName==='grid-template-rows'&&!open)setPresent(false);}}>
  <div className="editor-event-clip">{(open||present)&&children}</div>
 </div>;
}
