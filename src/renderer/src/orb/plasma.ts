/** Exposure-averaged discharge network. Channel memory, convection, connected
 * branches and bounded power sharing approximate visible globe behavior; this
 * does not solve charge transport, gas chemistry or the AC circuit. */
export const PLASMA_STRANDS=12, PLASMA_STATIONS=24, PLASMA_COUNT=PLASMA_STRANDS*PLASMA_STATIONS;
const PRIMARY=8, R=.965, CORE:[number,number,number]=[0,-.08,0], BULB=.145;
type Vec=[number,number,number];
const length=(p:Vec)=>Math.hypot(...p);
const unit=(p:Vec):Vec=>{const r=length(p)||1;return p.map(v=>v/r) as Vec;};
const mix=(a:Vec,b:Vec,t:number):Vec=>a.map((v,i)=>v+(b[i]-v)*t) as Vec;
const smooth=(v:number)=>{const t=Math.max(0,Math.min(1,v));return t*t*(3-2*t);};
type Channel={home:Vec;tip:Vec;noise:Float64Array;age:number;life:number;memory:number;power:number;contact:number;parent:number;renewals:number};

/** Matches the optical camera and its air/glass/air ray. A bounding rectangle
 * isn't a glass contact; reject corners and return the actual inner shell hit. */
