/** Dye concentration transported by the actual reconstructed liquid velocity.
 * Dye is supplied in bounded blooms, then diffuses/fades; it is not mass of water. */
import type { Sim } from './vendor/sim.js';
const SIZE=64;
export class Ink {
  readonly texture:GPUTexture;
  private readonly next:GPUTexture;
  private readonly uniform:GPUBuffer;
  private readonly pipeline:GPUComputePipeline;
  private readonly group:GPUBindGroup;
  private age=100;
  private color=0;
  private readonly forceUniform:GPUBuffer;
  private readonly forcePipeline:GPUComputePipeline;
  private forceGroups:GPUBindGroup[]=[];
  constructor(private readonly device:GPUDevice,water:GPUTexture){
    const make=()=>device.createTexture({size:[SIZE,SIZE,SIZE],dimension:'3d',format:'rgba16float',
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST});
    this.texture=make();this.next=make();this.uniform=device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.pipeline=device.createComputePipeline({label:'Waterborne ink advection and diffusion',layout:'auto',compute:{entryPoint:'main',module:device.createShaderModule({code:`
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
        value=mix(value,nearby,min(.15,u[0].x*.6))*exp(-u[0].x*.075);
        let center=vec3f(u[1].x,-.15,.18);let delta=(p-center)*vec3f(1.,1.7,1.);
        let source=exp(-dot(delta,delta)*60.)*u[0].y*u[0].x*7.;
        let color=select(vec3f(.16,.6,1.),select(vec3f(1.,.12,.5),vec3f(.08,1.,.48),u[0].z>1.5),u[0].z>.5);
        value+=vec4f(color,1.)*source;
        textureStore(next,id,min(value,vec4f(3.))*smoothstep(.12,.4,flow.x));
      }`})}});
    this.group=device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.uniform}},{binding:1,resource:this.texture.createView()},
      {binding:2,resource:this.next.createView()},{binding:3,resource:water.createView()},
      {binding:4,resource:device.createSampler({minFilter:'linear',magFilter:'linear'})}]});
    this.forceUniform=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.forcePipeline=device.createComputePipeline({label:'Ink buoyancy feeds the water pressure solve',layout:'auto',compute:{entryPoint:'main',module:device.createShaderModule({code:`
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
      }`})}});
  }
  bind(liquid:Sim){
    this.forceGroups=['A','B'].map(side=>this.device.createBindGroup({layout:this.forcePipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.forceUniform}},{binding:1,resource:{buffer:liquid.buf['pos'+side]}},
      {binding:2,resource:{buffer:liquid.buf['vel'+side]}},{binding:3,resource:this.texture.createView()},
      {binding:4,resource:this.device.createSampler({minFilter:'linear',magFilter:'linear'})}]}));
  }
  push(liquid:Sim,dt:number){
    this.device.queue.writeBuffer(this.forceUniform,0,new Float32Array([dt,0,0,0]));
    const encoder=this.device.createCommandEncoder(),pass=encoder.beginComputePass();
    pass.setPipeline(this.forcePipeline);pass.setBindGroup(0,this.forceGroups[liquid.parity]);pass.dispatchWorkgroups(Math.ceil(liquid.n/256));pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
  bloom(completed=false){this.age=0;this.color=completed?2:(this.color+1)%2;}
  step(encoder:GPUCommandEncoder,dt:number){
    const source=Math.max(0,1-this.age/1.8);
    this.device.queue.writeBuffer(this.uniform,0,new Float32Array([dt,source,this.color,0,this.color===0?-.27:.27,0,0,0]));this.age+=dt;
    const pass=encoder.beginComputePass();pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.group);pass.dispatchWorkgroups(SIZE/4,SIZE/4,SIZE/4);pass.end();
    encoder.copyTextureToTexture({texture:this.next},{texture:this.texture},[SIZE,SIZE,SIZE]);
  }
}
