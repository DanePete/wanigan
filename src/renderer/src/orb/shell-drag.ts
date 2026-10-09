import type { Sim } from './vendor/sim.js';
import { IMPACTS } from './weather';

/** What a handled, turning vessel does to its water: tangential wall friction
 * from the spin and the vessel's acceleration as a body force. Positions and
 * gravity stay in world coordinates; this is not rigid rotation of the fluid.
 * The same pass carries Wanigan 1's play forces (`shell-drag.ts` there): the
 * thinking swirl, a celebration's central fountain and the rain's impacts. */
export type WaterForces = {
  spin: number; ax: number; ay: number;
  /** The thinking swirl, 0..0.65: a rotational body force about the vertical. */
  vortex: number;
  /** 1 when work completes, decaying fast: a lift at the centre. */
  celebration: number;
  /** The rainstorm's cloud: while it is up, drop impacts push the water. */
  weather: number;
};

export class ShellDrag {
  private readonly uniform: GPUBuffer;
  private readonly pipeline: GPUComputePipeline;
  private readonly groups: [GPUBindGroup, GPUBindGroup];
  private readonly device: GPUDevice;
  private readonly liquid: Sim;

  constructor(device: GPUDevice, liquid: Sim, impacts: GPUBuffer) {
    this.device = device;
    this.liquid = liquid;
    this.uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.pipeline = device.createComputePipeline({ label: 'Turning vessel wall drag', layout: 'auto', compute: { entryPoint: 'main', module: device.createShaderModule({ code: `
      struct Forces { motion:vec4f, play:vec4f }
      @group(0) @binding(0) var<uniform> f:Forces;
      @group(0) @binding(1) var<storage,read> positions:array<vec4f>;
      @group(0) @binding(2) var<storage,read_write> velocities:array<vec4f>;
      @group(0) @binding(3) var<storage,read> impacts:array<vec4f>;
      @compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){
        let u=f.motion;if(id.x>=u32(u.z)){return;}
        let p=positions[id.x].xyz-vec3f(1.2);
        let contact=smoothstep(.86,.96,length(p));
        let old=velocities[id.x].xyz;
        let tangent=cross(vec3f(0.,u.y,0.),p);
        // Wall friction changes only tangential velocity, preserving normal flow.
        let n=p/max(length(p),.0001);let tangential=old-n*dot(n,old);
        var v=old+(tangent-tangential)*(1.-exp(-contact*u.x*2.));
        // The water receives the vessel's acceleration, the thinking swirl and a
        // short central lift; the solver supplies pressure and the free surface.
        let whirl=cross(vec3f(0.,1.,0.),p)*2.8;
        let lift=exp(-dot(p.xz,p.xz)*12.)*f.play.z*9.;
        v+=u.x*(vec3f(f.play.xy,0.)+whirl*u.w+vec3f(0.,lift,0.));
        if(f.play.w>.001){
          for(var i=0;i<${IMPACTS};i++){
            let delta=p-impacts[i].xyz;
            // A readable, bounded transfer of drop momentum. The small downward
            // crater displaces fluid radially; pressure produces the wavefront.
            let profile=exp(-dot(delta,delta)*125.);
            v+=u.x*impacts[i].w*profile*vec3f(delta.x*55.,-24.,delta.z*55.);
          }
        }
        v*=min(1.,max(2.2,length(old))/max(length(v),.00001));
        velocities[id.x]=vec4f(v,0.);
      }` }) } });
    const group = (side: 'A' | 'B'): GPUBindGroup => device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.uniform } },
      { binding: 1, resource: { buffer: liquid.buf[`pos${side}`] } },
      { binding: 2, resource: { buffer: liquid.buf[`vel${side}`] } },
      { binding: 3, resource: { buffer: impacts } },
    ] });
    this.groups = [group('A'), group('B')];
  }

  step(dt: number, f: WaterForces): void {
    if (dt <= 0) return;
    this.device.queue.writeBuffer(this.uniform, 0, new Float32Array([
      dt, Math.max(-6, Math.min(6, f.spin)), this.liquid.n, f.vortex, f.ax, f.ay, f.celebration, f.weather,
    ]));
    const encoder = this.device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.groups[this.liquid.parity]);
    pass.dispatchWorkgroups(Math.ceil(this.liquid.n / 256));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}
