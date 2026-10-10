import {useEffect,useRef,useState} from 'react';
import {api,tripInput,type Trip,type Template,type PackingItem} from './api';
import AnimatedPanel from './AnimatedPanel';
import './packing.css';

export default function PackingPage({trip,template,onSaved,onTemplate,onDirty}:{trip:Trip;template:Template;onSaved:(t:Trip)=>void;onTemplate:(t:Template)=>void;onDirty:(dirty:boolean)=>void}){
 const [draft,setDraft]=useState(()=>structuredClone(trip.packing));
 const [shared,setShared]=useState(()=>structuredClone(template));
 const [editingTemplate,setEditingTemplate]=useState(false),[editingItems,setEditingItems]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const errorRef=useRef<HTMLParagraphElement>(null);
 function reportError(message:string){setError(message);requestAnimationFrame(()=>{errorRef.current?.scrollIntoView({block:'nearest'});errorRef.current?.focus({preventScroll:true});});}
 const dirty=JSON.stringify(draft)!==JSON.stringify(trip.packing)||JSON.stringify(shared)!==JSON.stringify(template);
 useEffect(()=>{onDirty(dirty);return()=>onDirty(false);},[dirty,onDirty]);
 const items=[...(draft.baseItems||template.items).filter(i=>!draft.hiddenBaseIds.includes(i.id)),...draft.extraItems];
 const categories=[...new Set(items.map(i=>i.category))];
 const checked=items.filter(i=>draft.checkedIds.includes(i.id)).length;

 async function save(){
  setBusy(true);setError('');setMessage('');
  try{const t=await api<Trip>('/trips/'+trip.id,'PUT',{...tripInput(trip),packing:draft});onSaved(t);setMessage('已保存');}
  catch(e){reportError((e as Error).message);}
  finally{setBusy(false);}
 }
 async function saveTemplate(){
  setBusy(true);setError('');
  try{const t=await api<Template>('/packing-template','PUT',shared);setShared(t);onTemplate(t);setMessage('共用模板已保存，仅用于之后创建的旅程');}
  catch(e){reportError((e as Error).message);}
  finally{setBusy(false);}
 }
 function extra(){setDraft({...draft,extraItems:[...draft.extraItems,{id:crypto.randomUUID(),label:'',category:'旅程补充'}]});}
 function changeItem(index:number,key:'label'|'category',value:string){
  setDraft({...draft,extraItems:draft.extraItems.map((item,n)=>n===index?{...item,[key]:value}:item)});
 }
 function toggle(id:string,selected:boolean){
  setDraft({...draft,checkedIds:selected?[...draft.checkedIds,id]:draft.checkedIds.filter(x=>x!==id)});
 }
 function hide(item:PackingItem){
  setDraft({...draft,hiddenBaseIds:[...draft.hiddenBaseIds,item.id],checkedIds:draft.checkedIds.filter(x=>x!==item.id)});
 }
 function removeExtra(id:string){
  setDraft({...draft,extraItems:draft.extraItems.filter(item=>item.id!==id),checkedIds:draft.checkedIds.filter(x=>x!==id)});
 }

 return <section className="page-content packing-page" aria-label="行李与提醒">
  <div className="packing-container">
   <div className="page-heading">
    <div><h1>行李与提醒</h1><p>{trip.name} · {checked} / {items.length} 件已装好</p></div>
    <button className="solid" disabled={busy||draft.extraItems.some(i=>!i.label.trim())} onClick={save}>{busy?'保存中…':'保存清单'}</button>
   </div>
   <AnimatedPanel open={!!error}><p ref={errorRef} tabIndex={-1} className="error packing-feedback" role="alert">{error}</p></AnimatedPanel>
   <AnimatedPanel open={!!message}><p className="packing-feedback" role="status">{message}</p></AnimatedPanel>
   <fieldset className="packing-fields" disabled={busy}>
    <div className="packing-overview">
     {categories.map(category=><section className="packing-card" key={category}>
      <h2>{category||'未分类'}</h2>
      {items.filter(item=>item.category===category).map(item=><div className="packing-item" key={item.id}>
       <label className="check-item">
        <input type="checkbox" checked={draft.checkedIds.includes(item.id)} onChange={e=>toggle(item.id,e.target.checked)}/>
        <span>{item.label||'请填写补充物品'}</span>
       </label>
       {!draft.extraItems.some(extra=>extra.id===item.id)&&<button className="omit-item" aria-label={'本次不带：'+item.label} title="本次不带" onClick={()=>hide(item)}>×</button>}
      </div>)}
     </section>)}
     {items.length===0&&<p className="packing-empty">清单还是空的，可以在下方添加物品。</p>}
    </div>
    <section className="packing-reminders" aria-label="提醒">
     <div className="packing-base-reminder"><h2>提醒</h2><p className="notes">{draft.baseNotes??template.notes}</p></div>
     <label className="packing-private-reminder">注意事项
      <textarea aria-label="注意事项" maxLength={10000} rows={2} value={draft.notes} placeholder="记下这趟旅程需要留意的事。" onChange={e=>setDraft({...draft,notes:e.target.value})}/>
     </label>
    </section>
    <div className="packing-tools">
     <span className="packing-save-hint">勾选后保存 · 仅此旅程</span>
     {draft.hiddenBaseIds.length>0&&<button className="packing-restore" onClick={()=>setDraft({...draft,hiddenBaseIds:[]})}>恢复隐藏物品</button>}
     <div className="packing-tool-actions">
      <button type="button" aria-expanded={editingItems} aria-controls="packing-adjust-body" onClick={()=>setEditingItems(!editingItems)}>调整本次行李</button>
      <button type="button" aria-expanded={editingTemplate} aria-controls="packing-template-body" onClick={()=>setEditingTemplate(!editingTemplate)}>管理共用模板</button>
     </div>
    </div>
    <AnimatedPanel open={editingItems} id="packing-adjust-body"><section className="packing-adjust" aria-label="特殊物品">
     <h2>特殊物品</h2>
      <div className="packing-adjust-body">
       {draft.extraItems.map((item,n)=><div className="extra-row" key={item.id}>
        <input aria-label="补充物品" maxLength={200} placeholder="物品名称" value={item.label} onChange={e=>changeItem(n,'label',e.target.value)}/>
        <button aria-label="删除补充物品" onClick={()=>removeExtra(item.id)}>×</button>
       </div>)}
       <button className="quiet" disabled={draft.extraItems.length>=100} onClick={extra}>＋ 添加物品</button>
      </div>
    </section></AnimatedPanel>
    <AnimatedPanel open={editingTemplate} id="packing-template-body"><section className="template-editor packing-template-body" aria-label="共用模板">
     <h2>共用模板</h2>
      <p className="muted">已有旅行保留创建时的清单与提醒。模板不会覆盖其他旅程。</p>
      {shared.items.map((item,n)=><div className="template-row" key={item.id}>
       <input aria-label="模板分类" maxLength={80} value={item.category} onChange={e=>setShared({...shared,items:shared.items.map((x,k)=>k===n?{...x,category:e.target.value}:x)})}/>
       <input aria-label="模板物品" maxLength={200} value={item.label} onChange={e=>setShared({...shared,items:shared.items.map((x,k)=>k===n?{...x,label:e.target.value}:x)})}/>
       <button aria-label="删除模板物品" onClick={()=>setShared({...shared,items:shared.items.filter(x=>x.id!==item.id)})}>×</button>
      </div>)}
      <button className="quiet" disabled={shared.items.length>=100} onClick={()=>setShared({...shared,items:[...shared.items,{id:crypto.randomUUID(),label:'',category:'日用'} as PackingItem]})}>＋ 添加模板物品</button>
      <textarea aria-label="共用提醒" maxLength={10000} rows={5} value={shared.notes} onChange={e=>setShared({...shared,notes:e.target.value})}/>
      <button className="solid" disabled={busy||shared.items.some(i=>!i.label.trim()||!i.category.trim())} onClick={saveTemplate}>保存共用模板</button>
    </section></AnimatedPanel>
   </fieldset>
  </div>
 </section>;
}
