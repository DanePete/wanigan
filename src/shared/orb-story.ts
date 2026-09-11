/** Operational choreography. Pure, bounded and provider-neutral. Its inputs are
 * recorded transitions, never token totals, guessed progress or model calls. */
export type ContextReading = { sessionId:string; label:string; ratio:number|null; estimated:boolean; at:number|null; note:string };
export type OrbStory = {
  context?:ContextReading;
  compaction?:{id:number;sessionId:string;phase:'gathering'|'complete';completed?:number};
  failureEvent?:number;
  failed?:boolean;
  conversationScope?:string;
  reply?:{id:string;status:'pending'|'answered'|'failed'|'cancelled'};
};
const clamp=(n:number)=>Math.max(0,Math.min(1,Number.isFinite(n)?n:0));
const smooth=(n:number)=>{const t=clamp(n);return t*t*(3-2*t);};
export function contextPressure(reading:ContextReading|undefined,now:number):number {
  if(!reading||reading.estimated||reading.ratio===null||reading.at===null||now-reading.at>120_000||reading.at>now+5_000)return 0;
  return smooth((reading.ratio-.70)/.26);
}
export class OrbStoryDirector {
  private story:OrbStory;
  private age=100;private recoveryAge=100;
  private failureHeld=false;private pendingObserved=false;
  private pressure=0;private pressureTarget=0;private whirl=0;private blue=0;
  private gather=0;private memory=0;private float=0;
  private scope:string|undefined;
  constructor(story:OrbStory={}){this.story=story;this.scope=story.context?.sessionId;this.memory=Math.min(6,story.compaction?.completed??0);}
  update(next:OrbStory,moving:boolean,thinking=false,now=Date.now()) {
    const scopeChanged=next.context?.sessionId!==this.scope;
    if(scopeChanged){this.memory=Math.min(6,next.compaction?.completed??0);this.gather=0;this.pressure=0;this.scope=next.context?.sessionId;}
    this.pressureTarget=contextPressure(next.context,now);
    const conversationChanged=next.conversationScope!==this.story.conversationScope;
    if(conversationChanged){this.failureHeld=false;this.pendingObserved=false;this.age=100;this.recoveryAge=100;}
    if(thinking||next.reply?.status==='pending')this.pendingObserved=true;
    const newReply=!!next.reply&&(next.reply.id!==this.story.reply?.id||next.reply.status!==this.story.reply?.status);
    // First history read is a baseline. A request observed in flight may finish
    // before history has returned, so that outcome is still a live event.
    const liveReply=newReply&&!conversationChanged&&(!!this.story.reply||this.pendingObserved);
    if(newReply&&!liveReply&&next.reply?.status==='failed')this.failureHeld=true;
    const failedReply=liveReply&&next.reply?.status==='failed';
    const recovered=liveReply&&next.reply?.status==='answered'&&this.failureHeld;
    if(failedReply)this.failureHeld=true;
    if(recovered)this.failureHeld=false;
    const incident=(next.failureEvent??0)!==(this.story.failureEvent??0)||failedReply;
    if(moving){
      if(incident){if(this.age>8)this.age=0;this.recoveryAge=100;}
      if(recovered){this.recoveryAge=0;this.age=100;}
      if(!scopeChanged&&next.compaction?.id!==this.story.compaction?.id&&next.compaction?.phase==='complete')this.memory=Math.min(6,next.compaction.completed??this.memory+1);
    }else{
      // Consume new outcomes without queuing a performance. Merely pausing
      // preserves the current pose and the actual unresolved fault state.
      if(incident||recovered){this.age=100;this.recoveryAge=100;}
    }
    if(liveReply&&next.reply?.status!=='pending')this.pendingObserved=false;
    this.story=next;
  }
  step(dt:number,floating=false){
    if(dt>0){
      dt=Math.min(dt,.1);this.age+=dt;this.recoveryAge+=dt;
      const blend=(old:number,target:number,speed:number)=>old+(target-old)*(1-Math.exp(-dt*speed));
      // A single strong interruption, then a quiet unresolved signal. Never an
      // escalating storm simply because a request takes longer.
      const target=smooth((this.age-.18)/.65)*(1-smooth((this.age-5)/1.2));
      this.whirl=blend(this.whirl,target,7);
      this.blue=blend(this.blue,smooth(this.recoveryAge/.35)*(1-smooth((this.recoveryAge-1.5)/1.2)),7);
      this.pressure=blend(this.pressure,this.pressureTarget,1.6);
      this.gather=blend(this.gather,this.story.compaction?.phase==='gathering'?1:0,3);
      this.float=blend(this.float,floating?1:0,1.8);
    }
    return {whirl:this.whirl,recovery:this.blue,pressure:this.pressure,gather:this.gather,memoryCount:this.memory,
      float:this.float,storyScope:this.scope??'',alarm:!!this.story.failed||this.failureHeld,
      storyGesture:this.whirl>.12?'fire-whirl':this.blue>.1?'recovery':this.gather>.1?'gathering':this.pressure>.15?'crowded':this.float>.1?'weightless':'quiet'};
  }
}
