import { useEffect, useRef, useState } from 'react';
import type { CompanionPresenceState } from '@shared/companion-presence';

/** A newly observed transition is a gesture; a status snapshot is not. Both
 * character sizes establish a baseline on mount and after unavailable reads. */
export function usePresenceReactions(presence:CompanionPresenceState){
  const previous=useRef<string[]|null>(null);
  const [attentionEvent,setAttentionEvent]=useState(0),[completionEvent,setCompletionEvent]=useState(0);
  useEffect(()=>{
    if(presence.signal==='unavailable'){previous.current=null;return;}
    const fresh=previous.current===null?[]:presence.events.filter(event=>!previous.current!.includes(event));
    previous.current=presence.events;
    if(!fresh.length)return;
    if(presence.signal==='finished')setCompletionEvent(value=>value+1);
    else setAttentionEvent(value=>value+1);
  },[presence]);
  return {attentionEvent,completionEvent};
}
