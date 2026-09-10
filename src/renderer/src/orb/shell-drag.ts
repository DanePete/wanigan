import type { Sim } from './vendor/sim.js';
/** Tangential drag from a turning vessel. Particle positions and gravity remain
 * in world coordinates. This is bounded wall friction, not rigid fluid rotation. */
export class ShellDrag {
  private readonly uniform:GPUBuffer;
  private readonly pipeline:GPUComputePipeline;
  private readonly groups:GPUBindGroup[];
  constructor(private readonly device:GPUDevice,private readonly liquid:Sim){
    this.uniform=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.pipeline=device.createComputePipeline({label:'Turning vessel wall drag',layout:'auto',compute:{entryPoint:'main',module:device.createShaderModule({code:`
      @group(0) @binding(0) var<uniform> u:vec4f;
      @group(0) @binding(1) var<storage,read> positions:array<vec4f>;
      @group(0) @binding(2) var<storage,read_write> velocities:array<vec4f>;
      @compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){
        if(id.x>=u32(u.z)){return;}
        let p=positions[id.x].xyz-vec3f(1.2);
        let contact=smoothstep(.86,.96,length(p));
        let old=velocities[id.x].xyz;
        let tangent=cross(vec3f(0.,u.y,0.),p);
        // Wall friction changes only tangential velocity, preserving normal flow.
        let n=normalize(p);let tangential=old-n*dot(n,old);
        var v=old+(tangent-tangential)*(1.-exp(-contact*u.x*2.));
        v*=min(1.,max(2.2,length(old))/max(length(v),.00001));
        velocities[id.x]=vec4f(v,0.);
      }`})}});
    this.groups=['A','B'].map(side=>device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.uniform}},{binding:1,resource:{buffer:liquid.buf['pos'+side]}},
      {binding:2,resource:{buffer:liquid.buf['vel'+side]}}]}));
  }
  step(dt:number,angularVelocity:number){
    if(dt<=0||Math.abs(angularVelocity)<.001)return;
    this.device.queue.writeBuffer(this.uniform,0,new Float32Array([dt,Math.max(-6,Math.min(6,angularVelocity)),this.liquid.n,0]));
    const encoder=this.device.createCommandEncoder(),pass=encoder.beginComputePass();
    pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.groups[this.liquid.parity]);pass.dispatchWorkgroups(Math.ceil(this.liquid.n/256));pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}