export function plasmaContact(pointer:Vec):Vec|null {
  if(pointer[2]<=0)return null;
  const origin:Vec=[0,.22,4.6],forward=unit(origin.map(v=>-v) as Vec),up:Vec=[0,-forward[2],forward[1]];
  let d=unit(forward.map((v,i)=>v*4.6+(i===0?pointer[0]:0)+up[i]*pointer[1]) as Vec);
  const hit=(o:Vec,ray:Vec,r:number)=>{const b=o.reduce((sum,v,i)=>sum+v*ray[i],0),h=b*b-length(o)**2+r*r;return h<0?-1:-b-Math.sqrt(h);};
  const t=hit(origin,d,1.015);if(t<0)return null;
  const surface=origin.map((v,i)=>v+d[i]*t) as Vec,n=unit(surface),cos=d.reduce((sum,v,i)=>sum-v*n[i],0),eta=1/1.46;
  d=d.map((v,i)=>eta*v+(eta*cos-Math.sqrt(1-eta*eta*(1-cos*cos)))*n[i]) as Vec;
  const inner=hit(surface,d,R);if(inner<0)return null;
  return surface.map((v,i)=>v+d[i]*inner) as Vec;
}
export class PlasmaPhysics {
  readonly values=new Float32Array(PLASMA_COUNT*8);
  private readonly channels:Channel[]=[];
  private readonly positions=new Float64Array(PLASMA_COUNT*3);
  private readonly velocities=new Float64Array(PLASMA_COUNT*3);
  private seed=7919;
  private remainder=0;
  private contact:Vec|null=null;
  private touch=0;
  time=0;
  constructor(){
    for(let i=0;i<PLASMA_STRANDS;i++){
      const y=1-2*((i%PRIMARY)+.5)/PRIMARY,r=Math.sqrt(1-y*y),a=i*2.399;
      const home:Vec=[Math.cos(a)*r*R,y*R,Math.sin(a)*r*R],life=4+this.random()*5;
      this.channels.push({home,tip:[...home],noise:new Float64Array(9),age:life*(i+.5)/PLASMA_STRANDS,life,memory:.5,power:0,contact:0,parent:i<PRIMARY?-1:(i-PRIMARY)*2,renewals:0});
    }
    this.tick(0,[0,0,0],0);this.geometry(0,true);
  }
  private random(){this.seed=(Math.imul(this.seed,1664525)+1013904223)>>>0;return this.seed/4294967296;}
  advance(dt:number,pointer:Vec,spin=0){
    if(dt<=0)return;
    this.remainder+=Math.min(dt,.1);
    while(this.remainder+1e-10>=1/60){this.tick(1/60,pointer,spin);this.remainder-=1/60;}
  }
  private tick(dt:number,pointer:Vec,spin:number){
    this.time+=dt;const target=plasmaContact(pointer);
    if(target)this.contact=target;
    this.touch+=(Number(!!target)-this.touch)*(1-Math.exp(-dt*(target?9:4)));
    const scores:number[]=[];let sum=0,best=-Infinity,winner=0;
    for(let i=0;i<PRIMARY;i++){
      const c=this.channels[i];
      const proximity=this.contact?c.home.reduce((s,v,k)=>s+v*this.contact![k],0)/(R*R):0;
      const score=(.45+c.memory)*Math.exp((proximity-1)*7);
      scores.push(score);sum+=score;if(score>best){best=score;winner=i;}
    }
    for(let i=0;i<PLASMA_STRANDS;i++){
      const c=this.channels[i],isBranch=c.parent>=0;
      c.age+=dt;
      const selected=!isBranch&&i===winner;
      if(selected&&this.touch>.3)c.age=Math.min(c.age,c.life-.65);
      if(c.age>=c.life){
        c.age=0;c.life=4+this.random()*5;c.renewals++;c.power=0;
        const y=this.random()*1.7-.9,a=this.random()*Math.PI*2,r=Math.sqrt(1-y*y);
        c.home=[Math.cos(a)*r*R,y*R,Math.sin(a)*r*R];c.tip=[...c.home];c.memory=.15;
      }
      for(let k=0;k<9;k++)c.noise[k]=Math.max(-.13,Math.min(.13,c.noise[k]*Math.exp(-dt*1.8)+(this.random()-.5)*Math.sqrt(dt)*.11));
      // Buoyancy drifts attachments tangentially upward; independent correlated
      // disturbances let channels walk instead of rotating the entire network.
      const normal=unit(c.home),drift:Vec=[c.noise[0]*.12+spin*.004*normal[2],.026+c.noise[1]*.12,c.noise[2]*.12-spin*.004*normal[0]];
      const radial=drift.reduce((s,v,k)=>s+v*normal[k],0);
      c.home=unit(c.home.map((v,k)=>v+(drift[k]-radial*normal[k])*dt) as Vec).map(v=>v*R) as Vec;
      const attraction=selected?this.touch:0;
      c.contact+=(attraction-c.contact)*(1-Math.exp(-dt*8));
      const destination=this.contact?unit(mix(c.home,this.contact,c.contact)).map(v=>v*R) as Vec:c.home;
      c.tip=unit(mix(c.tip,destination,1-Math.exp(-dt*10))).map(v=>v*R) as Vec;
      const envelope=smooth(c.age/.35)*smooth((c.life-c.age)/.55);
      const share=isBranch?0:(1-this.touch)/PRIMARY+this.touch*(i===winner?.84:.16*scores[i]/Math.max(sum-best,.000001));
      // A modest increase in total excitation under touch, not unbounded glow.
      const desired=isBranch?this.channels[c.parent].power*.2*envelope:(2.8+this.touch*.65)*share*envelope;
      c.power+=(desired-c.power)*(dt===0?1:1-Math.exp(-dt*12));
      c.memory=Math.max(.08,Math.min(1,c.memory+dt*(c.power*.55-c.memory*.26)));
    }
    this.geometry(dt);
  }
  private geometry(dt:number,initialize=false){
    for(let strand=0;strand<PLASMA_STRANDS;strand++){
      const c=this.channels[strand],offset=strand*PLASMA_STATIONS;
      const branch=c.parent>=0;
      let root:Vec,tip:Vec=c.tip;
      if(branch){
        const p=(c.parent*PLASMA_STATIONS+11)*3;root=[this.positions[p],this.positions[p+1],this.positions[p+2]];
        const parent=this.channels[c.parent],bend=c.noise;
        tip=unit([parent.tip[0]+bend[0]*3+.12, parent.tip[1]+.18, parent.tip[2]+bend[2]*3-.1]).map(v=>v*R) as Vec;
      }else{
        const normal=unit(c.tip.map((v,k)=>v-CORE[k]) as Vec);root=CORE.map((v,k)=>v+normal[k]*BULB) as Vec;
      }
      for(let j=0;j<PLASMA_STATIONS;j++){
        const t=j/(PLASMA_STATIONS-1),p=(offset+j)*3,b=(offset+j)*8;
        const envelope=Math.sin(Math.PI*t)*smooth(t*5);
        const goal=mix(root,tip,t);
        for(let k=0;k<3;k++)goal[k]+=envelope*(c.noise[k]*Math.sin(t*Math.PI*2)+c.noise[k+3]*Math.sin(t*Math.PI*4)+c.noise[k+6]*Math.sin(t*Math.PI*7)*.35);
        goal[1]+=.06*Math.sin(Math.PI*t)*t;
        const reset=initialize||c.age<.02||j===0||j===PLASMA_STATIONS-1;
        for(let k=0;k<3;k++){
          if(reset){this.positions[p+k]=goal[k];this.velocities[p+k]=0;}
          else{this.velocities[p+k]=(this.velocities[p+k]+(goal[k]-this.positions[p+k])*130*dt)*Math.exp(-dt*14);this.positions[p+k]+=this.velocities[p+k]*dt;}
        }
        const radius=Math.hypot(this.positions[p],this.positions[p+1],this.positions[p+2]);
        if(radius>R){for(let k=0;k<3;k++){this.positions[p+k]*=R/radius;this.velocities[p+k]*=.5;}}
        for(let k=0;k<3;k++)this.values[b+k]=this.positions[p+k];
        this.values[b+3]=c.power;
        this.values[b+7]=j===PLASMA_STATIONS-1?c.contact:0;
      }
      // Conservative per-channel sphere bounds cull most pixel/curve pairs.
      const center=mix(root,tip,.5);let radius=0;
      for(let j=0;j<PLASMA_STATIONS;j++){const p=(offset+j)*3;radius=Math.max(radius,Math.hypot(this.positions[p]-center[0],this.positions[p+1]-center[1],this.positions[p+2]-center[2]));}
      this.values.set([...center,radius+.05],offset*8+4);
    }
  }
  inspect(){
    return {time:this.time,touch:this.touch,contact:this.contact,channels:this.channels.map(c=>({power:c.power,memory:c.memory,age:c.age,parent:c.parent,renewals:c.renewals,contact:c.contact,tip:[...c.tip]})),
      power:this.channels.reduce((s,c)=>s+c.power,0),invalid:[...this.values].filter(v=>!Number.isFinite(v)).length};
  }
}
export class Plasma {
  readonly particles:GPUBuffer;
  readonly physics=new PlasmaPhysics();
  constructor(private readonly device:GPUDevice){
    this.particles=device.createBuffer({label:'Persistent discharge channels',size:PLASMA_COUNT*32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(this.particles,0,this.physics.values);
  }
  step(_encoder:GPUCommandEncoder,dt:number,_time:number,pointer:Vec,spin=0){if(dt>0){this.physics.advance(dt,pointer,spin);this.device.queue.writeBuffer(this.particles,0,this.physics.values);}}
  inspect(){return this.physics.inspect();}
}
