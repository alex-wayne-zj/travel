import type {ReactNode} from 'react';
import AnimatedPanel from './AnimatedPanel';

export default function AnimatedEventBody({open,children,id}:{open:boolean;children:ReactNode;id:string}){
 return <AnimatedPanel open={open} id={id} className="editor-event-reveal">{children}</AnimatedPanel>;
}
