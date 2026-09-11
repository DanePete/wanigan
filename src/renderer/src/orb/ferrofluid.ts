/** A reduced magnetic free surface. A patterned applied pressure competes with
 * gravity, surface smoothing and viscous damping. Height and velocity evolve;
 * this is not a full Maxwell/free-surface solver and cannot form overhangs. */
const SIZE=128,VOLUME=80;
export class Ferrofluid {
  private readonly height:GPUTexture;
  private readonly uniform:GPUBuffer;
  private readonly move:GPUComputePipeline;
  private readonly field:GPUComputePipeline;
  private readonly groups:GPUBindGroup[];
  private readonly fieldGroup:GPUBindGroup;
  private readonly balance:GPUBuffer;
  private readonly reduce:GPUComputePipeline;
  private readonly reduceGroup:GPUBindGroup;
  private initialized=false;
  constructor(private readonly device:GPUDevice,texture:GPUTexture){
    const make=()=>device.createTexture({size:[SIZE,SIZE],format:'rgba16float',
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC});
    this.height=make();const a=make(),b=make();
    this.uniform=device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.balance=device.createBuffer({size:16,usage:GPUBufferUsage.STORAGE});
    const pressureCode=`
      fn pressureAt(p:vec2f)->f32 {
        let q=p-vec2f(u[0].y*.48,.06);let r=length(p);
        let pattern=max(0.,(cos(q.x*23.)+2.*cos(q.x*11.5)*cos(q.y*19.9186))/3.);
        return pow(pattern,5.)*exp(-dot(q,q)*3.5)*(1.-smoothstep(.55,.72,r))*u[1].x*(.65+u[0].z*.25);
      }`;
    this.reduce=device.createComputePipeline({label:'Balance magnetic pressure over the free surface',layout:'auto',compute:{entryPoint:'main',module:device.createShaderModule({code:`
      @group(0) @binding(0) var<uniform> u:array<vec4f,2>;
      @group(0) @binding(1) var surface:texture_2d<f32>;
      @group(0) @binding(2) var<storage,read_write> balance:vec4f;
      `+pressureCode+`
      @compute @workgroup_size(1) fn main(){
        var total=0.;var deviation=0.;var count=0.;
        for(var y=0;y<${SIZE};y++){for(var x=0;x<${SIZE};x++){
          let p=(vec2f(f32(x),f32(y))+.5)/${SIZE}.*2.-1.;let r=length(p);if(r>.70){continue;}
          let base=max(-sqrt(max(.001,.92*.92-r*r))+.025,-.64);
          total+=pressureAt(p);deviation+=textureLoad(surface,vec2i(x,y),0).x-base;count+=1.;
        }}
        balance=vec4f(total/count,deviation/count,0.,0.);
      }`})}});
    this.reduceGroup=device.createBindGroup({layout:this.reduce.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.uniform}},{binding:1,resource:this.height.createView()},
      {binding:2,resource:{buffer:this.balance}}]});
    this.move=device.createComputePipeline({label:'Magnetic surface pressure and relaxation',layout:'auto',compute:{entryPoint:'main',module:device.createShaderModule({code:`
      @group(0) @binding(0) var<uniform> u:array<vec4f,2>;
      @group(0) @binding(1) var source:texture_2d<f32>;
      @group(0) @binding(2) var next:texture_storage_2d<rgba16float,write>;
      @group(0) @binding(3) var<storage,read> balance:vec4f;
      `+pressureCode+`
      fn h(c:vec2i)->f32{return textureLoad(source,clamp(c,vec2i(0),vec2i(${SIZE-1})),0).x;}
      @compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
        let c=vec2i(id.xy);let p=(vec2f(id.xy)+.5)/${SIZE}.*2.-1.;let r=length(p);
        let old=textureLoad(source,c,0);let dt=u[0].x;let dx=2./${SIZE}.;
        let floor=-sqrt(max(.001,.92*.92-r*r))+.025;
        let base=max(floor,-.64);
        if(r>.72){textureStore(next,c,vec4f(floor,0.,0.,0.));return;}
        if(u[0].w>.5){textureStore(next,c,vec4f(base,0.,0.,0.));return;}
        // Equal-area pressure redistribution depresses the surrounding pool
        // when peaks rise. Feedback limits drift from clipping at the vessel.
        let pressure=pressureAt(p);
        let lap=(h(c+vec2i(1,0))+h(c-vec2i(1,0))+h(c+vec2i(0,1))+h(c-vec2i(0,1))-4.*old.x)/(dx*dx);
        let force=(base-old.x)*12.+(pressure-balance.x)*22.-balance.y*15.+lap*.006+u[1].y*p.x*.3+u[1].z*.2+u[1].w*p.x*10.;
        let velocity=(old.y+dt*force)*exp(-dt*4.);
        let ceiling=sqrt(max(.001,.90*.90-r*r));
        let value=clamp(old.x+velocity*dt,floor,ceiling);
        textureStore(next,c,vec4f(value,clamp(velocity,-2.,2.),pressure,0.));
      }`})}});
    this.groups=[[this.height,a],[a,b],[b,a],[a,this.height]].map(([source,next])=>device.createBindGroup({layout:this.move.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.uniform}},{binding:1,resource:source.createView()},{binding:2,resource:next.createView()},{binding:3,resource:{buffer:this.balance}}]}));
    this.field=device.createComputePipeline({label:'Magnetic liquid volume reconstruction',layout:'auto',compute:{entryPoint:'main',module:device.createShaderModule({code:`
      @group(0) @binding(0) var surface:texture_2d<f32>;
      @group(0) @binding(1) var volume:texture_storage_3d<rgba16float,write>;
      @group(0) @binding(2) var s:sampler;
      @compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
        let p=(vec3f(id)+.5)/${VOLUME}.*2.-1.;let h=textureSampleLevel(surface,s,(p.xz+1.)*.5,0.).x;
        let density=(1.-smoothstep(-.025,.025,p.y-h))*(1.-smoothstep(.69,.74,length(p.xz)))*(1.-smoothstep(.90,.94,length(p)));
        textureStore(volume,id,vec4f(density*2.,.5,0.,0.));
      }`})}});
    this.fieldGroup=device.createBindGroup({layout:this.field.getBindGroupLayout(0),entries:[
      {binding:0,resource:this.height.createView()},{binding:1,resource:texture.createView()},
      {binding:2,resource:device.createSampler({minFilter:'linear',magFilter:'linear'})}]});
  }
  step(encoder:GPUCommandEncoder,dt:number,pointer:[number,number,number],ax:number,ay:number,kick=0){
    this.device.queue.writeBuffer(this.uniform,0,new Float32Array([Math.min(dt,1/30)/4,pointer[0],pointer[1],this.initialized?0:1,pointer[2],ax,ay,kick]));
    const reduction=encoder.beginComputePass();reduction.setPipeline(this.reduce);reduction.setBindGroup(0,this.reduceGroup);reduction.dispatchWorkgroups(1);reduction.end();
    for(const group of this.groups){const pass=encoder.beginComputePass();pass.setPipeline(this.move);pass.setBindGroup(0,group);pass.dispatchWorkgroups(SIZE/8,SIZE/8);pass.end();}
    this.initialized=true;
    const field=encoder.beginComputePass();field.setPipeline(this.field);field.setBindGroup(0,this.fieldGroup);field.dispatchWorkgroups(VOLUME/4,VOLUME/4,VOLUME/4);field.end();
  }
  async inspect(){
    const buffer=this.device.createBuffer({size:SIZE*SIZE*8,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    try{
      const encoder=this.device.createCommandEncoder();encoder.copyTextureToBuffer({texture:this.height},{buffer,bytesPerRow:SIZE*8},[SIZE,SIZE]);
      this.device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);const data=new Uint16Array(buffer.getMappedRange());
      let min=1,max=-1,total=0,invalid=0,count=0;
      for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++){
        if(Math.hypot((x+.5)/(SIZE/2)-1,(y+.5)/(SIZE/2)-1)>.65)continue;
        const bits=data[(y*SIZE+x)*4],e=(bits>>10)&31,m=bits&1023;
        const value=(bits&32768?-1:1)*(e===31?Infinity:e===0?m*2**-24:(1+m/1024)*2**(e-15));
        if(!Number.isFinite(value))invalid++;min=Math.min(min,value);max=Math.max(max,value);total+=value;count++;
      }
      return {min,max,mean:total/count,invalid};
    }finally{buffer.destroy();}
  }
}
