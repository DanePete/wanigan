/** Sub-grid water detail: a damped 2D wave equation driven by the same droplet
 * impulses as the bulk fluid. Heights deform the reconstructed free surface.
 * Four bounded substeps satisfy the wave CFL limit; no animated ring sprites. */
const SIZE=96;
export class Ripples {
  readonly texture:GPUTexture;
  private readonly uniform:GPUBuffer;
  private readonly pipeline:GPUComputePipeline;
  private readonly groups:GPUBindGroup[];
  constructor(private readonly device:GPUDevice,impacts:GPUBuffer){
    const make=()=>device.createTexture({size:[SIZE,SIZE],format:'rgba16float',
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC});
    const a=make(),b=make();this.texture=make();
    this.uniform=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.pipeline=device.createComputePipeline({label:'Impact-driven free-surface waves',layout:'auto',compute:{entryPoint:'main',module:device.createShaderModule({code:`
      @group(0) @binding(0) var<uniform> u:vec4f;
      @group(0) @binding(1) var source:texture_2d<f32>;
      @group(0) @binding(2) var destination:texture_storage_2d<rgba16float,write>;
      @group(0) @binding(3) var<storage,read> impacts:array<vec4f>;
      fn height(c:vec2i)->f32{return textureLoad(source,clamp(c,vec2i(0),vec2i(${SIZE-1})),0).x;}
      @compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
        let c=vec2i(id.xy);let p=(vec2f(id.xy)+.5)/${SIZE}.*2.-1.;
        let old=textureLoad(source,c,0);let dx=2./${SIZE}.;
        let lap=(height(c+vec2i(1,0))+height(c-vec2i(1,0))+height(c+vec2i(0,1))+height(c-vec2i(0,1))-4.*old.x)/(dx*dx);
        var force=0.;
        if(u.y>.001){for(var i=0;i<144;i++){
          let delta=p-impacts[i].xz;let r2=dot(delta,delta)/.0036;
          // Zero-area pressure footprint: crater and displaced rim.
          force-=impacts[i].w*(1.-r2)*exp(-r2)*22.;
        }}
        let damping=1.8+smoothstep(.72,.95,length(p))*12.;
        let velocity=(old.y+u.x*(lap*.42*.42+force))*exp(-u.x*damping);
        let value=clamp(old.x+u.x*velocity,-.055,.055)*(1.-smoothstep(.88,.99,length(p)));
        textureStore(destination,c,vec4f(value,clamp(velocity,-1.,1.),0.,0.));
      }`})}});
    this.groups=[[this.texture,a],[a,b],[b,a],[a,this.texture]].map(([source,destination])=>device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.uniform}},{binding:1,resource:source.createView()},
      {binding:2,resource:destination.createView()},{binding:3,resource:{buffer:impacts}}]}));
  }
  step(encoder:GPUCommandEncoder,dt:number,weather:number){
    this.device.queue.writeBuffer(this.uniform,0,new Float32Array([Math.min(dt,1/30)/4,weather,0,0]));
    for(const group of this.groups){const pass=encoder.beginComputePass();pass.setPipeline(this.pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(SIZE/8,SIZE/8);pass.end();}
  }
  async inspect(){
    const buffer=this.device.createBuffer({size:SIZE*SIZE*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    try{
      // RGBA16F: rows padded to 256 bytes. At 96 texels the natural row is 768.
      const encoder=this.device.createCommandEncoder();encoder.copyTextureToBuffer({texture:this.texture},
        {buffer,bytesPerRow:SIZE*8,rowsPerImage:SIZE},[SIZE,SIZE]);this.device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);const values=new Uint16Array(buffer.getMappedRange());
      const half=(x:number)=>{const sign=x&32768?-1:1,exp=(x>>10)&31,mantissa=x&1023;
        return sign*(exp===0?mantissa*2**-24:exp===31?Infinity:(1+mantissa/1024)*2**(exp-15));};
      let min=0,max=0,energy=0,invalid=0;
      for(let i=0;i<SIZE*SIZE*4;i+=4){const h=half(values[i]),v=half(values[i+1]);
        if(!Number.isFinite(h)||!Number.isFinite(v))invalid++;min=Math.min(min,h);max=Math.max(max,h);energy+=h*h+v*v*.01;}
      return {min,max,energy,invalid};
    }finally{buffer.destroy();}
  }
}
