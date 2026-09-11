import type { Sim } from './vendor/sim.js';
/** Render the final centers of rigid particles from the shared PBF solver.
 * The same constraints exchange displacement between the pearls and water. */
export class Pearls {
  readonly positions:GPUBuffer;
  private readonly pipeline:GPUComputePipeline;
  private groups:GPUBindGroup[]=[];
  constructor(private readonly device:GPUDevice){
    this.positions=device.createBuffer({size:3*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    this.pipeline=device.createComputePipeline({label:'Rigid pearl centers from fluid constraints',layout:'auto',compute:{entryPoint:'main',module:device.createShaderModule({code:`
      @group(0) @binding(0) var<storage,read> particles:array<vec4f>;
      @group(0) @binding(1) var<storage,read> phases:array<vec4u>;
      @group(0) @binding(2) var<storage,read_write> spheres:array<vec4f>;
      @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
        var center=vec3f(0.);var count=0.;
        for(var i=0u;i<arrayLength(&particles);i++){
          if(phases[i].x==id.x+1u){center+=particles[i].xyz;count+=1.;}
        }
        if(count<1.){spheres[id.x]=vec4f(0.);return;}
        center=center/count-vec3f(1.2);
        // Particle confinement can slightly compress a rigid cluster at the
        // wall. Keep the smooth visible envelope inside that same vessel.
        center*=min(1.,.81/max(length(center),.0001));
        spheres[id.x]=vec4f(center,.15);
      }`})}});
  }
  bind(liquid:Sim){
    this.groups=['A','B'].map(side=>this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:liquid.buf['pos'+side]}},{binding:1,resource:{buffer:liquid.buf['body'+side]}},
      {binding:2,resource:{buffer:this.positions}}]}));
  }
  step(encoder:GPUCommandEncoder,parity:number){
    const pass=encoder.beginComputePass();pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.groups[parity]);pass.dispatchWorkgroups(3);pass.end();
  }
}
