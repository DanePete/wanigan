/** A small HDR camera. Bloom comes from the rendered radiance of reflected
 * lights; it is not a separate animated glow. */
const VERTEX = `
struct Vertex { @builtin(position) position:vec4f, @location(0) uv:vec2f }
@vertex fn vs(@builtin(vertex_index) i:u32)->Vertex {
 let p=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));
 var result:Vertex;result.position=vec4f(p[i],0.,1.);result.uv=p[i]*vec2f(.5,-.5)+.5;return result;
}
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var smoothSampler:sampler;
`;

const blur = (horizontal: boolean): string => VERTEX + `
@fragment fn fs(input:Vertex)->@location(0) vec4f {
  let delta=vec2f(${horizontal ? '1.,0.' : '0.,1.'})/vec2f(textureDimensions(source));
  let weights=array<f32,5>(.204164,.180174,.123832,.066282,.027631);
  var color=textureSampleLevel(source,smoothSampler,input.uv,0.).rgb*weights[0];
  for(var i=1;i<5;i++){
    let offset=delta*f32(i);
    color+=(textureSampleLevel(source,smoothSampler,input.uv-offset,0.).rgb+textureSampleLevel(source,smoothSampler,input.uv+offset,0.).rgb)*weights[i];
  }
  return vec4f(color,1.);
}`;

// Area-filter before downsampling: sparse taps into the full-size scene would
// turn tiny bright reflections into a visible grid of copies.
const EXTRACT = VERTEX + `
@fragment fn fs(input:Vertex)->@location(0) vec4f {
  let texel=1./vec2f(textureDimensions(source));var sum=vec3f(0.);
  for(var y=0;y<4;y++){for(var x=0;x<4;x++){
    let color=textureSampleLevel(source,smoothSampler,input.uv+(vec2f(f32(x),f32(y))-1.5)*texel,0.).rgb;
    let peak=max(color.r,max(color.g,color.b));sum+=color*max(0.,peak-1.)/max(peak,.0001);
  }}
  return vec4f(sum/16.,1.);
}`;

const COMPOSITE = VERTEX + `
@group(0) @binding(2) var bloom:texture_2d<f32>;
@fragment fn fs(input:Vertex)->@location(0) vec4f {
  let scene=textureSampleLevel(source,smoothSampler,input.uv,0.);
  let glow=textureSampleLevel(bloom,smoothSampler,input.uv,0.).rgb*.10;
  let coverage=clamp(scene.a+max(glow.r,max(glow.g,glow.b))*.18,0.,1.);
  let color=(scene.rgb+glow)/max(coverage,.0001);
  let mapped=(color*(2.51*color+.03))/(color*(2.43*color+.59)+.14);
  return vec4f(pow(clamp(mapped,vec3f(0.),vec3f(1.)),vec3f(1./2.2))*coverage,coverage);
}`;

type Pass = { pipeline: GPURenderPipeline; group: GPUBindGroup; target: GPUTexture | null };

export class Lens {
  private width = 0;
  private scene: GPUTexture | null = null;
  private textures: GPUTexture[] = [];
  private passes: Pass[] = [];
  private readonly sampler: GPUSampler;
  private readonly extract: GPURenderPipeline;
  private readonly blurX: GPURenderPipeline;
  private readonly blurY: GPURenderPipeline;
  private readonly composite: GPURenderPipeline;
  private readonly device: GPUDevice;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    const pipeline = (code: string, label: string, target: GPUTextureFormat): GPURenderPipeline => {
      const module = device.createShaderModule({ label: 'Orb camera response', code });
      return device.createRenderPipeline({
        label, layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: target }] },
        primitive: { topology: 'triangle-list' },
      });
    };
    this.extract = pipeline(EXTRACT, 'Orb bright-light diffusion', 'rgba16float');
    this.blurX = pipeline(blur(true), 'Orb bright-light diffusion', 'rgba16float');
    this.blurY = pipeline(blur(false), 'Orb bright-light diffusion', 'rgba16float');
    this.composite = pipeline(COMPOSITE, 'Orb HDR tone mapping', format);
  }

  /** The HDR texture the optics draw into, reallocated only when the size changes. */
  target(width: number): GPUTexture {
    if (this.scene && width === this.width) return this.scene;
    this.width = width;
    for (const texture of this.textures) texture.destroy();
    const make = (size: number): GPUTexture => this.device.createTexture({
      size: [size, size], format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const quarter = Math.ceil(width / 4);
    const scene = make(width), bright = make(quarter), wide = make(quarter), bloom = make(quarter);
    this.scene = scene;
    this.textures = [scene, bright, wide, bloom];
    const bind = (pipeline: GPURenderPipeline, source: GPUTexture, extra?: GPUTexture): GPUBindGroup => {
      const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: source.createView() }, { binding: 1, resource: this.sampler }];
      if (extra) entries.push({ binding: 2, resource: extra.createView() });
      return this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
    };
    this.passes = [
      { pipeline: this.extract, group: bind(this.extract, scene), target: bright },
      { pipeline: this.blurX, group: bind(this.blurX, bright), target: wide },
      { pipeline: this.blurY, group: bind(this.blurY, wide), target: bloom },
      { pipeline: this.composite, group: bind(this.composite, scene, bloom), target: null },
    ];
    return scene;
  }

  render(encoder: GPUCommandEncoder, output: GPUTextureView): void {
    for (const { pipeline, group, target } of this.passes) {
      const pass = encoder.beginRenderPass({ colorAttachments: [{
        view: target ? target.createView() : output,
        clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store',
      }] });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }
  }
}
