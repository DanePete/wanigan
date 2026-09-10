/** Supplied, incompressible flame: transported fuel, excess heat and soot.
 * Temperature is a normalized proxy, not a measurement in degrees. No oxygen,
 * expansion, evaporation or heat feedback into the liquid is implied. */
export const REACTION_WGSL = `
fn react(input:vec4f,dt:f32)->vec4f {
 var q=max(input,vec4f(0.));
 let ignition=smoothstep(.12,.22,q.y);
 let burned=q.x*(1.-exp(-5.*ignition*dt));
 q.x=(q.x-burned)*exp(-.3*dt);
 q.y=min(2.4,(q.y+1.6*burned)*exp(-.85*dt));
 q.z=min(1.5,(q.z+.14*burned)*exp(-.7*dt));
 q.w=burned/max(dt,.00001);
 return q;
}`;
const COMMON = `
struct Params { dt:f32, time:f32, source:f32, energy:f32, direction:vec4f }
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var source:texture_3d<f32>;
@group(0) @binding(2) var destination:texture_storage_3d<rgba16float,write>;
@group(0) @binding(3) var smoothSampler:sampler;
@group(0) @binding(4) var water:texture_3d<f32>;
@group(0) @binding(5) var velocity:texture_3d<f32>;
fn open(p:vec3f)->bool {
 return length(p-.5)<.485 && textureSampleLevel(water,smoothSampler,p,0.).x<.35;
}
`;
export class Thermal {
  readonly texture:GPUTexture;
  private readonly uniform:GPUBuffer;
  private readonly passes:{pipeline:GPUComputePipeline;group:GPUBindGroup}[];
  constructor(private readonly device:GPUDevice,water:GPUTexture,velocity:GPUTexture,private readonly size:number){
    const make=(label:string)=>device.createTexture({label,size:[size,size,size],dimension:'3d',format:'rgba16float',
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC});
    this.texture=make('Fuel, heat, soot and reaction');
    const predicted=make('Thermal advection predictor'),corrected=make('Thermal transport and reaction');
    this.uniform=device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
    const codes=[COMMON+`
    @compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
      let uv=(vec3f(id)+.5)/${size}.;
      if(!open(uv)){textureStore(destination,id,vec4f(0.));return;}
      let v=textureLoad(velocity,id,0).xyz;
      textureStore(destination,id,textureSampleLevel(source,smoothSampler,clamp(uv-v*u.dt,vec3f(.02),vec3f(.98)),0.));
    }`,COMMON+REACTION_WGSL+`
    @group(0) @binding(6) var predicted:texture_3d<f32>;
    @compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
      let uv=(vec3f(id)+.5)/${size}.;
      if(!open(uv)){textureStore(destination,id,vec4f(0.));return;}
      let v=textureLoad(velocity,id,0).xyz;
      let previous=clamp(uv-v*u.dt,vec3f(.02),vec3f(.98));
      let reverse=textureSampleLevel(predicted,smoothSampler,clamp(uv+v*u.dt,vec3f(.02),vec3f(.98)),0.);
      var q=textureLoad(predicted,id,0)+.5*(textureLoad(source,id,0)-reverse);
      let base=vec3i(floor(previous*${size}.-.5));var lo=vec4f(1e10);var hi=vec4f(-1e10);
      for(var z=0;z<2;z++){for(var y=0;y<2;y++){for(var x=0;x<2;x++){
        let value=textureLoad(source,clamp(base+vec3i(x,y,z),vec3i(0),vec3i(${size-1})),0);
        lo=min(lo,value);hi=max(hi,value);
      }}}
      q=clamp(q,lo,hi);
      // A small supplied source behind the eyes. Its material persists when
      // the supply stops; no reseeding occurs when a request or theme changes.
      let center=vec3f(.5+u.direction.x*.025,.505,.43);
      let p=(uv-center)/vec3f(.105,.043,.13);
      let left=(uv-center-vec3f(-.19,0.,.025))/vec3f(.10,.043,.12);
      let right=(uv-center-vec3f(.19,0.,-.015))/vec3f(.10,.043,.12);
      // Three supplied roots span the hearth. Unlike enlarging one Gaussian,
      // the side plumes have enough local heat to ignite in the moving flow.
      let emitter=min(1.,exp(-dot(p,p)*2.)+.9*exp(-dot(left,left)*2.)+.9*exp(-dot(right,right)*2.))*u.source;
      q.x+=emitter*u.dt*5.;q.y+=emitter*u.dt*3.;
      textureStore(destination,id,react(q,u.dt));
    }`];
    this.passes=codes.map((code,index)=>{
      const pipeline=device.createComputePipeline({label:index?'Thermal correction and burning':'Thermal transport',layout:'auto',
        compute:{module:device.createShaderModule({code}),entryPoint:'main'}});
      const entries:GPUBindGroupEntry[]=[{binding:0,resource:{buffer:this.uniform}},
        {binding:1,resource:this.texture.createView()},{binding:2,resource:(index?corrected:predicted).createView()},
        {binding:3,resource:sampler},{binding:4,resource:water.createView()},{binding:5,resource:velocity.createView()}];
      if(index)entries.push({binding:6,resource:predicted.createView()});
      return {pipeline,group:device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries})};
    });
    // Copy through a compute pass keeps stable texture bindings for gas/optics.
    const pipeline=device.createComputePipeline({label:'Publish thermal field',layout:'auto',compute:{entryPoint:'main',
      module:device.createShaderModule({code:`
      @group(0) @binding(0) var inputField:texture_3d<f32>;
      @group(0) @binding(1) var outputField:texture_storage_3d<rgba16float,write>;
      @compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){textureStore(outputField,id,textureLoad(inputField,id,0));}`})}});
    this.passes.push({pipeline,group:device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:corrected.createView()},{binding:1,resource:this.texture.createView()}]})});
  }
  step(encoder:GPUCommandEncoder,dt:number,time:number,source:number,energy:number,direction:number){
    this.device.queue.writeBuffer(this.uniform,0,new Float32Array([dt,time,source,energy,direction,0,0,0]));
    for(const {pipeline,group} of this.passes){
      const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);
      pass.dispatchWorkgroups(this.size/4,this.size/4,this.size/4);pass.end();
    }
  }
  /** Diagnostic readback only. No CPU field readback in the animation loop. */
  async inspect(){
    const bytesPerRow=Math.ceil(this.size*8/256)*256;
    const buffer=this.device.createBuffer({size:bytesPerRow*this.size*this.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    try{
      const encoder=this.device.createCommandEncoder();
      encoder.copyTextureToBuffer({texture:this.texture},{buffer,bytesPerRow,rowsPerImage:this.size},[this.size,this.size,this.size]);
      this.device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
      const half=new Uint16Array(buffer.getMappedRange());const total=[0,0,0,0],max=[0,0,0,0];let invalid=0,negative=0;
      for(let z=0;z<this.size;z++)for(let y=0;y<this.size;y++)for(let x=0;x<this.size;x++)for(let c=0;c<4;c++){
        const bits=half[(z*this.size+y)*bytesPerRow/2+x*4+c],exponent=(bits>>10)&31,mantissa=bits&1023;
        const value=(bits&32768?-1:1)*(exponent===31?Infinity:exponent===0?mantissa*2**-24:(1+mantissa/1024)*2**(exponent-15));
        if(!Number.isFinite(value))invalid++;if(value<0)negative++;
        total[c]+=value;max[c]=Math.max(max[c],value);
      }
      return {total,max,invalid,negative};
    }finally{buffer.destroy();}
  }
}
