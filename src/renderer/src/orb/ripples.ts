import { IMPACTS } from './weather';

/** Sub-grid water detail for the rainstorm: a damped 2D wave equation driven by
 * the same drop impacts as the bulk fluid. Heights deform the reconstructed
 * free surface. Four bounded substeps satisfy the wave CFL limit; no animated
 * ring sprites. A port of Wanigan 1's `ripples.ts`. */
const SIZE = 96;

export class Ripples {
  /** Surface height in x, its velocity in y. */
  readonly texture: GPUTexture;
  private readonly device: GPUDevice;
  private readonly uniform: GPUBuffer;
  private readonly pipeline: GPUComputePipeline;
  private readonly groups: GPUBindGroup[];

  /** `impacts` is the weather's: xyz and strength per drop that met the water. */
  constructor(device: GPUDevice, impacts: GPUBuffer) {
    this.device = device;
    const make = (): GPUTexture => device.createTexture({ size: [SIZE, SIZE], format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
    const a = make(), b = make();
    this.texture = make();
    this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.pipeline = device.createComputePipeline({ label: 'Impact-driven surface waves', layout: 'auto', compute: { entryPoint: 'main', module: device.createShaderModule({ code: `
      @group(0) @binding(0) var<uniform> u:vec4f;
      @group(0) @binding(1) var source:texture_2d<f32>;
      @group(0) @binding(2) var destination:texture_storage_2d<rgba16float,write>;
      @group(0) @binding(3) var<storage,read> impacts:array<vec4f>;
      fn height(c:vec2i)->f32{return textureLoad(source,clamp(c,vec2i(0),vec2i(${SIZE - 1})),0).x;}
      @compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
        let c=vec2i(id.xy);let p=(vec2f(id.xy)+.5)/${SIZE}.*2.-1.;
        let old=textureLoad(source,c,0);let dx=2./${SIZE}.;
        let lap=(height(c+vec2i(1,0))+height(c-vec2i(1,0))+height(c+vec2i(0,1))+height(c-vec2i(0,1))-4.*old.x)/(dx*dx);
        var force=0.;
        if(u.y>.001){for(var i=0;i<${IMPACTS};i++){
          let delta=p-impacts[i].xz;let r2=dot(delta,delta)/.0036;
          // Zero-area pressure footprint: crater and displaced rim.
          force-=impacts[i].w*(1.-r2)*exp(-r2)*22.;
        }}
        let damping=1.8+smoothstep(.72,.95,length(p))*12.;
        let velocity=(old.y+u.x*(lap*.42*.42+force))*exp(-u.x*damping);
        let value=clamp(old.x+u.x*velocity,-.055,.055)*(1.-smoothstep(.88,.99,length(p)));
        textureStore(destination,c,vec4f(value,clamp(velocity,-1.,1.),0.,0.));
      }` }) } });
    // Four substeps per frame, ending back in the published texture.
    const chain: [GPUTexture, GPUTexture][] = [[this.texture, a], [a, b], [b, a], [a, this.texture]];
    this.groups = chain.map(([source, destination]) => device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: source.createView() },
      { binding: 2, resource: destination.createView() }, { binding: 3, resource: { buffer: impacts } },
    ] }));
  }

  step(encoder: GPUCommandEncoder, dt: number, weather: number): void {
    this.device.queue.writeBuffer(this.uniform, 0, new Float32Array([Math.min(dt, 1 / 30) / 4, weather, 0, 0]));
    for (const group of this.groups) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(SIZE / 8, SIZE / 8);
      pass.end();
    }
  }
}
