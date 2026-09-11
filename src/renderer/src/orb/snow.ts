/** Dry, mass-conserving snow: airborne parcels deposit into a granular height
 * field. This is a reduced deposition model, not an elastoplastic MPM solver.
 * A parcel represents many powder grains; its drawn flake is not a mass scale. */
export const SNOW_COUNT=192, SNOW_GRID=48;
const R=.94, CELL=2/SNOW_GRID, AREA=CELL*CELL, PARCEL=.00075, CAPACITY=3.;
const RATE=(CAPACITY-SNOW_COUNT*PARCEL)/90;
export class SnowPhysics {
  readonly values=new Float32Array(SNOW_COUNT*8);
  readonly heights=new Float32Array(SNOW_GRID**2);
  readonly depths=new Float32Array(SNOW_GRID**2);
  readonly bed=new Float64Array(SNOW_GRID**2);
  private readonly floor=new Float64Array(SNOW_GRID**2);
  private readonly ceiling=new Float64Array(SNOW_GRID**2);
  private readonly change=new Float64Array(SNOW_GRID**2);
  private seed=41891;
  private remainder=0;
  private source=0;
  private cursor=0;
  time=0;
  supplied=SNOW_COUNT*PARCEL;
  lifted=0;
  constructor(){
    for(let z=0;z<SNOW_GRID;z++)for(let x=0;x<SNOW_GRID;x++){
      const i=z*SNOW_GRID+x,r2=((x+.5)*CELL-1)**2+((z+.5)*CELL-1)**2;
      this.ceiling[i]=Math.sqrt(Math.max(0,R*R-r2));
      this.floor[i]=-this.ceiling[i];
    }
    for(let i=0;i<SNOW_COUNT;i++){
      const y=1-2*(i+.5)/SNOW_COUNT,r=Math.sqrt(1-y*y),a=i*2.399,scale=.2+.65*this.random();
      this.values.set([Math.cos(a)*r*scale,y*scale,Math.sin(a)*r*scale,.005+(i%5)*.0012,0,-.1,0,PARCEL],i*8);
    }
    this.surface();
  }
  private random(){this.seed=(Math.imul(this.seed,1664525)+1013904223)>>>0;return this.seed/4294967296;}
  private cell(x:number,z:number){return Math.max(0,Math.min(SNOW_GRID-1,Math.floor((z+1)/CELL)))*SNOW_GRID+Math.max(0,Math.min(SNOW_GRID-1,Math.floor((x+1)/CELL)));}
  private surface(){for(let i=0;i<this.bed.length;i++){this.depths[i]=this.bed[i]/AREA;this.heights[i]=this.floor[i]+this.depths[i];}}
  private deposit(cell:number,mass:number){
    // Renormalize the powder footprint near the curved wall. Excess volume
    // remains in the bed for subsequent avalanching, never silently clamped.
    const cx=cell%SNOW_GRID,cz=Math.floor(cell/SNOW_GRID);let weight=0;
    for(let z=-2;z<=2;z++)for(let x=-2;x<=2;x++){
      const i=(cz+z)*SNOW_GRID+cx+x;
      if(cx+x>=0&&cx+x<SNOW_GRID&&cz+z>=0&&cz+z<SNOW_GRID&&this.ceiling[i]>.08&&this.floor[i]<=this.heights[cell]+.02)weight+=(3-Math.abs(x))*(3-Math.abs(z));
    }
    if(!weight){this.bed[cell]+=mass;return;}
    for(let z=-2;z<=2;z++)for(let x=-2;x<=2;x++){
      const i=(cz+z)*SNOW_GRID+cx+x;
      if(cx+x>=0&&cx+x<SNOW_GRID&&cz+z>=0&&cz+z<SNOW_GRID&&this.ceiling[i]>.08&&this.floor[i]<=this.heights[cell]+.02)this.bed[i]+=mass*(3-Math.abs(x))*(3-Math.abs(z))/weight;
    }
  }
  private avalanche(kick:number,ax:number){
    // Symmetric edge fluxes conserve volume. The repose angle gives powder
    // stable slopes instead of the continuously flat surface of water.
    const repose=CELL*(kick>.15?.15:.5);
    this.change.fill(0);
    for(let z=0;z<SNOW_GRID;z++)for(let x=0;x<SNOW_GRID;x++){
      const a=z*SNOW_GRID+x;if(this.ceiling[a]<.08)continue;
      for(let edge=0;edge<2;edge++){
        const b=edge===0?(x+1<SNOW_GRID?a+1:-1):(z+1<SNOW_GRID?a+SNOW_GRID:-1);
        if(b<0||this.ceiling[b]<.08)continue;
        const bias=b===a+1?Math.max(-.2,Math.min(.2,ax*.018))*CELL:0;
        const difference=this.heights[a]-this.heights[b]+bias;
        const from=difference>0?a:b,to=difference>0?b:a;
        const excess=Math.max(0,this.heights[from]-this.ceiling[from]);
        const desired=Math.max(0,Math.abs(difference)-repose,excess)*AREA*.18;
        const room=Math.max(0,(this.ceiling[to]-this.heights[to])*AREA);
        const transfer=Math.min(desired,this.bed[from]*.24,room*.24);
        this.change[from]-=transfer;this.change[to]+=transfer;
      }
    }
    for(let i=0;i<this.bed.length;i++)this.bed[i]+=this.change[i];
    this.surface();
  }
  advance(dt:number,kick=0,ax=0,ay=0,spin=0){
    if(dt<=0)return;
    this.remainder+=Math.min(dt,.1);
    while(this.remainder+1e-10>=1/60){this.tick(1/60,kick,ax,ay,spin);this.remainder-=1/60;}
  }
  private tick(dt:number,kick:number,ax:number,ay:number,spin:number){
    this.time+=dt;this.source=Math.min(PARCEL*8,this.source+RATE*dt);
    const v=this.values;
    for(let n=0;n<SNOW_COUNT;n++){
      const index=(n+this.cursor)%SNOW_COUNT,i=index*8;
      if(v[i+3]===0){
        let mass=0,x=0,y=0,z=0;
        if(kick>.18){
          // Lift real deposited mass; shaking never clears the bed or invents
          // new snow. Sample several columns so sparse early piles also lift.
          for(let attempt=0;attempt<6;attempt++){
            const cell=Math.floor(this.random()*this.bed.length);
            mass=Math.min(this.bed[cell],PARCEL*10*kick);
            if(mass<PARCEL*.2){mass=0;continue;}
            this.bed[cell]-=mass;this.lifted+=mass;
            x=(cell%SNOW_GRID+.5)*CELL-1;z=(Math.floor(cell/SNOW_GRID)+.5)*CELL-1;
            y=Math.min(this.ceiling[cell]-.016,this.floor[cell]+this.bed[cell]/AREA+.025);break;
          }
        }
        if(!mass&&this.source>=PARCEL&&this.supplied<CAPACITY-1e-9){
          const a=this.random()*Math.PI*2,r=Math.sqrt(this.random())*.85;
          x=Math.cos(a)*r;z=Math.sin(a)*r;const cell=this.cell(x,z);
          y=Math.sqrt(R*R-r*r)-.025;
          if(y-this.heights[cell]<.065)continue;
          mass=Math.min(PARCEL,CAPACITY-this.supplied);this.supplied+=mass;this.source-=PARCEL;
        }
        if(!mass)continue;
        v.set([x,y,z,.005+(index%5)*.0012,(this.random()-.5)*.25,kick>.18?.7+this.random()*.8:-.15,(this.random()-.5)*.25,mass],i);
        continue;
      }
      const x=v[i],z=v[i+2];
      const breeze=Math.sin(this.time*.65+index*.7)*.055;
      v[i+4]+=(ax*.07+spin*z*.15+breeze)*dt;
      v[i+5]+=(-.55+ay*.05+kick*2.8)*dt;
      v[i+6]+=(-spin*x*.15+Math.cos(this.time*.7+index)*.04)*dt;
      const drag=Math.exp(-dt*.8),speed=Math.hypot(v[i+4],v[i+5],v[i+6]);
      for(let axis=0;axis<3;axis++){v[i+4+axis]*=drag*Math.min(1,2.2/Math.max(speed,.001));v[i+axis]+=v[i+4+axis]*dt;}
      const radius=Math.hypot(v[i],v[i+1],v[i+2]),limit=R-v[i+3];
      if(radius>limit){
        const normal=[v[i]/radius,v[i+1]/radius,v[i+2]/radius];
        const outward=Math.max(0,v[i+4]*normal[0]+v[i+5]*normal[1]+v[i+6]*normal[2]);
        for(let axis=0;axis<3;axis++){v[i+axis]=normal[axis]*limit;v[i+4+axis]-=normal[axis]*outward*1.05;}
      }
      const cell=this.cell(v[i],v[i+2]);
      // Bare, steep glass cannot hold a powder column. Flakes keep sliding
      // along the sphere until they reach a supportable floor or existing bed.
      const supported=this.depths[cell]>.04||Math.hypot(v[i],v[i+2])<this.ceiling[cell]*.55;
      if(supported&&v[i+1]-v[i+3]<=this.heights[cell]&&v[i+5]<=0){this.deposit(cell,v[i+7]);v[i+3]=0;v[i+7]=0;v[i+4]=v[i+5]=v[i+6]=0;}
    }
    this.cursor=(this.cursor+1)%SNOW_COUNT;this.surface();
    for(let k=0;k<3;k++)this.avalanche(kick,ax);
  }
  inspect(){
    let airborne=0,active=0,maxRadius=0;
    for(let i=0;i<this.values.length;i+=8){airborne+=this.values[i+7];if(this.values[i+3]>0){active++;maxRadius=Math.max(maxRadius,Math.hypot(this.values[i],this.values[i+1],this.values[i+2])+this.values[i+3]);}}
    const deposited=this.bed.reduce((a,b)=>a+b,0);
    return {time:this.time,supplied:this.supplied,deposited,airborne,active,maxRadius,lifted:this.lifted,
      massError:deposited+airborne-this.supplied,fill:deposited/CAPACITY,centerHeight:this.heights[this.cell(0,0)],
      invalid:[...this.values,...this.bed].filter(v=>!Number.isFinite(v)).length};
  }
}
// Wanigan mounts one companion canvas at a time. Keep the powder when its GPU
// vessel is recreated while moving between the mission room and the miniature.
// This is renderer-local decorative state, never persisted to project records.
let retainedSnow:SnowPhysics|undefined;
export class Snow {
  readonly particles:GPUBuffer;
  readonly texture:GPUTexture;
  constructor(private readonly device:GPUDevice,readonly physics:SnowPhysics=retainedSnow??=new SnowPhysics()){
    this.particles=device.createBuffer({label:'Snow parcels',size:SNOW_COUNT*32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});
    this.texture=device.createTexture({label:'Accumulated dry snow',size:[SNOW_GRID,SNOW_GRID],format:'r32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    this.upload();
  }
  private upload(){
    this.device.queue.writeBuffer(this.particles,0,this.physics.values);
    this.device.queue.writeTexture({texture:this.texture},this.physics.depths,{bytesPerRow:SNOW_GRID*4},[SNOW_GRID,SNOW_GRID]);
  }
  step(_encoder:GPUCommandEncoder,dt:number,kick:number,ax:number,ay:number,spin:number){if(dt>0){this.physics.advance(dt,kick,ax,ay,spin);this.upload();}}
  inspect(){return this.physics.inspect();}
}
