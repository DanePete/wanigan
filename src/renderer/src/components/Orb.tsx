import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PresenceSignal } from '@shared/companion-presence';
import type { OrbRuntime, OrbPlay } from '../orb/runtime';
import { OrbExpression, type ExpressionContext, type Temperament } from '../orb/expression';

/** Dedicated, lazy GPU scene. Never launches agent work or shares a terminal loop. */
export default function Orb({ thinking = false, focused=false, answerEvent=0, attentionEvent=0, spinEvent=0, playEvent, temperament='water',
  compact=false, signal='quiet', onActivate, label, popup=false, expanded=false, children }: {
  thinking?:boolean;focused?:boolean;answerEvent?:number;attentionEvent?:number;spinEvent?:number;temperament?:Temperament;
  playEvent?:{kind:OrbPlay;id:number};
  compact?:boolean;signal?:PresenceSignal;onActivate?:(anchor:HTMLButtonElement)=>void;label?:string;popup?:boolean;expanded?:boolean;children?:ReactNode;
}) {
  const canvas=useRef<HTMLCanvasElement>(null),host=useRef<HTMLButtonElement>(null);
  const context=useRef<ExpressionContext>({thinking,focused,answerEvent,attentionEvent,temperament});
  const wake=useRef(()=>{});
  const spinAction=useRef(()=>{}),lastSpin=useRef(spinEvent);
  const playAction=useRef((_kind:OrbPlay)=>{}),lastPlay=useRef(playEvent?.id);
  const suppressClick=useRef(false);
  const signalRef=useRef(signal);signalRef.current=signal;
  const [status,setStatus]=useState<'loading'|'ready'|'unavailable'>('loading');
  useEffect(()=>{context.current={thinking,focused,answerEvent,attentionEvent,temperament};wake.current();},[thinking,focused,answerEvent,attentionEvent,temperament]);
  useEffect(()=>{wake.current();},[signal]);
  useEffect(()=>{if(spinEvent!==lastSpin.current){lastSpin.current=spinEvent;spinAction.current();}},[spinEvent]);
  useEffect(()=>{if(playEvent&&playEvent.id!==lastPlay.current){lastPlay.current=playEvent.id;playAction.current(playEvent.kind);}},[playEvent]);
  useEffect(()=>{
    const el=canvas.current;if(!el)return;
    let runtime:OrbRuntime|undefined,disposed=false,visible=true,nativeVisible=true,frame=0,busy=false,dirty=false;
    let last=0,lastInteraction=-Infinity,elapsed=0,targetX=0,targetY=0;
    let drag:{id:number;x:number;y:number;lastX:number;lastY:number;moved:boolean}|undefined;
    const expression=new OrbExpression(context.current);
    // Colored illumination, with the same optical geometry and physical fields
    // at both sizes. Only idle frame frequency changes for the small companion.
    const colors:Record<PresenceSignal,number[]>={quiet:[0,0,0,0],working:[.08,.42,1,.35],
      permission:[1,.48,.025,.85],error:[1,.075,.04,.85],finished:[.035,1,.42,.8],unavailable:[.23,.27,.34,.25]};
    let tint=[...colors[signalRef.current]];
    let targetsDirty=true,targets:Pick<ExpressionContext,'composer'|'overview'>={};
    const readTargets=()=>{
      const orb=el.getBoundingClientRect();
      const point=(selector:string)=>{
        const target=document.querySelector(selector)?.getBoundingClientRect();if(!target||!orb.width)return undefined;
        return {x:Math.max(-1,Math.min(1,(target.x+target.width*.5-orb.x-orb.width*.5)/(orb.width*1.6))),
          y:Math.max(-1,Math.min(1,-(target.y+target.height*.5-orb.y-orb.height*.5)/(orb.height*1.6)))};
      };
      targets={composer:point('.mission-composer'),overview:point(compact?'.space-dock':'.mission-summary')};targetsDirty=false;
    };
    const media=matchMedia('(prefers-reduced-motion: reduce)');
    const motion=()=>document.documentElement.dataset.motion!=='off' &&
      (document.documentElement.dataset.motion==='full'||!media.matches);
    const draw=async(at:number)=>{
      frame=0;
      if(disposed||!runtime||document.hidden||!visible||!nativeVisible||busy){last=0;return;}
      const rate=at-lastInteraction<2_000?60:compact?18:30;
      if(motion()&&last&&at-last<1_000/rate-1){frame=requestAnimationFrame(draw);return;}
      busy=true;
      const moving=motion(),dt=last?Math.min((at-last)/1000,compact?1/15:1/30):1/60;last=at;
      if(!moving&&drag)release();
      if(targetsDirty)readTargets();
      expression.setContext({...context.current,...targets},moving);
      if(moving)elapsed+=dt;
      const pose=expression.step(moving?dt:0);
      const target=colors[signalRef.current],blend=moving?1-Math.exp(-dt*6):1;
      tint=tint.map((value,index)=>value+(target[index]-value)*blend);
      try {
        await runtime.render({dt:moving?dt:0,time:elapsed,light:document.documentElement.dataset.theme==='light',
          ...pose,thinking:context.current.thinking,tint:tint.slice(0,3) as [number,number,number],tintStrength:tint[3]});
        el.dataset.frames=String(runtime.frames);
        el.dataset.expression=context.current.thinking?'engage':context.current.focused?'attend':'rest';
        el.dataset.yaw=String(pose.yaw);
        el.dataset.signal=signalRef.current;
        el.dataset.tint=tint.join(',');
      }catch(error){if(!disposed){console.error('Wanigan orb:',error);setStatus('unavailable');runtime.destroy();runtime=undefined;}}
      finally{busy=false;}
      if(!disposed&&runtime&&!document.hidden&&visible&&nativeVisible&&(dirty||motion())){dirty=false;frame=requestAnimationFrame(draw);}
    };
    const redraw=()=>{last=0;targetsDirty=true;if(busy){dirty=true;return;}if(!disposed&&!frame)frame=requestAnimationFrame(draw);};
    wake.current=redraw;
    let nativeRevision=0;
    const setNativeVisible=(value:boolean)=>{nativeVisible=value;nativeRevision++;el.dataset.nativeVisibility=value?'visible':'hidden';redraw();};
    const stopNative=window.wanigan.windowVisibility.onChanged(setNativeVisible);
    const initialRevision=nativeRevision;
    void window.wanigan.windowVisibility.current().then(value=>{
      if(!disposed&&nativeRevision===initialRevision)setNativeVisible(value);
    }).catch(()=>{/* Document visibility still controls rendering if IPC is unavailable. */});
    const pointer=(event:PointerEvent)=>{
      if(!motion())return;
      const rect=el.getBoundingClientRect();
      const x=Math.max(-1,Math.min(1,(event.clientX-rect.left-rect.width/2)/(rect.width*.4)));
      const y=Math.max(-1,Math.min(1,-(event.clientY-rect.top-rect.height/2)/(rect.height*.4)));
      if(drag&&event.pointerId===drag.id){
        if(Math.hypot(event.clientX-drag.x,event.clientY-drag.y)>4)drag.moved=true;
        if(drag.moved){
          lastInteraction=performance.now();
          runtime?.grab((event.clientX-drag.x)/Math.max(64,rect.width*.5),-(event.clientY-drag.y)/Math.max(64,rect.height*.5));
          runtime?.nudge(x,y,(event.clientX-drag.lastX)/rect.width*8,-(event.clientY-drag.lastY)/rect.height*8);
        }
        drag.lastX=event.clientX;drag.lastY=event.clientY;
      }
      targetX=x;targetY=y;
      expression.point(x,y);
    };
    const nudge=()=>{if(!compact&&!suppressClick.current&&motion()){lastInteraction=performance.now();expression.nudge();runtime?.nudge(-.25,-.25,.75,.38);redraw();}};
    const down=(event:PointerEvent)=>{
      if(event.button!==0||!motion())return;
      suppressClick.current=false;drag={id:event.pointerId,x:event.clientX,y:event.clientY,lastX:event.clientX,lastY:event.clientY,moved:false};
      host.current?.setPointerCapture(event.pointerId);
    };
    const release=(event?:PointerEvent)=>{
      if(!drag||(event&&event.pointerId!==drag.id))return;
      suppressClick.current=drag.moved;
      if(drag.moved){expression.nudge();lastInteraction=performance.now();}
      const id=drag.id;drag=undefined;
      if(host.current?.hasPointerCapture(id))host.current.releasePointerCapture(id);
      runtime?.release();
    };
    const blur=()=>release();
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Enter'||event.key===' ')suppressClick.current=false;
      if(event.key==='ArrowLeft'||event.key==='ArrowRight'){
        event.preventDefault();if(motion()){expression.nudge();runtime?.nudge(-.2,-.3,event.key==='ArrowLeft'?-1:1,.5);lastInteraction=performance.now();redraw();}
      }else if(!event.metaKey&&!event.ctrlKey&&!event.altKey){
        const key=event.key.toLowerCase();
        if(key==='s'){event.preventDefault();spinAction.current();}
        if(key==='b'||key==='r'){event.preventDefault();playAction.current(key==='b'?'burst':'rain');}
      }
    };
    spinAction.current=()=>{if(motion()&&runtime&&expression.spin()){lastInteraction=performance.now();redraw();}};
    playAction.current=kind=>{if(motion()&&runtime){runtime.play(kind);if(kind!=='rain')expression.nudge();lastInteraction=performance.now();redraw();}};
    const observer=new MutationObserver(redraw);observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-motion','data-theme']});
    const intersection=new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;redraw();});intersection.observe(el);
    const resize=new ResizeObserver(redraw);resize.observe(el);
    const button=host.current;
    document.addEventListener('pointermove',pointer,{passive:true});document.addEventListener('visibilitychange',redraw);
    media.addEventListener('change',redraw);button?.addEventListener('click',nudge);
    button?.addEventListener('pointerdown',down);button?.addEventListener('pointerup',release);button?.addEventListener('pointercancel',release);
    button?.addEventListener('lostpointercapture',release);button?.addEventListener('keydown',key);
    window.addEventListener('blur',blur);
    void import('../orb/runtime').then(({OrbRuntime})=>OrbRuntime.create(el)).then(created=>{
      if(disposed){created.destroy();return;}runtime=created;setStatus('ready');
      created.device.addEventListener('uncapturederror',(event)=>{
        if(!disposed){console.error('Wanigan GPU:',(event as GPUUncapturedErrorEvent).error.message);setStatus('unavailable');created.destroy();runtime=undefined;}
      });
      void created.device.lost.then(()=>{if(!disposed&&runtime===created){setStatus('unavailable');runtime=undefined;}});
      redraw();
    }).catch(error=>{if(!disposed){console.error('Wanigan orb initialization:',error);setStatus('unavailable');}});
    return()=>{disposed=true;wake.current=()=>{};spinAction.current=()=>{};playAction.current=()=>{};cancelAnimationFrame(frame);observer.disconnect();intersection.disconnect();resize.disconnect();
      document.removeEventListener('pointermove',pointer);document.removeEventListener('visibilitychange',redraw);
      stopNative();media.removeEventListener('change',redraw);button?.removeEventListener('click',nudge);
      button?.removeEventListener('pointerdown',down);button?.removeEventListener('pointerup',release);button?.removeEventListener('pointercancel',release);
      button?.removeEventListener('lostpointercapture',release);button?.removeEventListener('keydown',key);window.removeEventListener('blur',blur);runtime?.destroy();};
  },[compact]);
  return <button type="button" ref={host} className={`wanigan-orb${compact?' wanigan-orb-small':''}`} data-physics={status}
    onClick={event=>{if(!suppressClick.current)onActivate?.(event.currentTarget);suppressClick.current=false;}} onDoubleClick={()=>{if(!compact)spinAction.current();}}
    aria-haspopup={popup?'dialog':undefined} aria-expanded={popup?expanded:undefined}
    aria-label={label??(status==='unavailable'?'Wanigan · 3D rendering unavailable':'Give Wanigan a nudge')}
    title={label??'Click to nudge. Grab and flick to stir. Double-click or press S to spin. Arrow keys make a splash.'}>
    <canvas ref={canvas} aria-hidden="true" />
    {children}
    {status==='unavailable'&&<span className="orb-unavailable">{compact?'3D unavailable':'3D rendering unavailable'}</span>}
  </button>;
}
