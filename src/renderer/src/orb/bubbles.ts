/** Small buoyant air tracers. One-way coupling: reconstructed liquid velocity
 * drags the bubbles; their tiny displaced volume does not feed back into PBF. */
const CODE = `
@group(0) @binding(0) var<uniform> dt:vec4f;
@group(0) @binding(1) var water:texture_3d<f32>;
@group(0) @binding(2) var smoothSampler:sampler;
@group(0) @binding(3) var<storage,read_write> positions:array<vec4f>;
@group(0) @binding(4) var<storage,read_write> velocities:array<vec4f>;
fn hash(seed:f32)->f32{return fract(sin(seed*127.1+31.7)*43758.5453);}
@compute @workgroup_size(32) fn main(@builtin(global_invocation_id) id:vec3u){
 let i=id.x;var p=positions[i];var v=velocities[i].xyz;
 let fluid=textureSampleLevel(water,smoothSampler,(p.xyz+1.)*.5,0.);
 if(p.w==0. || fluid.x<.32 || length(p.xyz)>.96){
  let seed=f32(i)*1.71+floor(dt.y)*.013;
  let angle=hash(seed)*6.283185;let radius=sqrt(hash(seed+9.))*.57;
  p=vec4f(radius*cos(angle),-.48-hash(seed+12.)*.29,radius*sin(angle),.008+pow(hash(seed+3.),3.)*.025);
  v=vec3f(0.);
 }
 // Fluid drag plus buoyancy, integrated with a bounded fixed timestep.
 v+=(fluid.yzw-v)*min(1.,dt.x*4.)+vec3f(0.,dt.x*.52,0.);
 let next=p.xyz+v*dt.x;
 positions[i]=vec4f(next,p.w);velocities[i]=vec4f(v,0.);
}`;
export class Bubbles {
  readonly positions:GPUBuffer;
  private readonly uniform:GPUBuffer;
  private readonly pipeline:GPUComputePipeline;
  private readonly group:GPUBindGroup;
  constructor(private readonly device:GPUDevice,water:GPUTexture){
    this.positions=device.createBuffer({size:32*16,usage:GPUBufferUsage.STORAGE});
    const velocities=device.createBuffer({size:32*16,usage:GPUBufferUsage.STORAGE});
    this.uniform=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.pipeline=device.createComputePipeline({label:'Buoyant air tracers',layout:'auto',
      compute:{module:device.createShaderModule({code:CODE}),entryPoint:'main'}});
    this.group=device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.uniform}},{binding:1,resource:water.createView()},
      {binding:2,resource:device.createSampler({minFilter:'linear',magFilter:'linear'})},
      {binding:3,resource:{buffer:this.positions}},{binding:4,resource:{buffer:velocities}}]});
  }
  step(encoder:GPUCommandEncoder,dt:number,time:number){
    this.device.queue.writeBuffer(this.uniform,0,new Float32Array([dt,time,0,0]));
    const pass=encoder.beginComputePass();pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.group);
    pass.dispatchWorkgroups(1);pass.end();
  }
}
