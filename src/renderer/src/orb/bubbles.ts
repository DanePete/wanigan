/** Buoyant air tracers. Water drags bubbles; their tiny displaced volume does
 * not feed back into PBF. Eye fixation reads these same particles on the GPU. */
const CODE=`
@group(0) @binding(0) var<uniform> u:vec4f;
@group(0) @binding(1) var water:texture_3d<f32>;
@group(0) @binding(2) var s:sampler;
@group(0) @binding(3) var<storage,read_write> positions:array<vec4f>;
@group(0) @binding(4) var<storage,read_write> velocities:array<vec4f>;
fn hash(seed:f32)->f32{return fract(sin(seed*127.1+31.7)*43758.5453);}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let i=id.x;var p=positions[i];var v=velocities[i];
 let fluid=textureSampleLevel(water,s,(p.xyz+1.)*.5,0.);
 let burst=u.z>.5;let escaped=fluid.x<.32||length(p.xyz)>.96;
 if(i>=32u&&!burst&&(p.w==0.||escaped||v.w>4.)){positions[i].w=0.;return;}
 if(p.w==0.||escaped||burst){
  let seed=f32(i)*1.71+floor(u.y)*.013;
  let angle=hash(seed)*6.283185;let radius=sqrt(hash(seed+9.))*.57;
  p=vec4f(radius*cos(angle),-.48-hash(seed+12.)*.29,radius*sin(angle),.008+pow(hash(seed+3.),3.)*.025);
  if(burst){p.w*=1.4;}
  v=vec4f(0.,select(0.,.35,burst),0.,0.);
 }
 v=vec4f(v.xyz+(fluid.yzw-v.xyz)*min(1.,u.x*4.)+vec3f(0.,u.x*.52,0.),v.w+u.x);
 positions[i]=vec4f(p.xyz+v.xyz*u.x,p.w);velocities[i]=v;
}`;
export class Bubbles {
  readonly positions:GPUBuffer;
  readonly gaze:GPUBuffer;
  private readonly uniform:GPUBuffer;
  private readonly pipeline:GPUComputePipeline;
  private readonly group:GPUBindGroup;
  private readonly look:GPUComputePipeline;
  private readonly lookGroup:GPUBindGroup;
  constructor(private readonly device:GPUDevice,water:GPUTexture){
    this.positions=device.createBuffer({size:64*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    this.gaze=device.createBuffer({size:32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(this.gaze,0,new Float32Array([0,0,0,0,0,10,0,0]));
    const velocities=device.createBuffer({size:64*16,usage:GPUBufferUsage.STORAGE});
    this.uniform=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.pipeline=device.createComputePipeline({label:'Buoyant air tracers',layout:'auto',compute:{module:device.createShaderModule({code:CODE}),entryPoint:'main'}});
    this.group=device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.uniform}},{binding:1,resource:water.createView()},
      {binding:2,resource:device.createSampler({minFilter:'linear',magFilter:'linear'})},
      {binding:3,resource:{buffer:this.positions}},{binding:4,resource:{buffer:velocities}}]});
    this.look=device.createComputePipeline({label:'Intentional bubble fixation',layout:'auto',compute:{entryPoint:'main',module:device.createShaderModule({code:`
      @group(0) @binding(0) var<uniform> u:vec4f;
      @group(0) @binding(1) var<storage,read> bubbles:array<vec4f>;
      @group(0) @binding(2) var<storage,read_write> gaze:array<vec4f>;
      @compute @workgroup_size(1) fn main(){
        var state=gaze[1];var fixation=gaze[0];let dt=u.x;
        state.y+=dt;state.z+=dt;
        if(u.w<.5){state.y=10.;state.z=0.;}
        if(state.y>=2.8&&state.z>3.5&&u.w>.5){
          var score=-100.;var selected=-1.;
          for(var i=0u;i<64u;i++){
            let b=bubbles[i];let rank=b.y+b.z*.8+b.w*8.;
            if(b.w>.009&&b.z>-.1&&b.y>-.65&&rank>score){score=rank;selected=f32(i);}
          }
          if(selected>=0.){state.x=selected;state.y=0.;state.z=0.;}
        }
        let b=bubbles[u32(clamp(state.x,0.,63.))];
        if(b.w<=0.||b.y<-.66){state.y=10.;}
        let watching=state.y<2.8&&u.w>.5&&b.w>0.;
        if(watching){
          fixation.x=mix(fixation.x,clamp(b.x*1.5,-.85,.85),1.-exp(-dt*18.));
          fixation.y=mix(fixation.y,clamp((b.y-.12)*1.4,-.75,.75),1.-exp(-dt*18.));
        }
        fixation.z=mix(fixation.z,select(0.,1.,watching),1.-exp(-dt*22.));fixation.w=state.x;
        gaze[0]=fixation;gaze[1]=state;
      }`})}});
    this.lookGroup=device.createBindGroup({layout:this.look.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.uniform}},{binding:1,resource:{buffer:this.positions}},{binding:2,resource:{buffer:this.gaze}}]});
  }
  step(encoder:GPUCommandEncoder,dt:number,time:number,burst=false,interest=0){
    this.device.queue.writeBuffer(this.uniform,0,new Float32Array([dt,time,burst?1:0,interest]));
    for(const [pipeline,group] of [[this.pipeline,this.group],[this.look,this.lookGroup]] as const){
      const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
    }
  }
}
