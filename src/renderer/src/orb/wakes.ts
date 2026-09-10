/** A persistent emissive tracer advected by the reconstructed water velocity.
 * Sources are strokes and disturbed water; light decays after stirring ends. */
const SIZE=48;
export class Wakes {
  readonly texture:GPUTexture;
  private readonly next:GPUTexture;
  private readonly uniform:GPUBuffer;
  private readonly pipeline:GPUComputePipeline;
  private readonly group:GPUBindGroup;
  constructor(private readonly device:GPUDevice,water:GPUTexture){
    const make=()=>device.createTexture({size:[SIZE,SIZE,SIZE],dimension:'3d',format:'rgba16float',
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST});
    this.texture=make();this.next=make();
    this.uniform=device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.pipeline=device.createComputePipeline({label:'Water light transport',layout:'auto',compute:{entryPoint:'main',module:device.createShaderModule({code:`
      struct Params { dt:f32, strength:f32, agitated:f32, pad:f32, stroke:vec4f }
      @group(0) @binding(0) var<uniform> u:Params;
      @group(0) @binding(1) var source:texture_3d<f32>;
      @group(0) @binding(2) var destination:texture_storage_3d<rgba16float,write>;
      @group(0) @binding(3) var water:texture_3d<f32>;
      @group(0) @binding(4) var s:sampler;
      @compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
        let uv=(vec3f(id)+.5)/${SIZE}.;let p=uv*2.-1.;
        let flow=textureSampleLevel(water,s,uv,0.);
        let previous=clamp(uv-flow.yzw*u.dt*.5,vec3f(0.),vec3f(1.));
        let old=textureSampleLevel(source,s,previous,0.).x;
        let delta=p-u.stroke.xyz;
        let stroke=exp(-dot(delta*vec3f(1.,1.,.55),delta*vec3f(1.,1.,.55))*45.)*u.strength;
        let agitation=max(0.,length(flow.yzw)-.28)*.45*u.agitated;
        let light=min(2.,old*exp(-u.dt*1.15)+(stroke*9.+agitation)*u.dt);
        textureStore(destination,id,vec4f(light*smoothstep(.12,.45,flow.x),0.,0.,0.));
      }`})}});
    this.group=device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.uniform}},{binding:1,resource:this.texture.createView()},
      {binding:2,resource:this.next.createView()},{binding:3,resource:water.createView()},
      {binding:4,resource:device.createSampler({minFilter:'linear',magFilter:'linear'})}]});
  }
  step(encoder:GPUCommandEncoder,dt:number,strength:number,x:number,y:number){
    this.device.queue.writeBuffer(this.uniform,0,new Float32Array([dt,strength,strength>0?1:0,0,x,y,.38,0]));
    const pass=encoder.beginComputePass();pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.group);
    pass.dispatchWorkgroups(SIZE/4,SIZE/4,SIZE/4);pass.end();
    encoder.copyTextureToTexture({texture:this.next},{texture:this.texture},[SIZE,SIZE,SIZE]);
  }
}
