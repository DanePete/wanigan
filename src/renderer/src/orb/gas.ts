/** 3D flow with limited MacCormack advection and a pressure projection.
 * The water field acts as an obstacle. Dye is transported by velocity, never
 * redrawn as animated noise. See docs/research/2026-09-09-realtime-orb-physics.md. */
import { Thermal } from './thermal';
const SIZE = 64;
const COMMON = `
const N:f32=${SIZE}.;
struct Params { dt:f32, time:f32, impulse:f32, fire:f32, direction:vec4f }
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var source:texture_3d<f32>;
@group(0) @binding(2) var destination:texture_storage_3d<rgba16float,write>;
@group(0) @binding(3) var linearSampler:sampler;
@group(0) @binding(4) var water:texture_3d<f32>;
fn open(p:vec3f)->bool {
 return length(p-vec3f(.5)) < .485 && textureSampleLevel(water,linearSampler,p,0.).x < .35;
}
fn at(c:vec3i)->vec4f {return textureLoad(source,clamp(c,vec3i(0),vec3i(${SIZE-1})),0);}
`;
const ADVECT = COMMON + `
@compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
 let uv=(vec3f(id)+.5)/N;
 if(!open(uv)){textureStore(destination,id,vec4f(0.));return;}
 let v=textureLoad(source,id,0).xyz;
 textureStore(destination,id,textureSampleLevel(source,linearSampler,clamp(uv-v*u.dt,vec3f(.02),vec3f(.98)),0.));
}`;
const CORRECT = COMMON + `
@group(0) @binding(5) var predicted:texture_3d<f32>;
@group(0) @binding(6) var thermal:texture_3d<f32>;
fn curl(c:vec3i)->vec3f {
 let dx=(at(c+vec3i(1,0,0)).xyz-at(c-vec3i(1,0,0)).xyz)*(N*.5);
 let dy=(at(c+vec3i(0,1,0)).xyz-at(c-vec3i(0,1,0)).xyz)*(N*.5);
 let dz=(at(c+vec3i(0,0,1)).xyz-at(c-vec3i(0,0,1)).xyz)*(N*.5);
 return vec3f(dy.z-dz.y,dz.x-dx.z,dx.y-dy.x);
}
@compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
 let uv=(vec3f(id)+.5)/N;
 if(!open(uv)){textureStore(destination,id,vec4f(0.));return;}
 let v=textureLoad(source,id,0).xyz;
 let previous=clamp(uv-v*u.dt,vec3f(.02),vec3f(.98));
 let reverse=textureSampleLevel(predicted,linearSampler,clamp(uv+v*u.dt,vec3f(.02),vec3f(.98)),0.);
 let forward=textureLoad(predicted,id,0);
 var value=forward+.5*(textureLoad(source,id,0)-reverse);
 // Limit each transported quantity to the departure cell's eight neighbors.
 // This preserves wisps without creating negative dye or new extrema.
 let base=vec3i(floor(previous*N-.5));var lo=vec4f(1e10);var hi=vec4f(-1e10);
 for(var z=0;z<2;z++){for(var y=0;y<2;y++){for(var x=0;x<2;x++){
  let sample=at(base+vec3i(x,y,z));lo=min(lo,sample);hi=max(hi,sample);
 }}}
 value=clamp(value,lo,hi);
 // First-order transport damps unresolved velocity modes on this collocated
 // grid; use the higher-order correction only for the visible dye.
 value=vec4f(forward.xyz,value.w);
 value = vec4f(value.xyz * exp(-u.dt*.22), value.w);
 // Buoyancy and a slow submerged-source plume; actual transport follows velocity.
 let heat=textureLoad(thermal,id,0);
 value.y += u.dt * (value.w*.045+heat.y*.32-heat.z*.03);
 let position=uv-vec3f(.5,.49,.49);
 let emitter=exp(-dot(position,position*vec3f(1.,.45,1.))*850.);
 value.w = min(1.8,value.w*exp(-u.dt*.22)+emitter*u.dt*.7*(1.-u.fire));
 // A supplied cloud deck for the short weather performance. Dye keeps moving
 // through the same advection/projection passes after its source switches off.
 let cloud=uv-vec3f(.5,.79,.48);
 value.w=min(1.8,value.w+exp(-dot(cloud*vec3f(1.,3.,1.4),cloud*vec3f(1.,3.,1.4))*65.)*u.dt*u.direction.w*3.);
 value = vec4f(value.xyz + u.dt*emitter*vec3f(.055*sin(u.time*.47)+u.impulse*.03,.14,.03*cos(u.time*.37)), value.w);
 // A bounded stirring force excites vortices; projection removes divergence.
 let q=uv-vec3f(.49,.69,.5);
 let vortex=vec3f(-q.y,q.x,.02*sin(u.time*.4))*mix(.5,.14,u.fire)*exp(-dot(q,q)*12.);
 let c=vec3i(id);let omega=curl(c);
 let eta=vec3f(length(curl(c+vec3i(1,0,0)))-length(curl(c-vec3i(1,0,0))),
   length(curl(c+vec3i(0,1,0)))-length(curl(c-vec3i(0,1,0))),
   length(curl(c+vec3i(0,0,1)))-length(curl(c-vec3i(0,0,1))));
 let confinement=(.0125+min(heat.y,1.)*.006)*cross(eta/max(length(eta),.00001),omega);
 // A bounded divergence-free stirring field seeds flame eddies. This is an
 // art-directed body force; visible density/heat still come from transport.
 let phase=u.time*2.3;let p=uv*28.;
 let eddies=vec3f(sin(p.y+phase)*cos(p.z-phase*.7),
   sin(p.z+phase*.8)*cos(p.x-phase),sin(p.x+phase*.7)*cos(p.y+phase));
 value=vec4f(value.xyz+u.dt*eddies*min(heat.y,1.)*.20,value.w);
 value = vec4f(value.xyz + u.dt*(vortex+confinement+vec3f(u.direction.x*.055,u.direction.y*.015,0.)*exp(-dot(q,q)*12.)), value.w);
 let contact=smoothstep(.39,.48,length(uv-.5));
 let wall=cross(vec3f(0.,u.direction.z,0.),uv-.5);
 value=vec4f(value.xyz+(wall-value.xyz)*(1.-exp(-contact*u.dt*1.5)),value.w);
 textureStore(destination,id,value);
}`;
const DIVERGENCE = COMMON + `
@compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
 let c=vec3i(id);let uv=(vec3f(id)+.5)/N;
 if(!open(uv)){textureStore(destination,id,vec4f(0.));return;}
 let d=(at(c+vec3i(1,0,0)).x-at(c-vec3i(1,0,0)).x+
 at(c+vec3i(0,1,0)).y-at(c-vec3i(0,1,0)).y+
 at(c+vec3i(0,0,1)).z-at(c-vec3i(0,0,1)).z)*(N*.5);
 textureStore(destination,id,vec4f(0.,d,0.,0.));
}`;
const PRESSURE = COMMON + `
fn pressure(c:vec3i,center:f32)->f32 {
 let uv=(vec3f(c)+.5)/N; return select(center,at(c).x,open(uv));
}
@compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
 let c=vec3i(id); let current=at(c);
 let sum=pressure(c+vec3i(1,0,0),current.x)+pressure(c-vec3i(1,0,0),current.x)+
 pressure(c+vec3i(0,1,0),current.x)+pressure(c-vec3i(0,1,0),current.x)+
 pressure(c+vec3i(0,0,1),current.x)+pressure(c-vec3i(0,0,1),current.x);
 textureStore(destination,id,vec4f((sum-current.y/(N*N))/6.,current.y,0.,0.));
}`;
const PROJECT = COMMON + `
@group(0) @binding(5) var velocity:texture_3d<f32>;
fn pressure(c:vec3i,center:f32)->f32 {return select(center,at(c).x,open((vec3f(c)+.5)/N));}
@compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
 let c=vec3i(id); let uv=(vec3f(id)+.5)/N;
 if(!open(uv)){textureStore(destination,id,vec4f(0.));return;}
 let center=at(c).x;
 let gradient=vec3f(pressure(c+vec3i(1,0,0),center)-pressure(c-vec3i(1,0,0),center),
 pressure(c+vec3i(0,1,0),center)-pressure(c-vec3i(0,1,0),center),
 pressure(c+vec3i(0,0,1),center)-pressure(c-vec3i(0,0,1),center))*(N*.5);
 var value=textureLoad(velocity,id,0);value=vec4f(value.xyz-gradient,value.w);
 // No flow through the vessel or the reconstructed water surface.
 for(var axis=0;axis<3;axis++) {
  var offset=vec3f(0.);offset[axis]=sign(value[axis])/N;
  if(!open(uv+offset)){value[axis]=0.;}
 }
 textureStore(destination,id,value);
}`;

