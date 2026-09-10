export type Temperament='water'|'ember';
export type GazePoint={x:number;y:number};
export type ExpressionContext={focused:boolean;thinking:boolean;answerEvent:number;attentionEvent:number;temperament:Temperament;
  composer?:GazePoint;overview?:GazePoint};
type Spring={position:number;velocity:number};
/** Exact damped oscillator step: retargeting preserves velocity and frame rates
 * produce the same response. These springs describe expression, not fluid. */
export function spring(state:Spring,target:number,dt:number,frequency=12,damping=.82){
  if(dt<=0)return;
  const offset=state.position-target,w=frequency*Math.sqrt(1-damping*damping);
  const decay=Math.exp(-damping*frequency*dt),s=Math.sin(w*dt),c=Math.cos(w*dt);
  const velocity=state.velocity;
  state.position=target+decay*(offset*c+(velocity+damping*frequency*offset)*s/w);
  state.velocity=decay*(velocity*c-(damping*frequency*velocity+frequency*frequency*offset)*s/w);
}
const axis=(position=0):Spring=>({position,velocity:0});
const clamp=(n:number)=>Math.max(-1,Math.min(1,n));
export class OrbExpression {
  private x=axis();private y=axis();private lean=axis();private energy=axis();
  private curiosity=axis();private warmth=axis();private fire:Spring;
  private yaw=axis();private spinGoal=0;private spinAt=-10;
  private time=0;private blinkAt=3.4;private blinkStart=-10;private blinkCount=0;
  private acknowledgeAt=-10;private attentionAt=-10;private nudgeAt=-10;
  private pointerAt=-10;private pointerX=0;private pointerY=0;
  private targetX=0;private targetY=0;private targetKind='rest';private fixationUntil=0;private shiftAt=-10;
  private fromX=0;private fromY=0;private microAt=0;private microX=0;private microY=0;private microCount=0;
  private context:ExpressionContext;
  constructor(context:ExpressionContext){this.context={...context};this.fire=axis(context.temperament==='ember'?1:0);}
  setContext(context:ExpressionContext,animate=true){
    // While motion is off, absorb events without replaying them on resume.
    if(animate){
      if(context.answerEvent!==this.context.answerEvent){this.acknowledgeAt=this.time;this.blinkStart=this.time+.10;}
      if(context.attentionEvent!==this.context.attentionEvent)this.attentionAt=this.time;
    }
    this.context={...context};
  }
  point(x:number,y:number){this.pointerX=clamp(x);this.pointerY=clamp(y);this.pointerAt=this.time;}
  nudge(){this.nudgeAt=this.time;this.blinkStart=this.time+.07;this.lean.velocity+=1.5;}
  spin(){
    if(this.time-this.spinAt<1.5)return false;
    this.spinAt=this.time;this.spinGoal+=Math.PI*2;this.blinkStart=this.time+.08;
    return true;
  }
  step(dt:number){
    if(dt<=0)return this.frame();
    this.time+=Math.min(dt,1/15);
    const {focused,thinking,temperament,composer={x:.65,y:-.15},overview={x:.7,y:.2}}=this.context;
    const acknowledging=this.time-this.acknowledgeAt<1.25,attending=this.time-this.attentionAt<1.8;
    const nudged=this.time-this.nudgeAt<.7,following=this.time-this.pointerAt<3.5;
    // Explicit intent wins over incidental pointer motion. Resting glances visit
    // the actual overview, then return to the operator; they invent no activity.
    const idleGlance=this.time%11>7.5&&this.time%11<9.2;
    let kind=following?'pointer':idleGlance?'overview':'rest';
    let x=following?this.pointerX*.65:idleGlance?overview.x*.7:0;
    let y=following?this.pointerY*.5:idleGlance?overview.y*.7:0;
    if(focused){kind='composer';x=composer.x;y=composer.y;}
    if(thinking){kind='engage';x=overview.x*.6;y=overview.y*.6;}
    if(attending&&!focused&&!thinking){kind='attention';x=overview.x;y=overview.y;}
    if(acknowledging){kind='acknowledge';x=.1;y=0;}
    if(this.time-this.spinAt<.14){kind='anticipate';x=-.65;y=.1;}
    const distance=Math.hypot(x-this.targetX,y-this.targetY);
    if(kind!==this.targetKind||(distance>.18&&this.time>=this.fixationUntil)){
      this.fromX=this.x.position;this.fromY=this.y.position;
      this.targetX=x;this.targetY=y;this.targetKind=kind;this.shiftAt=this.time;this.fixationUntil=this.time+.65;
      if(distance>.7&&this.time-this.blinkStart>.8)this.blinkStart=this.time+.025;
    }
    // Very small changes around a held target, not continuously wandering eyes.
    if(this.time>=this.microAt){
      this.microCount++;this.microX=Math.sin(this.microCount*2.399)*.025;this.microY=Math.cos(this.microCount*1.73)*.018;
      this.microAt=this.time+1.1+(Math.sin(this.microCount)+1)*.45;
    }
    const shiftAge=this.time-this.shiftAt;
    const correction=shiftAge<.13?.91:1;
    x=this.fromX+(this.targetX-this.fromX)*correction+this.microX;
    y=this.fromY+(this.targetY-this.fromY)*correction+this.microY;
    spring(this.x,x,dt,42,.96);spring(this.y,y,dt,42,.96);
    spring(this.lean,x,dt,4.5,.72);
    spring(this.energy,nudged?1:thinking?.38:focused?.18:0,dt,5);
    spring(this.curiosity,(focused||attending)?.75:nudged?1:0,dt,9);
    spring(this.warmth,acknowledging?.8:0,dt,8);
    spring(this.fire,temperament==='ember'?1:0,dt,3,.92);
    const turnGoal=this.spinGoal-(this.time-this.spinAt<.14?Math.PI*2:0);
    spring(this.yaw,turnGoal+this.targetX*.16,dt,4.8,.88);
    if(this.spinGoal>Math.PI*2&&Math.abs(this.yaw.position-this.spinGoal)<.2){this.yaw.position-=Math.PI*2;this.spinGoal-=Math.PI*2;}
    if(this.time>=this.blinkAt){
      this.blinkStart=this.time;this.blinkCount++;
      this.blinkAt=this.time+3.6+(Math.sin(this.blinkCount*2.399)+1)*1.9;
    }
    return this.frame();
  }
  frame(){
    const blinkAge=this.time-this.blinkStart;
    const smooth=(x:number)=>{const t=Math.max(0,Math.min(1,x));return t*t*(3-2*t);};
    // Fast close, a brief closure, slower reopen. A blink is a gesture, not a
    // sinusoidal pulse continuously squeezing the eyes.
    const blink=blinkAge<0?1:blinkAge<.065?1-.97*smooth(blinkAge/.065):blinkAge<.085?.03:blinkAge<.215?.03+.97*smooth((blinkAge-.085)/.13):1;
    return {gazeX:this.x.position,gazeY:this.y.position,blink,lean:this.lean.position,
      energy:this.energy.position,curiosity:this.curiosity.position,warmth:this.warmth.position,
      yaw:this.yaw.position,angularVelocity:this.yaw.velocity,
      fire:Math.max(0,Math.min(1,this.fire.position))};
  }
}
