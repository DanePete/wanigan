import { useEffect, useRef, useState } from 'react';
import type { OrbRuntime } from '../orb/runtime';
import { OrbExpression, type ExpressionContext, type Temperament } from '../orb/expression';

/** Dedicated, lazy GPU scene. Never launches agent work or shares a terminal loop. */
export default function Orb({ thinking = false, focused=false, answerEvent=0, attentionEvent=0, spinEvent=0, temperament='water' }: {
  thinking?:boolean;focused?:boolean;answerEvent?:number;attentionEvent?:number;spinEvent?:number;temperament?:Temperament;
}) {
  const canvas=useRef<HTMLCanvasElement>(null),host=useRef<HTMLButtonElement>(null);
  const context=useRef<ExpressionContext>({thinking,focused,answerEvent,attentionEvent,temperament});
  const wake=useRef(()=>{});
  const spinAction=useRef(()=>{}),lastSpin=useRef(spinEvent);
  const [status,setStatus]=useState<'loading'|'ready'|'unavailable'>('loading');
  useEffect(()=>{context.current={thinking,focused,answerEvent,attentionEvent,temperament};wake.current();},[thinking,focused,answerEvent,attentionEvent,temperament]);
  useEffect(()=>{if(spinEvent!==lastSpin.current){lastSpin.current=spinEvent;spinAction.current();}},[spinEvent]);
  useEffect(()=>{
    const el=canvas.current;if(!el)return;
    let runtime:OrbRuntime|undefined,disposed=false,visible=true,nativeVisible=true,frame=0,busy=false,dirty=false;
    let last=0,lastInteraction=0,elapsed=0,targetX=0,targetY=0;
    const expression=new OrbExpression(context.current);
    let targetsDirty=true,targets:Pick<ExpressionContext,'composer'|'overview'>={};
    const readTargets=()=>{
      const orb=el.getBoundingClientRect();
      const point=(selector:string)=>{
        const target=document.querySelector(selector)?.getBoundingClientRect();if(!target||!orb.width)return undefined;
        return {x:Math.max(-1,Math.min(1,(target.x+target.width*.5-orb.x-orb.width*.5)/(orb.width*1.6))),
          y:Math.max(-1,Math.min(1,-(target.y+target.height*.5-orb.y-orb.height*.5)/(orb.height*1.6)))};
      };
      targets={composer:point('.mission-composer'),overview:point('.mission-summary')};targetsDirty=false;
    };
    const media=matchMedia('(prefers-reduced-motion: reduce)');
    const motion=()=>document.documentElement.dataset.motion!=='off' &&
      (document.documentElement.dataset.motion==='full'||!media.matches);
    const draw=async(at:number)=>{
      frame=0;
      if(disposed||!runtime||document.hidden||!visible||!nativeVisible||busy){last=0;return;}
      const rate=at-lastInteraction<2_000?60:30;
      if(motion()&&last&&at-last<1_000/rate-1){frame=requestAnimationFrame(draw);return;}
      busy=true;
      const moving=motion(),dt=last?Math.min((at-last)/1000,1/30):1/60;last=at;
      if(targetsDirty)readTargets();
      expression.setContext({...context.current,...targets},moving);
      if(moving)elapsed+=dt;
      const pose=expression.step(moving?dt:0);
      try {
        await runtime.render({dt:moving?dt:0,time:elapsed,light:document.documentElement.dataset.theme==='light',
          ...pose,thinking:context.current.thinking});
        el.dataset.frames=String(runtime.frames);
        el.dataset.expression=context.current.thinking?'engage':context.current.focused?'attend':'rest';
        el.dataset.yaw=String(pose.yaw);
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
      if(event.buttons===1&&event.target instanceof Node&&host.current?.contains(event.target))
        { lastInteraction=performance.now(); runtime?.nudge(x,y,(x-targetX)*4,(y-targetY)*4); }
      targetX=x;targetY=y;
      expression.point(x,y);
    };
    const nudge=()=>{if(motion()){lastInteraction=performance.now();expression.nudge();runtime?.nudge(-.25,-.25,.75,.38);redraw();}};
    spinAction.current=()=>{if(motion()&&runtime&&expression.spin()){lastInteraction=performance.now();redraw();}};
    const observer=new MutationObserver(redraw);observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-motion','data-theme']});
    const intersection=new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;redraw();});intersection.observe(el);
    const resize=new ResizeObserver(redraw);resize.observe(el);
    const button=host.current;
    document.addEventListener('pointermove',pointer,{passive:true});document.addEventListener('visibilitychange',redraw);
    media.addEventListener('change',redraw);button?.addEventListener('click',nudge);
    void import('../orb/runtime').then(({OrbRuntime})=>OrbRuntime.create(el)).then(created=>{
      if(disposed){created.destroy();return;}runtime=created;setStatus('ready');
      created.device.addEventListener('uncapturederror',(event)=>{
        if(!disposed){console.error('Wanigan GPU:',(event as GPUUncapturedErrorEvent).error.message);setStatus('unavailable');created.destroy();runtime=undefined;}
      });
      void created.device.lost.then(()=>{if(!disposed&&runtime===created){setStatus('unavailable');runtime=undefined;}});
      redraw();
    }).catch(error=>{if(!disposed){console.error('Wanigan orb initialization:',error);setStatus('unavailable');}});
    return()=>{disposed=true;wake.current=()=>{};spinAction.current=()=>{};cancelAnimationFrame(frame);observer.disconnect();intersection.disconnect();resize.disconnect();
      document.removeEventListener('pointermove',pointer);document.removeEventListener('visibilitychange',redraw);
      stopNative();media.removeEventListener('change',redraw);button?.removeEventListener('click',nudge);runtime?.destroy();};
  },[]);
  return <button type="button" ref={host} className="wanigan-orb" data-physics={status}
    onDoubleClick={()=>spinAction.current()}
    aria-label={status==='unavailable'?'Wanigan · 3D rendering unavailable':'Give Wanigan a nudge'} title="Click to nudge. Drag to stir. Double-click to spin.">
    <canvas ref={canvas} aria-hidden="true" />
    {status==='unavailable'&&<span className="orb-unavailable">3D rendering unavailable</span>}
  </button>;
}