export class Gas {
  readonly texture: GPUTexture;
  readonly thermal: Thermal;
  private readonly uniform: GPUBuffer;
  private readonly advected:GPUTexture;
  private readonly water:GPUTexture;
  private readonly passes: { pipeline: GPUComputePipeline; group: GPUBindGroup }[];
  constructor(private readonly device: GPUDevice, water: GPUTexture) {
    const make = (label: string) => device.createTexture({ label, size: [SIZE,SIZE,SIZE], dimension:'3d',
      format:'rgba16float', usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING });
    this.texture = make('Vapor velocity and density');
    this.thermal=new Thermal(device,water,this.texture,SIZE);
    const thermal=this.thermal.texture;
    this.water=water;
    const advected = this.advected = make('Advected vapor'), a = make('Vapor pressure A'), b = make('Vapor pressure B');
    const seed = device.createComputePipeline({label:'Vapor initial condition',layout:'auto',compute:{entryPoint:'main',
      module:device.createShaderModule({code:`
      const N:f32=${SIZE}.;
      @group(0) @binding(0) var destination:texture_storage_3d<rgba16float,write>;
      @compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
        let p=(vec3f(id)+.5)/N-.5;
        var density=0.;
        // Thin initial mist, subsequently transported entirely by the flow.
        let q=p-vec3f(-.025,.20,-.025);
        density=exp(-dot(q*vec3f(4.,6.,10.),q*vec3f(4.,6.,10.)))*.35;
        density *= pow(.5+.5*sin(p.x*72.+sin(p.y*51.)*1.5+p.z*60.),3.);
        density*=smoothstep(-.03,.04,p.y)*(1.-smoothstep(.38,.46,p.y));
        if(length(p)>.45){density=0.;}
        let v=vec3f(-q.y*.18,q.x*.18+.018,p.x*.05);
        textureStore(destination,id,vec4f(v,density));
      }`})}});
    const seedEncoder=device.createCommandEncoder();const seedPass=seedEncoder.beginComputePass();
    seedPass.setPipeline(seed);seedPass.setBindGroup(0,device.createBindGroup({layout:seed.getBindGroupLayout(0),
      entries:[{binding:0,resource:this.texture.createView()}]}));seedPass.dispatchWorkgroups(SIZE/4,SIZE/4,SIZE/4);seedPass.end();
    device.queue.submit([seedEncoder.finish()]);
    this.uniform = device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const sampler = device.createSampler({minFilter:'linear',magFilter:'linear'});
    const compile = (label: string, code: string) => device.createComputePipeline({label, layout:'auto',
      compute:{module:device.createShaderModule({label,code}),entryPoint:'main'}});
    const predicted=make('Vapor advection predictor');
    const advect = compile('Gas advection',ADVECT), correct=compile('Gas advection correction',CORRECT), divergence = compile('Gas divergence',DIVERGENCE),
      pressure = compile('Gas pressure Jacobi',PRESSURE), project = compile('Gas projection',PROJECT);
    const bind = (pipeline:GPUComputePipeline, input:GPUTexture, output:GPUTexture, usesTime=false, extra?:GPUTexture) => {
      // Auto layouts omit resources unused by each entry point.
      const entries: GPUBindGroupEntry[] = [
        {binding:1,resource:input.createView()},{binding:2,resource:output.createView()},
        {binding:3,resource:sampler},{binding:4,resource:water.createView()}];
      if(usesTime) entries.push({binding:0,resource:{buffer:this.uniform}});
      if(extra) entries.push({binding:5,resource:extra.createView()});
      if(pipeline===correct)entries.push({binding:6,resource:thermal.createView()});
      return {pipeline,group:device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries})};
    };
    this.passes = [bind(advect,this.texture,predicted,true),bind(correct,this.texture,advected,true,predicted),bind(divergence,advected,a)];
    const ab = bind(pressure,a,b), ba = bind(pressure,b,a);
    for(let i=0;i<24;i++) this.passes.push(i%2 ? ba : ab);
    this.passes.push(bind(project,a,this.texture,false,advected));
  }
  async inspectDivergence():Promise<{before:number;after:number;maxSpeed:number;maxDye:number;invalid:number}> {
    const n=SIZE**3;
    const pipeline=this.device.createComputePipeline({label:'Vapor projection verification',layout:'auto',compute:{entryPoint:'main',
      module:this.device.createShaderModule({code:`
      @group(0) @binding(0) var beforeField:texture_3d<f32>;
      @group(0) @binding(1) var afterField:texture_3d<f32>;
      @group(0) @binding(2) var waterField:texture_3d<f32>;
      @group(0) @binding(3) var<storage,read_write> result:array<vec4f>;
      fn divergence(c:vec3i,after:bool)->f32 {
        var sum=0.;
        for(var axis=0;axis<3;axis++){
          var d=vec3i(0);d[axis]=1;
          if(after){sum+=textureLoad(afterField,c+d,0)[axis]-textureLoad(afterField,c-d,0)[axis];}
          else{sum+=textureLoad(beforeField,c+d,0)[axis]-textureLoad(beforeField,c-d,0)[axis];}
        }
        return sum*${SIZE/2}.;
      }
      @compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){
        let index=id.x;if(index>=${n}u){return;}
        let c=vec3i(i32(index)%${SIZE},(i32(index)/${SIZE})%${SIZE},i32(index)/${SIZE*SIZE});
        let uv=(vec3f(c)+.5)/${SIZE}.;
        let cell=textureLoad(afterField,c,0);let speed=length(cell.xyz);
        if(length(uv-.5)>.43 || textureLoad(waterField,vec3i(uv*vec3f(textureDimensions(waterField))),0).x>.1){result[index]=vec4f(0.,0.,speed,cell.w);return;}
        let b=divergence(c,false);let a=divergence(c,true);result[index]=vec4f(b*b,a*a,speed,cell.w);
      }`})}});
    const storage=this.device.createBuffer({size:n*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    const read=this.device.createBuffer({size:n*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    try{
      const group=this.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:this.advected.createView()},{binding:1,resource:this.texture.createView()},
        {binding:2,resource:this.water.createView()},{binding:3,resource:{buffer:storage}}]});
      const encoder=this.device.createCommandEncoder();const pass=encoder.beginComputePass();
      pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(n/256));pass.end();
      encoder.copyBufferToBuffer(storage,0,read,0,n*16);this.device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);const values=new Float32Array(read.getMappedRange());let before=0,after=0,maxSpeed=0,maxDye=0,invalid=0;
      for(let i=0;i<values.length;i+=4){
        before+=values[i];after+=values[i+1];maxSpeed=Math.max(maxSpeed,values[i+2]);maxDye=Math.max(maxDye,values[i+3]);
        if(![values[i],values[i+1],values[i+2],values[i+3]].every(Number.isFinite))invalid++;
      }
      return {before:Math.sqrt(before/n),after:Math.sqrt(after/n),maxSpeed,maxDye,invalid};
    }finally{storage.destroy();read.destroy();}
  }
  step(encoder:GPUCommandEncoder, dt:number, time:number, impulse:number, fire:number, direction:number, energy:number, angularVelocity:number,weather=0) {
    this.thermal.step(encoder,dt,time,fire,energy,direction);
    this.device.queue.writeBuffer(this.uniform,0,new Float32Array([dt,time,impulse,fire,direction,energy,Math.max(-6,Math.min(6,angularVelocity)),weather]));
    for(const {pipeline,group} of this.passes) {
      const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);
      pass.dispatchWorkgroups(SIZE/4,SIZE/4,SIZE/4);pass.end();
    }
  }
}
