import {useEffect,useState} from 'react';
// Keep the original failure state so repeated tile errors do not restart the notice forever.
export function useTimedMessage(message:string,duration=5000){
 const [visible,setVisible]=useState(message);
 useEffect(()=>{setVisible(message);if(!message)return;const timer=setTimeout(()=>setVisible(''),duration);return()=>clearTimeout(timer);},[message,duration]);
 return visible;
}
