import type { Sim } from './vendor/sim.js';

/** Ink blooms: dye concentration carried by the reconstructed water velocity.
 * A bloom supplies dye for 1.8 s at one side; it sinks a little, which makes
 * the mushroom front, while the water folds it sideways, and the denser dye
 * pushes the water down in turn. A port of Wanigan 1's `ink.ts`. There ink was
 * a material that kept its colour; here a bloom is something he does, so the
 * dye holds for about 10 s and then clears within half a minute. */
const SIZE = 64;
/** Seconds after a bloom until the dye is gone and the passes stop. */
export const INK_SECONDS = 30;

export type InkColour = 'cyan' | 'magenta' | 'green';
const COLOUR: Record<InkColour, number> = { cyan: 0, magenta: 1, green: 2 };

export class Ink {
  /** Pigment premultiplied in rgb, concentration in a. */
  readonly texture: GPUTexture;
  private readonly device: GPUDevice;
  private readonly next: GPUTexture;
  private readonly uniform: GPUBuffer;
  private readonly pipeline: GPUComputePipeline;
  private readonly group: GPUBindGroup;
  private readonly forceUniform: GPUBuffer;
  private readonly forcePipeline: GPUComputePipeline;
  private readonly forceGroups: [GPUBindGroup, GPUBindGroup];
  private age = INK_SECONDS;
  private colour = 0;

  constructor(device: GPUDevice, water: GPUTexture, liquid: Sim) {
    this.device = device;
    const make = (): GPUTexture => device.createTexture({ size: [SIZE, SIZE, SIZE], dimension: '3d', format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
    this.texture = make();
    this.next = make();
    this.uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    this.pipeline = device.createComputePipeline({ label: 'Waterborne ink advection and diffusion', layout: 'auto', compute: { entryPoint: 'main', module: device.createShaderModule({ code: `
      @group(0) @binding(0) var<uniform> u:array<vec4f,2>;
      @group(0) @binding(1) var dye:texture_3d<f32>;
      @group(0) @binding(2) var next:texture_storage_3d<rgba16float,write>;
      @group(0) @binding(3) var water:texture_3d<f32>;
      @group(0) @binding(4) var s:sampler;
      @compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
        let uv=(vec3f(id)+.5)/${SIZE}.;let p=uv*2.-1.;let flow=textureSampleLevel(water,s,uv,0.);
        // A small sinking speed produces the mushroom front while the water
        // carries every fold sideways. Neighbor diffusion uses a stable blend.
        let previous=clamp(uv-(flow.yzw+vec3f(0.,-.075,0.))*u[0].x*.5,vec3f(0.),vec3f(1.));
        var value=textureSampleLevel(dye,s,previous,0.);
        let h=1./${SIZE}.;
        let nearby=(textureSampleLevel(dye,s,previous+vec3f(h,0,0),0.)+textureSampleLevel(dye,s,previous-vec3f(h,0,0),0.)+
          textureSampleLevel(dye,s,previous+vec3f(0,h,0),0.)+textureSampleLevel(dye,s,previous-vec3f(0,h,0),0.)+
          textureSampleLevel(dye,s,previous+vec3f(0,0,h),0.)+textureSampleLevel(dye,s,previous-vec3f(0,0,h),0.))/6.;
        value=mix(value,nearby,min(.15,u[0].x*.6))*exp(-u[0].x*u[0].w);
        let center=vec3f(u[1].x,-.15,.18);let delta=(p-center)*vec3f(1.,1.7,1.);
        let source=exp(-dot(delta,delta)*60.)*u[0].y*u[0].x*7.;
        let color=select(vec3f(.16,.6,1.),select(vec3f(1.,.12,.5),vec3f(.08,1.,.48),u[0].z>1.5),u[0].z>.5);
        value+=vec4f(color,1.)*source;
        textureStore(next,id,min(value,vec4f(3.))*smoothstep(.12,.4,flow.x));
      }` }) } });
    this.group = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: this.texture.createView() },
      { binding: 2, resource: this.next.createView() }, { binding: 3, resource: water.createView() },
      { binding: 4, resource: sampler },
    ] });
    this.forceUniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.forcePipeline = device.createComputePipeline({ label: 'Ink buoyancy feeds the water', layout: 'auto', compute: { entryPoint: 'main', module: device.createShaderModule({ code: `
      @group(0) @binding(0) var<uniform> u:vec4f;
      @group(0) @binding(1) var<storage,read> p:array<vec4f>;
      @group(0) @binding(2) var<storage,read_write> v:array<vec4f>;
      @group(0) @binding(3) var ink:texture_3d<f32>;
      @group(0) @binding(4) var s:sampler;
      @compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){
        if(id.x>=arrayLength(&p)){return;}
        let dye=textureSampleLevel(ink,s,(p[id.x].xyz-vec3f(.2))*.5,0.).a;
        // A bounded Boussinesq approximation: denser dye sinks, pressure pushes
        // the surrounding water aside, and that flow folds the transported dye.
        v[id.x]=vec4f(v[id.x].xyz+vec3f(0.,-min(dye,2.)*u.x*.9,0.),0.);
      }` }) } });
    const force = (side: 'A' | 'B'): GPUBindGroup => device.createBindGroup({ layout: this.forcePipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.forceUniform } }, { binding: 1, resource: { buffer: liquid.buf[`pos${side}`] } },
      { binding: 2, resource: { buffer: liquid.buf[`vel${side}`] } }, { binding: 3, resource: this.texture.createView() },
      { binding: 4, resource: sampler },
    ] });
    this.forceGroups = [force('A'), force('B')];
  }

  /** Whether any dye can still be in the water. */
  get active(): boolean { return this.age < INK_SECONDS; }

  /** Drop colour in. Play alternates cyan and magenta from either side; a
   * completed piece of work blooms green. */
  bloom(colour?: InkColour): void {
    this.age = 0;
    this.colour = colour ? COLOUR[colour] : (this.colour + 1) % 2;
  }

  /** The dye's weight on the water: run before the water steps. */
  push(liquid: Sim, dt: number): void {
    this.device.queue.writeBuffer(this.forceUniform, 0, new Float32Array([dt, 0, 0, 0]));
    const encoder = this.device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(this.forcePipeline);
    pass.setBindGroup(0, this.forceGroups[liquid.parity]);
    pass.dispatchWorkgroups(Math.ceil(liquid.n / 256));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  step(encoder: GPUCommandEncoder, dt: number): void {
    const source = Math.max(0, 1 - this.age / 1.8);
    // Wanigan 1's slow fade for the first 10 s, then a faster one so the water clears.
    const fade = 0.075 + Math.max(0, Math.min(1, (this.age - 10) / 6)) * 0.5;
    this.device.queue.writeBuffer(this.uniform, 0, new Float32Array([dt, source, this.colour, fade, this.colour === 0 ? -0.27 : 0.27, 0, 0, 0]));
    this.age += dt;
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.dispatchWorkgroups(SIZE / 4, SIZE / 4, SIZE / 4);
    pass.end();
    encoder.copyTextureToTexture({ texture: this.next }, { texture: this.texture }, [SIZE, SIZE, SIZE]);
  }
}
