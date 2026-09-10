/** One-way hot tracers: gas drag, inertia, gravity, cooling and water contact. */
const CODE=`
@group(0) @binding(0) var<uniform> u:vec4f;
@group(0) @binding(1) var flow:texture_3d<f32>;
@group(0) @binding(2) var water:texture_3d<f32>;
@group(0) @binding(3) var thermal:texture_3d<f32>;
@group(0) @binding(4) var smoothSampler:sampler;
@group(0) @binding(5) var<storage,read_write> positions:array<vec4f>;
@group(0) @binding(6) var<storage,read_write> velocities:array<vec4f>;
fn hash(s:f32)->f32{return fract(sin(s*127.1+31.7)*43758.5453);}
@compute @workgroup_size(32) fn main(@builtin(global_invocation_id) id:vec3u){
 let i=id.x;var p=positions[i];var v=velocities[i];
 let lifetime=1.6+hash(f32(i)+17.)*2.;
 // Stagger emission. Dead particles wait without fabricated glowing motion.
 if(p.w==0. && v.w==0.){v.w=-hash(f32(i)+1.)*2.-.01;}
 v.w+=u.x;
 if(p.w<=.025 || v.w>lifetime){
  p.w=0.;
  if(v.w>0. && u.z>.05){
   let seed=f32(i)*1.71+floor(u.y)*.13;
   let center=vec3f((hash(seed)-.5)*.15,.055,-.14+(hash(seed+9.)-.5)*.10);
   let heat=textureSampleLevel(thermal,smoothSampler,(center+1.)*.5,0.).y;
   if(heat>.18){p=vec4f(center,min(1.8,heat));v=vec4f((hash(seed+8.)-.5)*.07,.16+hash(seed+4.)*.1,0.,0.);}
  }
 }else{
  let uv=(p.xyz+1.)*.5;
  let gas=textureSampleLevel(flow,smoothSampler,uv,0.).xyz*2.;
  let velocity=v.xyz+(gas-v.xyz)*(1.-exp(-3.*u.x))+vec3f(0.,-.12*u.x,0.);
  v=vec4f(velocity,v.w);p=vec4f(p.xyz+v.xyz*u.x,p.w*exp(-.72*u.x));
  if(length(p.xyz)>.965){
   let n=normalize(p.xyz);p=vec4f(n*.965,p.w);
   v=vec4f(v.xyz-n*max(0.,dot(v.xyz,n))*1.25,v.w);
  }
  if(textureSampleLevel(water,smoothSampler,(p.xyz+1.)*.5,0.).x>.32){p.w=0.;v.w=-.4;}
 }
 positions[i]=p;velocities[i]=v;
}`;
export class Embers {
  readonly positions:GPUBuffer;
  private readonly uniform:GPUBuffer;
  private readonly pipeline:GPUComputePipeline;
  private readonly group:GPUBindGroup;
  constructor(private readonly device:GPUDevice,flow:GPUTexture,water:GPUTexture,thermal:GPUTexture){
    this.positions=device.createBuffer({size:32*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    const velocities=device.createBuffer({size:32*16,usage:GPUBufferUsage.STORAGE});
    this.uniform=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.pipeline=device.createComputePipeline({label:'Inertial cooling embers',layout:'auto',compute:{module:device.createShaderModule({code:CODE}),entryPoint:'main'}});
    this.group=device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.uniform}},{binding:1,resource:flow.createView()},{binding:2,resource:water.createView()},
      {binding:3,resource:thermal.createView()},{binding:4,resource:device.createSampler({minFilter:'linear',magFilter:'linear'})},
      {binding:5,resource:{buffer:this.positions}},{binding:6,resource:{buffer:velocities}}]});
  }
  step(encoder:GPUCommandEncoder,dt:number,time:number,source:number){
    this.device.queue.writeBuffer(this.uniform,0,new Float32Array([dt,time,source,0]));
    const pass=encoder.beginComputePass();pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.group);pass.dispatchWorkgroups(1);pass.end();
  }
}
