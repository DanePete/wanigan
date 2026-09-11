export const TEMPERAMENTS=[
  {value:'water',label:'Water & mist',hint:'Grab and flick. His water remembers.'},
  {value:'ember',label:'Ember & flame',hint:'Stir the hearth. Flames curl and embers rise.'},
  {value:'lava',label:'Lava lamp',hint:'Warm wax rises, stretches and joins again.'},
  {value:'ferro',label:'Ferrofluid',hint:'Move your pointer close. The liquid reaches back.'},
  {value:'ink',label:'Ink blooms',hint:'Drop color into his water, then stir the ribbons.'},
  {value:'jelly',label:'Jelly core',hint:'Give him a nudge. Squash, stretch and wobble.'},
  {value:'honey',label:'Honey',hint:'Tip the globe. Thick amber clings and slowly pours.'},
  {value:'snow',label:'Snow globe',hint:'Watch the snow pile up. Shake it into a blizzard.'},
  {value:'plasma',label:'Plasma globe',hint:'Touch the glass to gather the lightning.'},
  {value:'pearls',label:'Floating pearls',hint:'Pearls and water push each other. Give them a spin.'},
] as const;
export type Temperament=typeof TEMPERAMENTS[number]['value'];
export const materialIndex=(value:Temperament)=>TEMPERAMENTS.findIndex(item=>item.value===value);
export function readTemperament():Temperament {
  try{const value=localStorage.getItem('wanigan.orb.temperament');return TEMPERAMENTS.some(item=>item.value===value)?value as Temperament:'water';}catch{return 'water';}
}
export type GazePoint={x:number;y:number};
export type ExpressionContext={focused:boolean;thinking:boolean;answerEvent:number;attentionEvent:number;completionEvent?:number;temperament:Temperament;
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
const pulse=(age:number,length:number)=>age>0&&age<length?Math.sin(Math.PI*age/length):0;
export type OrbGesture='rest'|'curious'|'listening'|'thinking'|'notice'|'pleased'|'playful'|'spin';
export class OrbExpression {
  private x=axis();private y=axis();private lean=axis();private energy=axis();
  private curiosity=axis();private warmth=axis();private fire:Spring;
  private lava:Spring;private vortex=axis();
  private yaw=axis();private spinGoal=0;private spinAt=-10;
  private time=0;private blinkAt=3.4;private blinkStart=-10;private blinkCount=0;
  private acknowledgeAt=-10;private attentionAt=-10;private nudgeAt=-10;
  private completionAt=-10;private focusAt=-10;private nudgeCount=0;
  private roll=axis();private pitch=axis();private surprise=axis();private wink=axis();
  private ax=0;private ay=0;private gesture:OrbGesture='rest';
  private pointerAt=-10;private pointerX=0;private pointerY=0;
  private targetX=0;private targetY=0;private targetKind='rest';private fixationUntil=0;private shiftAt=-10;
  private fromX=0;private fromY=0;private microAt=0;private microX=0;private microY=0;private microCount=0;
  private context:ExpressionContext;
  constructor(context:ExpressionContext){this.context={...context};this.fire=axis(context.temperament==='ember'?1:0);this.lava=axis(context.temperament==='lava'?1:0);}
  setContext(context:ExpressionContext,animate=true){
    // While motion is off, absorb events without replaying them on resume.
    if(animate){
      if(context.answerEvent!==this.context.answerEvent){this.acknowledgeAt=this.time;this.blinkStart=this.time+.10;}
      if(context.attentionEvent!==this.context.attentionEvent)this.attentionAt=this.time;
      if((context.completionEvent??0)!==(this.context.completionEvent??0))this.completionAt=this.time;
      if(context.focused&&!this.context.focused)this.focusAt=this.time;
    }
    this.context={...context};
  }
  point(x:number,y:number){this.pointerX=clamp(x);this.pointerY=clamp(y);this.pointerAt=this.time;}
  nudge(){this.nudgeAt=this.time;this.nudgeCount++;this.blinkStart=this.time+.07;this.lean.velocity+=1.5;}
  spin(){
    if(this.time-this.spinAt<1.5)return false;
    this.spinAt=this.time;this.spinGoal+=Math.PI*2;this.blinkStart=this.time+.08;
    return true;
  }
  step(dt:number){
    if(dt<=0)return this.frame();
    dt=Math.min(dt,1/15);this.time+=dt;
    const {focused,thinking,temperament,composer={x:.65,y:-.15},overview={x:.7,y:.2}}=this.context;
    const answerAge=this.time-this.acknowledgeAt,noticeAge=this.time-this.attentionAt;
    const finishAge=this.time-this.completionAt,playAge=this.time-this.nudgeAt;
    const acknowledging=answerAge<2.2,attending=noticeAge<2.1,finished=finishAge<2.4;
    const nudged=playAge<1.6,following=this.time-this.pointerAt<3.5;
    // Explicit intent wins over incidental pointer motion. Resting glances visit
    // the actual overview, then return to the operator; they invent no activity.
    const idleGlance=this.time%11>7.5&&this.time%11<9.2;
    let kind=following?'pointer':idleGlance?'overview':'rest';
    let x=following?this.pointerX*.65:idleGlance?overview.x*.7:0;
    let y=following?this.pointerY*.5:idleGlance?overview.y*.7:0;
    if(focused){kind='composer';x=composer.x;y=composer.y;}
    if(thinking){kind='engage';x=overview.x*.6;y=overview.y*.6;}
    // A double-take: check the work, meet the operator, then look back. One
    // observed transition gets one gesture, never an escalating idle alarm.
    if(attending&&!focused&&!thinking){kind=noticeAge>.4&&noticeAge<.85?'check-in':'attention';x=kind==='check-in'?0:overview.x;y=kind==='check-in'?0:overview.y;}
    if(finished&&!focused&&!thinking&&!attending){kind='finished';x=.08;y=.04;}
    if(acknowledging){kind='acknowledge';x=.1;y=0;}
    if(nudged&&!focused&&!thinking&&!attending){kind='play';x=this.nudgeCount%2?.22:-.22;y=.12;}
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
    spring(this.energy,nudged?.7:finished?.35:thinking?.38:focused?.18:0,dt,5);
    spring(this.curiosity,(focused||attending)?.75:nudged?1:following?.22:0,dt,9);
    spring(this.warmth,acknowledging||finished?.9:nudged?.6:0,dt,8);
    const playful=!(focused||thinking||attending)&&nudged;
    spring(this.surprise,attending?pulse(noticeAge,.75):playful?pulse(playAge,.4)*.55:0,dt,16);
    // The wink follows the recoil. Keep both eyes available while reading or
    // asking for attention; the joke belongs to play, not an error signal.
    spring(this.wink,playful?pulse(playAge-.48,.5):0,dt,35,.96);
    const pleased=(finished||acknowledging)&&!attending&&!thinking;
    const nod=pleased?pulse(Math.min(finishAge,answerAge),1.1):focused?pulse(this.time-this.focusAt,.7)*.35:0;
    const rollTarget=attending?pulse(noticeAge,1.8)*-.12:playful?pulse(playAge,1.5)*(this.nudgeCount%2?.20:-.20):focused?.075:following?x*.045:0;
    const vx=this.roll.velocity,vy=this.pitch.velocity;
    spring(this.roll,rollTarget,dt,8,.74);spring(this.pitch,nod*.14,dt,9,.78);
    this.ax=Math.max(-2.2,Math.min(2.2,-(this.roll.velocity-vx)/dt*.3));
    this.ay=Math.max(-1.5,Math.min(1.5,-(this.pitch.velocity-vy)/dt*.25));
    this.gesture=this.time-this.spinAt<1.5?'spin':thinking?'thinking':attending?'notice':focused?'listening':playful?'playful':pleased?'pleased':following?'curious':'rest';
    spring(this.fire,temperament==='ember'?1:0,dt,3,.92);
    spring(this.lava,temperament==='lava'?1:0,dt,3,.92);
    spring(this.vortex,thinking?.65:0,dt,2.8,.92);
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
    return {gazeX:this.x.position,gazeY:this.y.position,blink,lean:this.lean.position,gesture:this.gesture,
      roll:this.roll.position,pitch:this.pitch.position,accelX:this.ax,accelY:this.ay,
      wink:Math.max(0,Math.min(1,this.wink.position)),surprise:Math.max(0,Math.min(1,this.surprise.position)),
      energy:this.energy.position,curiosity:this.curiosity.position,warmth:this.warmth.position,
      yaw:this.yaw.position,angularVelocity:this.yaw.velocity,
      fire:Math.max(0,Math.min(1,this.fire.position)),lava:Math.max(0,Math.min(1,this.lava.position)),
      vortex:Math.max(0,Math.min(.65,this.vortex.position)),
      bubbleInterest:!this.context.focused&&!this.context.thinking&&this.targetKind==='rest'?1:0,
      celebration:Math.max(0,1-Math.min(this.time-this.acknowledgeAt,this.time-this.completionAt)/.45)};
  }
}
