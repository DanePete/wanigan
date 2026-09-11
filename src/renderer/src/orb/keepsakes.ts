/** Context pockets and compaction keepsakes. Small colliding bodies carried by
 * the solved gas/water fields. These are visual summaries, not stored memories. */
export class Keepsakes {
  readonly particles:GPUBuffer;
  private readonly uniform:GPUBuffer;
  private readonly pipeline:GPUComputePipeline;
  private readonly group:GPUBindGroup;
  private scope='';
  constructor(private readonly device:GPUDevice,water:GPUTexture,gas:GPUTexture){
    this.particles=device.createBuffer({label:'Context pockets and keepsakes',size:30*32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
    this.uniform=device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.pipeline=device.createComputePipeline({label:'Context pocket collisions',layout:'auto',compute:{entryPoint:'main',module:device.createShaderModule({code:`
      struct Body { p:vec4f, v:vec4f }
      @group(0) @binding(0) var<uniform> u:array<vec4f,2>;
      @group(0) @binding(1) var<storage,read_write> bodies:array<Body>;
      @group(0) @binding(2) var water:texture_3d<f32>;
      @group(0) @binding(3) var gas:texture_3d<f32>;
      @group(0) @binding(4) var s:sampler;
      @compute @workgroup_size(1) fn main(){
        let dt=u[0].x;let pressure=u[0].y;let gather=u[0].z;
        var next:array<Body,30>;
        for(var i=0u;i<30u;i++){
          var b=bodies[i];let pearl=i>=24u;let number=f32(i);
          let enabled=select(pressure>.015||gather>.01,number-24.<u[0].w,pearl);
          let radius=select((.065+pressure*.065)*max(pressure,gather)*(1.-gather*.68),.078,pearl)*select(0.,1.,enabled);
          if(b.p.w<.001&&enabled){
            let angle=number*2.39996;let spread=select(.38,.09,pearl);
            b.p=vec4f(cos(angle)*spread,.22+sin(number*4.3)*.24,sin(angle)*spread-.08,.001);
            b.v=vec4f(sin(angle)*.08,.03,cos(angle)*.08,0.);
          }
          b.p.w=mix(b.p.w,radius,1.-exp(-dt*5.));
          if(b.p.w<.0001){next[i]=b;continue;}
          let uv=clamp((b.p.xyz+1.)*.5,vec3f(0.),vec3f(1.));
          let liquid=textureSampleLevel(water,s,uv,0.);let flow=textureSampleLevel(gas,s,uv,0.).xyz*2.;
          let wet=smoothstep(.15,.7,liquid.x)*u[1].w;
          var force=mix(flow,liquid.yzw,wet)*1.8-b.v.xyz*select(1.1,2.2,wet>.3);
          force+=vec3f(u[1].xy,0.);
          if(pearl){force.y-=2.2*(1.-u[1].z);force.y+=wet*1.5;}
          else{
            // Loose packing in the air; compaction draws the same pockets into
            // one small bundle. No fresh noise substitutes for their motion.
            let center=vec3f(0.,.30,-.13);
            force+=(center-b.p.xyz)*(.22+gather*5.);
            force+=cross(vec3f(0.,gather*2.,0.),b.p.xyz-center);
            force.y+=wet*.9;
          }
          for(var j=0u;j<30u;j++){
            if(j==i||bodies[j].p.w<.001){continue;}
            let d=b.p.xyz-bodies[j].p.xyz;let lengthD=max(.001,length(d));
            let overlap=b.p.w+bodies[j].p.w-lengthD;
            if(overlap>0.){force+=d/lengthD*overlap*24.;}
          }
          b.v=vec4f(b.v.xyz+force*dt,0.);b.v=vec4f(b.v.xyz*min(1.,1.4/max(.001,length(b.v.xyz))),0.);
          b.p=vec4f(b.p.xyz+b.v.xyz*dt,b.p.w);
          let limit=.94-b.p.w;let distance=length(b.p.xyz);
          if(distance>limit){let n=b.p.xyz/distance;b.p=vec4f(n*limit,b.p.w);b.v=vec4f(b.v.xyz-n*max(0.,dot(b.v.xyz,n))*1.35,0.);}
          next[i]=b;
        }
        for(var i=0u;i<30u;i++){bodies[i]=next[i];}
      }`})}});
    this.group=device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.uniform}},{binding:1,resource:{buffer:this.particles}},
      {binding:2,resource:water.createView()},{binding:3,resource:gas.createView()},
      {binding:4,resource:device.createSampler({minFilter:'linear',magFilter:'linear'})}]});
  }
  step(encoder:GPUCommandEncoder,dt:number,pressure:number,gather:number,count:number,scope:string,ax:number,ay:number,float:number,wet:boolean){
    if(scope!==this.scope){this.scope=scope;this.device.queue.writeBuffer(this.particles,0,new Float32Array(30*8));}
    if(dt<=0)return;
    this.device.queue.writeBuffer(this.uniform,0,new Float32Array([dt,pressure,gather,count,ax,ay,float,wet?1:0]));
    const pass=encoder.beginComputePass();pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.group);pass.dispatchWorkgroups(1);pass.end();
  }
  destroy(){this.particles.destroy();this.uniform.destroy();}
}
