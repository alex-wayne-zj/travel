import {useEffect,useLayoutEffect,useRef,useState,type PointerEvent as ReactPointerEvent} from 'react';
import {GripVertical} from 'lucide-react';
import type {Event} from './model';
import EditorEvent from './EditorEvent';

interface Props {
 events:Event[];open:string|null;busy:boolean;onOpen:(id:string|null)=>void;
 onOrder:(events:Event[])=>void;onChange:(id:string,patch:Partial<Event>)=>void;onDelete:(id:string)=>void;
 onPick?:(lat:number,lng:number,onConfirm:(lat:number,lng:number)=>void)=>void;
}
interface Drag {id:string;pointer:number;x:number;y:number;startY:number;active:boolean;original:string[];handle:HTMLButtonElement}

export default function EditorActivities(props:Props){
 const {events,open,busy,onChange,onDelete,onPick}=props;
 const list=useRef<HTMLDivElement>(null),latest=useRef(props),current=useRef(events),drag=useRef<Drag|null>(null),frame=useRef(0),anchorFrame=useRef(0);
 latest.current=props;current.current=events;
 const [dragging,setDragging]=useState<string|null>(null),[notice,setNotice]=useState('');
 const [settled,setSettled]=useState(open===null);
 useEffect(()=>{if(open!==null){setSettled(false);return;}if(matchMedia('(prefers-reduced-motion: reduce)').matches){setSettled(true);return;}const timer=setTimeout(()=>setSettled(true),260);return()=>clearTimeout(timer);},[open]);
 const sortable=open===null&&settled&&events.length>1&&!busy;
 function order(next:Event[]){current.current=next;latest.current.onOrder(next);}
 function restore(original:string[]){const byId=new Map(current.current.map(e=>[e.id,e]));return [...original.flatMap(id=>byId.has(id)?[byId.get(id)!]:[]),...current.current.filter(e=>!original.includes(e.id))];}
 function finish(cancel=false){
  const state=drag.current;drag.current=null;cancelAnimationFrame(frame.current);
  if(!state)return;
  if(state.active){if(cancel)order(restore(state.original));setNotice(cancel?'已取消排序':`已调整顺序，第 ${current.current.findIndex(e=>e.id===state.id)+1} 项`);}
  setDragging(null);
  if(state.handle.hasPointerCapture(state.pointer))state.handle.releasePointerCapture(state.pointer);
 }
 useEffect(()=>{if(open!==null||busy)finish(true);},[open,busy]);
 useEffect(()=>{
  const cancel=()=>finish(true),escape=(e:KeyboardEvent)=>{if(e.key==='Escape'&&drag.current){e.preventDefault();finish(true);}};
  const up=(e:PointerEvent)=>{if(drag.current?.pointer===e.pointerId)finish();},abort=(e:PointerEvent)=>{if(drag.current?.pointer===e.pointerId)finish(true);};
  window.addEventListener('blur',cancel);window.addEventListener('travel:reauth',cancel);document.addEventListener('keydown',escape);
  document.addEventListener('pointermove',move,{passive:false});document.addEventListener('pointerup',up);document.addEventListener('pointercancel',abort);
  return()=>{window.removeEventListener('blur',cancel);window.removeEventListener('travel:reauth',cancel);document.removeEventListener('keydown',escape);document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);document.removeEventListener('pointercancel',abort);};
 },[]);
 useEffect(()=>()=>{
  cancelAnimationFrame(frame.current);cancelAnimationFrame(anchorFrame.current);
  if(drag.current?.active)latest.current.onOrder(restore(drag.current.original));
 },[]);
 // Moving a keyed card can release capture; document listeners keep the gesture alive.
 useLayoutEffect(()=>{
  const state=drag.current;
  if(state?.active&&state.handle.isConnected&&!state.handle.hasPointerCapture(state.pointer))state.handle.setPointerCapture(state.pointer);
 },[events]);
 function moveAt(y:number){
  const state=drag.current;if(!state?.active||!list.current)return;
  const rest=current.current.filter(e=>e.id!==state.id);
  const cards=[...list.current.querySelectorAll<HTMLElement>('.editor-event')].filter(card=>card.dataset.eventId!==state.id);
  let index=cards.findIndex(card=>{const r=card.getBoundingClientRect();return y<r.top+r.height/2;});if(index<0)index=rest.length;
  if(index===current.current.findIndex(e=>e.id===state.id))return;
  const item=current.current.find(e=>e.id===state.id);if(!item)return;
  rest.splice(index,0,item);order(rest);
 }
 function scrollEdge(){
  const state=drag.current,workspace=list.current?.closest<HTMLElement>('.workspace');if(!state?.active||!workspace)return;
  const bounds=workspace.getBoundingClientRect(),edge=48;
  const delta=state.y<bounds.top+edge?-Math.min(12,(bounds.top+edge-state.y)/4):state.y>bounds.bottom-edge?Math.min(12,(state.y-bounds.bottom+edge)/4):0;
  if(delta){workspace.scrollTop+=delta;moveAt(state.y);}
  frame.current=requestAnimationFrame(scrollEdge);
 }
 function start(e:ReactPointerEvent<HTMLButtonElement>,id:string){
  if(!sortable||e.button!==0||!e.isPrimary||drag.current)return;
  e.currentTarget.setPointerCapture(e.pointerId);
  drag.current={id,pointer:e.pointerId,x:e.clientX,y:e.clientY,startY:e.clientY,active:false,original:events.map(e=>e.id),handle:e.currentTarget};
 }
 function move(e:PointerEvent){
  const state=drag.current;if(!state||state.pointer!==e.pointerId)return;
  state.y=e.clientY;
  if(!state.active&&Math.hypot(e.clientX-state.x,e.clientY-state.startY)>=6){state.active=true;setDragging(state.id);setNotice('正在调整活动顺序');frame.current=requestAnimationFrame(scrollEdge);}
  if(state.active){e.preventDefault();moveAt(e.clientY);}
 }
 function toggle(id:string){
  finish(true);cancelAnimationFrame(anchorFrame.current);
  const header=list.current?.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(id)}"] .editor-event-heading`),workspace=list.current?.closest<HTMLElement>('.workspace');
  const y=header?.getBoundingClientRect().top,start=performance.now();
  if(open===id&&header?.closest('.editor-event')?.contains(document.activeElement)&&document.activeElement!==header)header.focus({preventScroll:true});
  latest.current.onOpen(open===id?null:id);
  // Keep the clicked heading in place as other cards contract above it.
  if(header&&workspace&&y!==undefined){
   const anchor=()=>{workspace.scrollTop+=header.getBoundingClientRect().top-y;if(!matchMedia('(prefers-reduced-motion: reduce)').matches&&performance.now()-start<270)anchorFrame.current=requestAnimationFrame(anchor);};
   anchorFrame.current=requestAnimationFrame(anchor);
  }
 }
 function keyboard(e:React.KeyboardEvent<HTMLButtonElement>,id:string){
  if(e.key==='Escape'){e.preventDefault();finish(true);return;}
  if(!sortable||drag.current||!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;
  e.preventDefault();const from=current.current.findIndex(item=>item.id===id),to=e.key==='Home'?0:e.key==='End'?current.current.length-1:Math.max(0,Math.min(current.current.length-1,from+(e.key==='ArrowUp'?-1:1)));
  if(from===to)return;const next=[...current.current],item=next.splice(from,1)[0];next.splice(to,0,item);order(next);setNotice(`${item.title||'活动'}已移至第 ${to+1} 项`);
  const handle=e.currentTarget;requestAnimationFrame(()=>handle.scrollIntoView({block:'nearest'}));
 }
 return <div className="editor-events" ref={list} onWheel={()=>cancelAnimationFrame(anchorFrame.current)} onTouchStart={()=>cancelAnimationFrame(anchorFrame.current)}>
  <p className="editor-sort-note" aria-hidden={!sortable}>{sortable?'拖动右侧把手调整顺序':'收起全部活动后可调整顺序'}</p>
  <span className="editor-order-status" role="status" aria-live="polite">{notice}</span>
  {events.map(event=><EditorEvent key={event.id} event={event} open={open===event.id} dragging={dragging===event.id} onToggle={()=>toggle(event.id)} onChange={patch=>onChange(event.id,patch)} onDelete={()=>onDelete(event.id)} onPick={onPick} handle={<button type="button" className={`editor-sort-handle${sortable?' available':''}`} aria-label={`调整顺序：${event.title||'新活动'}`} title="拖动排序，也可用上下方向键" tabIndex={sortable?0:-1} aria-hidden={!sortable} onPointerDown={e=>start(e,event.id)} onKeyDown={e=>keyboard(e,event.id)}><GripVertical size={18}/></button>}/>)}
 </div>;
}
