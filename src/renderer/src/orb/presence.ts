import { useEffect, useRef, useState } from 'react';
import { presenceChanges, type CompanionPresenceState } from '@shared/companion-presence';

/** A newly observed transition is a gesture; a status snapshot is not. Both
 * character sizes establish a baseline on mount and after unavailable reads. */
export function usePresenceReactions(presence:CompanionPresenceState){
  const [failureEvent,setFailureEvent]=useState(0);
  const previous=useRef<CompanionPresenceState|null>(null);
  const [attentionEvent,setAttentionEvent]=useState(0),[completionEvent,setCompletionEvent]=useState(0);
  useEffect(()=>{
    const changes=presenceChanges(previous.current,presence);
    previous.current=presence;
    if(changes.failure)setFailureEvent(value=>value+1);
    if(changes.completion)setCompletionEvent(value=>value+1);
    if(changes.attention)setAttentionEvent(value=>value+1);
  },[presence]);
  return {attentionEvent,completionEvent,failureEvent};
}
