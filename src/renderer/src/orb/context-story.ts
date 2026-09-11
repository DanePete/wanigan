import { useEffect, useState } from 'react';
import type { OrbStory } from '@shared/orb-story';

/** The selected session only. Serial reads, source timestamps and scope guards
 * prevent stale/late transcript reads from animating a different project. */
export function useContextStory(sessionId:string|null,label:string):OrbStory {
  const [story,setStory]=useState<OrbStory>({});
  useEffect(()=>{
    let alive=true,busy=false,lastEvent=0;
    setStory({});
    if(!sessionId)return;
    const refresh=async()=>{
      if(busy||document.hidden)return;busy=true;
      try{
        const reading=await window.wanigan.transcripts.context(sessionId);
        if(!alive)return;
        const ok=reading.kind==='ok',estimated=ok&&reading.windowSource!=='cli-reported';
        const stale=ok&&(reading.at===null||Date.now()-reading.at>120_000);
        const matched=ok&&reading.conversationMatch==='exact';
        const ratio=matched&&reading.percent!==null?reading.percent/100:null;
        const note=ok?`${reading.percent===null?'Window unknown':`${Math.round(reading.percent)}% context${estimated?' · estimated window':''}`}${stale?' · last reading is old':''}${matched?'':' · conversation match unconfirmed'}`
          :reading.kind==='unsupported'?'Context telemetry isn’t supported for this session':'Waiting for a context reading';
        setStory(previous=>({...previous,context:{sessionId,label,ratio,estimated,at:ok?reading.at:null,note}}));
      }catch{if(alive)setStory(previous=>({...previous,context:{sessionId,label,ratio:null,estimated:false,at:null,note:'Context reading unavailable'}}));}
      finally{busy=false;}
    };
    const off=window.wanigan.on.sessionEvent(event=>{
      if(!alive||event.sessionId!==sessionId||!['PreCompact','PostCompact'].includes(event.event)||event.id<=lastEvent)return;
      lastEvent=event.id;
      setStory(previous=>({...previous,compaction:{id:event.id,sessionId,phase:event.event==='PreCompact'?'gathering':'complete',completed:Math.min(6,(previous.compaction?.completed??0)+(event.event==='PostCompact'?1:0))}}));
      if(event.event==='PostCompact')void refresh();
    });
    void refresh();const timer=setInterval(refresh,5_000);document.addEventListener('visibilitychange',refresh);
    return()=>{alive=false;clearInterval(timer);off();document.removeEventListener('visibilitychange',refresh);};
  },[sessionId,label]);
  return story.context?.sessionId===sessionId?story:{};
}
