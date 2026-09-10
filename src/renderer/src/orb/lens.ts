/** Small HDR camera pass. Bloom comes from the rendered radiance of flame and
 * reflected lights; it is not a separate animated glow or prerecorded effect. */
const VERTEX=`
struct Vertex { @builtin(position) position:vec4f, @location(0) uv:vec2f }
@vertex fn vs(@builtin(vertex_index) i:u32)->Vertex {
 let p=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));
 var result:Vertex;result.position=vec4f(p[i],0.,1.);result.uv=p[i]*vec2f(.5,-.5)+.5;return result;
}
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var smoothSampler:sampler;
`;
export class Lens {
  scene!:GPUTexture;
  private width=0;
  private textures:GPUTexture[]=[];
  private readonly pipelines:GPURenderPipeline[];
  private groups:GPUBindGroup[]=[];
  private readonly sampler:GPUSampler;
  constructor(private readonly device:GPUDevice,format:GPUTextureFormat){
    this.sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
    const blur=(horizontal:boolean)=>VERTEX+`
      fn value(uv:vec2f)->vec3f {
        let color=textureSampleLevel(source,smoothSampler,uv,0.).rgb;
        return color;
      }
      @fragment fn fs(input:Vertex)->@location(0) vec4f {
        let delta=vec2f(${horizontal?'1.,0.':'0.,1.'})/vec2f(textureDimensions(source));
        let weights=array<f32,5>(.204164,.180174,.123832,.066282,.027631);
        var color=value(input.uv)*weights[0];
        for(var i=1;i<5;i++){let offset=delta*f32(i);color+=(value(input.uv-offset)+value(input.uv+offset))*weights[i];}
        return vec4f(color,1.);
      }`;
    // Area-filter before downsampling. Sparse taps directly into the full-size
    // scene would turn tiny bright reflections into a visible grid of copies.
    const extract=VERTEX+`
      @fragment fn fs(input:Vertex)->@location(0) vec4f {
        let texel=1./vec2f(textureDimensions(source));var sum=vec3f(0.);
        for(var y=0;y<4;y++){for(var x=0;x<4;x++){
          let color=textureSampleLevel(source,smoothSampler,input.uv+(vec2f(f32(x),f32(y))-1.5)*texel,0.).rgb;
          let peak=max(color.r,max(color.g,color.b));sum+=color*max(0.,peak-1.)/max(peak,.0001);
        }}
        return vec4f(sum/16.,1.);
      }`;
    const composite=VERTEX+`
      @group(0) @binding(2) var bloom:texture_2d<f32>;
      @fragment fn fs(input:Vertex)->@location(0) vec4f {
        let scene=textureSampleLevel(source,smoothSampler,input.uv,0.);
        let glow=textureSampleLevel(bloom,smoothSampler,input.uv,0.).rgb*.10;
        let coverage=clamp(scene.a+max(glow.r,max(glow.g,glow.b))*.18,0.,1.);
        let color=(scene.rgb+glow)/max(coverage,.0001);
        let mapped=(color*(2.51*color+.03))/(color*(2.43*color+.59)+.14);
        return vec4f(pow(clamp(mapped,vec3f(0.),vec3f(1.)),vec3f(1./2.2))*coverage,coverage);
      }`;
    this.pipelines=[extract,blur(true),blur(false),composite].map((code,index)=>{
      const module=device.createShaderModule({label:'Orb camera response',code});
      return device.createRenderPipeline({label:index===3?'Orb HDR tone mapping':'Orb bright-light diffusion',layout:'auto',
        vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format:index===3?format:'rgba16float'}]},primitive:{topology:'triangle-list'}});
    });
  }
  resize(width:number){
    if(width===this.width)return;this.width=width;
    for(const texture of this.textures)texture.destroy();
    const make=(size:number)=>this.device.createTexture({size:[size,size],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
    this.scene=make(width);this.textures=[this.scene,...[1,2,3].map(()=>make(Math.ceil(width/4)))];
    this.groups=this.pipelines.map((pipeline,index)=>{
      const entries:GPUBindGroupEntry[]=[{binding:0,resource:this.textures[index===3?0:index].createView()},{binding:1,resource:this.sampler}];
      if(index===3)entries.push({binding:2,resource:this.textures[3].createView()});
      return this.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries});
    });
  }
  render(encoder:GPUCommandEncoder,output:GPUTextureView){
    for(let i=0;i<4;i++){
      const pass=encoder.beginRenderPass({colorAttachments:[{view:i===3?output:this.textures[i+1].createView(),
        clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});
      pass.setPipeline(this.pipelines[i]);pass.setBindGroup(0,this.groups[i]);pass.draw(3);pass.end();
    }
  }
}
