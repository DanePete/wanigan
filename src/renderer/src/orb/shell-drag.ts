import type { Sim } from './vendor/sim.js';
/** Tangential drag from a turning vessel. Particle positions and gravity remain
 * in world coordinates. This is bounded wall friction, not rigid fluid rotation. */
export class ShellDrag {
  private readonly uniform:GPUBuffer;
  private readonly pipeline:GPUComputePipeline;
  private readonly groups:GPUBindGroup[];
  constructor(private readonly device:GPUDevice,private readonly liquid:Sim,impacts:GPUBuffer,keepsakes:GPUBuffer){
    this.uniform=device.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.pipeline=device.createComputePipeline({label:'Turning vessel wall drag',layout:'auto',compute:{entryPoint:'main',module:device.createShaderModule({code:`
      struct Forces { motion:vec4f, play:vec4f, weightless:vec4f }
      @group(0) @binding(0) var<uniform> f:Forces;
      @group(0) @binding(1) var<storage,read> positions:array<vec4f>;
      @group(0) @binding(2) var<storage,read_write> velocities:array<vec4f>;
      @group(0) @binding(3) var<storage,read> impacts:array<vec4f>;
      struct Body { p:vec4f, v:vec4f }
      @group(0) @binding(4) var<storage,read> keepsakes:array<Body>;
      @compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){
        let u=f.motion;if(id.x>=u32(u.z)){return;}
        let p=positions[id.x].xyz-vec3f(1.2);
        let contact=smoothstep(.86,.96,length(p));
        let old=velocities[id.x].xyz;
        let tangent=cross(vec3f(0.,u.y,0.),p);
        // Wall friction changes only tangential velocity, preserving normal flow.
        let n=p/max(length(p),.0001);let tangential=old-n*dot(n,old);
        var v=old+(tangent-tangential)*(1.-exp(-contact*u.x*2.));
        // Actual water receives handling acceleration, a rotational body force,
        // and a short central lift. PBF supplies pressure and free-surface motion.
        let whirl=cross(vec3f(0.,1.,0.),p)*2.8;
        let lift=exp(-dot(p.xz,p.xz)*12.)*f.play.z*9.;
        v+=u.x*(vec3f(f.play.xy,0.)+whirl*u.w+vec3f(0.,lift,0.));
        if(f.play.w>.001){
          for(var i=0;i<144;i++){
            let delta=p-impacts[i].xyz;
            // A readable, bounded transfer of drop momentum. The small downward
            // crater displaces fluid radially; pressure produces the wavefront.
            let profile=exp(-dot(delta,delta)*125.);
            v+=u.x*impacts[i].w*profile*vec3f(delta.x*55.,-24.,delta.z*55.);
          }
        }
        // Microgravity plus a gentle centering force: the same water particles
        // lift, cohere and drift. Restoring gravity never reseeds the solver.
        v+=u.x*f.weightless.x*(-p*.8+cross(vec3f(0.,.12,0.),p));
        // Bounded two-way coupling with the dense compaction keepsakes.
        for(var i=24u;i<30u;i++){
          let b=keepsakes[i];if(b.p.w<.005){continue;}
          let d=p-b.p.xyz;let distance=max(.001,length(d));
          let contact=max(0.,b.p.w+.045-distance);
          v+=u.x*(d/distance*contact*18.+(b.v.xyz-old)*contact*2.);
        }
        v*=min(1.,max(2.2,length(old))/max(length(v),.00001));
        velocities[id.x]=vec4f(v,0.);
      }`})}});
    this.groups=['A','B'].map(side=>device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.uniform}},{binding:1,resource:{buffer:liquid.buf['pos'+side]}},
      {binding:2,resource:{buffer:liquid.buf['vel'+side]}},{binding:3,resource:{buffer:impacts}},{binding:4,resource:{buffer:keepsakes}}]}));
  }
  step(dt:number,angularVelocity:number,vortex=0,ax=0,ay=0,celebration=0,weather=0,float=0){
    if(dt<=0)return;
    this.device.queue.writeBuffer(this.uniform,0,new Float32Array([dt,Math.max(-6,Math.min(6,angularVelocity)),this.liquid.n,vortex,ax,ay,celebration,weather,float,0,0,0]));
    const encoder=this.device.createCommandEncoder(),pass=encoder.beginComputePass();
    pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.groups[this.liquid.parity]);pass.dispatchWorkgroups(Math.ceil(this.liquid.n/256));pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
  destroy(){this.uniform.destroy();}
}
